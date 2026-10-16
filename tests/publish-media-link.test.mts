import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { RENDER_DIR } from "../src/lib/paths";
import {
  DEFAULT_MEDIA_TTL_MS,
  MAX_MEDIA_TTL_MS,
  MEDIA_PATH,
  MediaLinkError,
  isMediaLinkError,
  signMediaToken,
  signMediaUrl,
  verifyMediaToken,
} from "../src/lib/publish/media-link";
import { serveSignedMedia } from "../src/lib/publish/media-serve";
import { deriveKey, type EnvLike } from "../src/lib/publish/youtube/secrets";
import { requireIsolation } from "./setup/isolation";

/**
 * The signed public media link: the one URL a third party (Meta) is given.
 *
 * It is the only unauthenticated route in the publish surface, so this file is
 * about what it refuses: a forged signature, an edited payload, an expired link,
 * another episode's id, a path in the id, a missing key, a missing file.
 * Everything runs without a network and without a session -- which is itself the
 * point: Meta has neither.
 */

const KEY = crypto.randomBytes(32).toString("base64");
const ENV: EnvLike = { PUBLIC_BASE_URL: "https://reels.example.test", BOOKREEL_TOKEN_KEY: KEY };
const NOW = 1_800_000_000_000;

const b64u = (v: Buffer | string): string => Buffer.from(v).toString("base64url");

// ------------------------------------------------------------------- the token

test("a token is base64url(JSON {episodeId, exp}) + '.' + base64url(HMAC-SHA256), and verifies to its episode", () => {
  const token = signMediaToken("ep_abc123", 60_000, ENV, NOW);
  const [payload, sig] = token.split(".");
  assert.equal(token.split(".").length, 2);
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), { episodeId: "ep_abc123", exp: NOW + 60_000 });

  // The signature is the HMAC of the payload string under the DERIVED key --
  // not under the raw token key (which seals credentials).
  const expected = crypto.createHmac("sha256", deriveKey("bookreel/publish/media-link/v1", ENV)).update(payload).digest();
  assert.equal(sig, b64u(expected));
  const raw = crypto.createHmac("sha256", Buffer.from(KEY, "base64")).update(payload).digest();
  assert.notEqual(sig, b64u(raw), "the signing key is derived for this purpose, not the credential-sealing key itself");

  assert.deepEqual(verifyMediaToken(token, ENV, NOW + 1000), { episodeId: "ep_abc123", expiresAt: NOW + 60_000 });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "URL-safe, so it needs no escaping in a path");
});

test("signMediaUrl is PUBLIC_BASE_URL + /api/publish/media/<token>, short-lived by default and capped", () => {
  const url = signMediaUrl("ep1", undefined, ENV, NOW);
  assert.ok(url.startsWith(`https://reels.example.test${MEDIA_PATH}/`));
  const token = url.slice(`https://reels.example.test${MEDIA_PATH}/`.length);
  assert.equal(verifyMediaToken(token, ENV, NOW).episodeId, "ep1");
  assert.equal(verifyMediaToken(token, ENV, NOW).expiresAt, NOW + DEFAULT_MEDIA_TTL_MS);
  assert.ok(DEFAULT_MEDIA_TTL_MS <= 30 * 60_000, "a few minutes, not a day");

  // A path prefix and a trailing slash on the base are handled.
  assert.ok(signMediaUrl("ep1", 1000, { ...ENV, PUBLIC_BASE_URL: "https://h.example.test/app/" }, NOW).startsWith("https://h.example.test/app/api/publish/media/"));

  // A ttl is bounded: asking for a year gets an hour, and nonsense gets the default.
  assert.equal(verifyMediaToken(signMediaToken("ep1", 365 * 86_400_000, ENV, NOW), ENV, NOW).expiresAt, NOW + MAX_MEDIA_TTL_MS);
  assert.equal(verifyMediaToken(signMediaToken("ep1", -5, ENV, NOW), ENV, NOW).expiresAt, NOW + DEFAULT_MEDIA_TTL_MS);
  assert.equal(verifyMediaToken(signMediaToken("ep1", Number.NaN, ENV, NOW), ENV, NOW).expiresAt, NOW + DEFAULT_MEDIA_TTL_MS);

  // Nothing to sign with, or nowhere to point: a named error, not a bogus link.
  assert.throws(() => signMediaUrl("ep1", 1000, { BOOKREEL_TOKEN_KEY: KEY }, NOW), (e: unknown) => isMediaLinkError(e) && /PUBLIC_BASE_URL/.test((e as Error).message));
  assert.throws(() => signMediaUrl("ep1", 1000, { PUBLIC_BASE_URL: ENV.PUBLIC_BASE_URL }, NOW), (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === "not_configured");
});

test("an expired token is refused, exactly at its expiry", () => {
  const token = signMediaToken("ep1", 1000, ENV, NOW);
  assert.equal(verifyMediaToken(token, ENV, NOW + 999).episodeId, "ep1");
  for (const at of [NOW + 1000, NOW + 1001, NOW + 86_400_000]) {
    assert.throws(() => verifyMediaToken(token, ENV, at), (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === "expired");
  }
});

test("a forged or edited token is refused: signature, payload, episode swap, truncation", () => {
  const good = signMediaToken("ep_A", 60_000, ENV, NOW);
  const [payload, sig] = good.split(".");
  const refuse = (token: string, code: string, label: string) =>
    assert.throws(
      () => verifyMediaToken(token, ENV, NOW),
      (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === code,
      label,
    );

  // A flipped signature character.
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  refuse(`${payload}.${flipped}`, "bad_signature", "flipped signature");
  // A shortened and an extended signature.
  refuse(`${payload}.${sig.slice(0, -4)}`, "bad_signature", "truncated signature");
  refuse(`${payload}.${sig}AAAA`, "bad_signature", "extended signature");
  // A signature made with a different key.
  const otherKey = { ...ENV, BOOKREEL_TOKEN_KEY: crypto.randomBytes(32).toString("base64") };
  refuse(signMediaToken("ep_A", 60_000, otherKey, NOW), "bad_signature", "signed under another key");
  // The payload edited (a longer life, another episode) with the old signature kept.
  const later = b64u(JSON.stringify({ episodeId: "ep_A", exp: NOW + 10 * 86_400_000 }));
  refuse(`${later}.${sig}`, "bad_signature", "extended expiry");
  const swapped = b64u(JSON.stringify({ episodeId: "ep_B", exp: NOW + 60_000 }));
  refuse(`${swapped}.${sig}`, "bad_signature", "another episode's id under this signature");
  // Another episode's REAL token, with its signature lifted onto this payload and vice versa.
  const other = signMediaToken("ep_B", 60_000, ENV, NOW);
  refuse(`${payload}.${other.split(".")[1]}`, "bad_signature", "signature of a different episode");
  refuse(`${other.split(".")[0]}.${sig}`, "bad_signature", "payload of a different episode");

  // Malformed in every shape: all refused, none crash.
  for (const [token, label] of [
    ["", "empty"],
    ["onlyonepart", "no dot"],
    [`${payload}.${sig}.extra`, "three parts"],
    [`.${sig}`, "empty payload"],
    [`${payload}.`, "empty signature"],
    ["a b.c d", "spaces"],
    ["%2e%2e.%2e%2e", "percent-encoded"],
    ["../../etc/passwd", "a path"],
    ["x".repeat(5000), "huge"],
    [`${payload}+.${sig}`, "outside the base64url alphabet"],
  ] as const) {
    assert.throws(() => verifyMediaToken(token, ENV, NOW), isMediaLinkError, label);
  }
  assert.throws(() => verifyMediaToken(undefined as unknown as string, ENV, NOW), isMediaLinkError, "not even a string");
  assert.throws(() => verifyMediaToken(good, {}, NOW), (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === "not_configured", "no key, no verification");
});

test("an episode id is a plain id: a path, a dot or a separator is never signed, and never accepted even if it somehow was", () => {
  for (const bad of ["../x", "a/b", "a\\b", "a.b", "", "x".repeat(65), "ep id", "ep\u0000", "%2e%2e"]) {
    assert.throws(() => signMediaToken(bad, 1000, ENV, NOW), (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === "bad_episode", JSON.stringify(bad));
  }
  // A token whose signature is GENUINE but whose payload names a traversal id
  // (someone with the key, or a bug): still refused at verify time.
  const payload = b64u(JSON.stringify({ episodeId: "../../etc/passwd", exp: NOW + 60_000 }));
  const sig = crypto.createHmac("sha256", deriveKey("bookreel/publish/media-link/v1", ENV)).update(payload).digest();
  assert.throws(() => verifyMediaToken(`${payload}.${b64u(sig)}`, ENV, NOW), (e: unknown) => isMediaLinkError(e) && (e as MediaLinkError).code === "malformed");
  // And a payload of the wrong types.
  for (const body of [{ episodeId: 5, exp: NOW + 1 }, { episodeId: "ep", exp: "soon" }, { episodeId: "ep" }, []]) {
    const p = b64u(JSON.stringify(body));
    const s = crypto.createHmac("sha256", deriveKey("bookreel/publish/media-link/v1", ENV)).update(p).digest();
    assert.throws(() => verifyMediaToken(`${p}.${b64u(s)}`, ENV, NOW), isMediaLinkError);
  }
});

test("the comparison is constant-time and the key is domain-separated", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/lib/publish/media-link.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  assert.match(code, /crypto\.timingSafeEqual\(/, "a timing-safe compare");
  assert.doesNotMatch(code, /sig(?:B64)?\s*(===|!==)/, "no plain string comparison of signatures");
  assert.match(code, /deriveKey\(KEY_PURPOSE/, "the HMAC key is derived for this purpose");
  // Two purposes give two keys.
  assert.notDeepEqual(deriveKey("a", ENV), deriveKey("b", ENV));
  assert.deepEqual(deriveKey("a", ENV), deriveKey("a", ENV));
  assert.throws(() => deriveKey("a", {}), /BOOKREEL_TOKEN_KEY/);
});

// ------------------------------------------------------------------- serving

interface Seed {
  a: string;
  b: string;
  noRender: string;
  recordedButGone: string;
  cleanup: () => Promise<void>;
}

const A_BYTES = Buffer.alloc(10_000, 0x41);
const B_BYTES = Buffer.alloc(10_000, 0x42);

async function seed(): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders");
  const book = await prisma.book.create({ data: { title: `Media ${randomUUID()}`, rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });
  const make = async (videoPath: string | null, bytes: Buffer | null) => {
    const ep = await prisma.episode.create({
      data: { bookId: book.id, uploadId: upload.id, status: "DONE", theme: "marginalia", title: "T", videoPath },
    });
    if (bytes) {
      await fs.mkdir(RENDER_DIR, { recursive: true });
      await fs.writeFile(path.join(RENDER_DIR, `${ep.id}.mp4`), bytes);
    }
    return ep.id;
  };
  const a = await make("recorded", A_BYTES);
  const b = await make("recorded", B_BYTES);
  const noRender = await make(null, null);
  const recordedButGone = await make("recorded", null);
  // A file that exists on disk but whose episode never recorded a render must not be served either.
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.writeFile(path.join(RENDER_DIR, `${noRender}.mp4`), Buffer.from("orphan"));
  return {
    a,
    b,
    noRender,
    recordedButGone,
    cleanup: async () => {
      for (const id of [a, b, noRender, recordedButGone]) await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
    },
  };
}

const get = (token: string, headers: Record<string, string> = {}, now = Date.now(), env = ENV) =>
  serveSignedMedia(new Request(`https://reels.example.test${MEDIA_PATH}/${token}`, { headers }), token, env, now);

test("a valid link streams exactly that episode's rendered video, with safe headers and no session", async () => {
  const s = await seed();
  try {
    const res = await get(signMediaToken(s.a, 60_000, ENV));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), String(A_BYTES.length));
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.match(res.headers.get("cache-control")!, /no-store/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-disposition"), null, "no title or filename leaks into the response");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), A_BYTES);

    // Range requests, as Meta's fetcher may make them.
    const part = await get(signMediaToken(s.a, 60_000, ENV), { range: "bytes=100-199" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${A_BYTES.length}`);
    assert.equal(Buffer.from(await part.arrayBuffer()).length, 100);
    const tail = await get(signMediaToken(s.a, 60_000, ENV), { range: "bytes=-500" });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), `bytes ${A_BYTES.length - 500}-${A_BYTES.length - 1}/${A_BYTES.length}`);
    await tail.arrayBuffer();
    const open = await get(signMediaToken(s.a, 60_000, ENV), { range: "bytes=9990-" });
    assert.equal(open.status, 206);
    assert.equal(Buffer.from(await open.arrayBuffer()).length, 10);
    const bad = await get(signMediaToken(s.a, 60_000, ENV), { range: "bytes=999999-" });
    assert.equal(bad.status, 416);
  } finally {
    await s.cleanup();
  }
});

test("a token for episode A cannot fetch episode B", async () => {
  const s = await seed();
  try {
    const tokenA = signMediaToken(s.a, 60_000, ENV);
    const tokenB = signMediaToken(s.b, 60_000, ENV);
    assert.deepEqual(Buffer.from(await (await get(tokenA)).arrayBuffer()), A_BYTES);
    assert.deepEqual(Buffer.from(await (await get(tokenB)).arrayBuffer()), B_BYTES, "B's own token gives B's bytes");

    // Taking A's token and pointing it at B: edit the payload, or lift the signature.
    const swapped = b64u(JSON.stringify({ episodeId: s.b, exp: NOW + 60_000 }));
    const forged = await get(`${swapped}.${tokenA.split(".")[1]}`, {}, NOW);
    assert.equal(forged.status, 403);
    const lifted = await get(`${tokenB.split(".")[0]}.${tokenA.split(".")[1]}`);
    assert.equal(lifted.status, 403);
    // Nothing in the response is B's content.
    assert.ok(!Buffer.from(await lifted.arrayBuffer()).includes(B_BYTES.subarray(0, 8)));
  } finally {
    await s.cleanup();
  }
});

test("an expired, forged, malformed or keyless request is one flat 403 that reveals nothing", async () => {
  const s = await seed();
  try {
    const expired = signMediaToken(s.a, 1000, ENV, Date.now() - 60_000);
    const [payload, sig] = signMediaToken(s.a, 60_000, ENV).split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const responses = [
      await get(expired),
      await get(`${payload}.${flipped}`),
      await get("garbage"),
      await get(""),
      await get(signMediaToken(s.a, 60_000, ENV), {}, Date.now(), {}), // this install has no key
    ];
    const bodies = new Set<string>();
    for (const r of responses) {
      assert.equal(r.status, 403);
      assert.match(r.headers.get("cache-control")!, /no-store/);
      bodies.add(await r.text());
    }
    assert.equal(bodies.size, 1, "every refusal reads the same: a probe learns nothing about WHY");
    const body = [...bodies][0];
    assert.doesNotMatch(body, /expired.*signature|signature|key|BOOKREEL|path|renders|\.mp4|episode/i, "no signature detail, key name, path or id");
  } finally {
    await s.cleanup();
  }
});

test("a valid token for an episode with no render, a gone file, or no such episode is a plain 404 that names no path", async () => {
  const s = await seed();
  try {
    const noRecord = await get(signMediaToken(s.noRender, 60_000, ENV));
    assert.equal(noRecord.status, 404, "a file on disk for an episode that never recorded a render is not served");
    const gone = await get(signMediaToken(s.recordedButGone, 60_000, ENV));
    assert.equal(gone.status, 404);
    const missing = await get(signMediaToken("no-such-episode", 60_000, ENV));
    assert.equal(missing.status, 404);
    for (const r of [noRecord, gone, missing]) {
      const text = await r.text();
      assert.doesNotMatch(text, /renders|\.mp4|\\|\//, "no path in the body");
      assert.ok(!text.includes(RENDER_DIR));
    }
  } finally {
    await s.cleanup();
  }
});

test("no path traversal: an id naming another file can neither be signed nor reach a read", async () => {
  const s = await seed();
  try {
    // Even a genuinely signed token for a traversal id is refused before any lookup.
    const payload = b64u(JSON.stringify({ episodeId: `../${path.basename(RENDER_DIR)}/${s.a}`, exp: Date.now() + 60_000 }));
    const sig = crypto.createHmac("sha256", deriveKey("bookreel/publish/media-link/v1", ENV)).update(payload).digest();
    const res = await get(`${payload}.${b64u(sig)}`);
    assert.equal(res.status, 403);
    assert.ok(!(await res.text()).includes("AAAA"));
    // The id is the ONLY thing that names a file, and only ever as RENDER_DIR/<id>.mp4.
    const source = await fs.readFile(fileURLToPath(new URL("../src/lib/publish/media-serve.ts", import.meta.url)), "utf8");
    assert.match(source, /path\.join\(RENDER_DIR, `\$\{episode\.id\}\.mp4`\)/);
    assert.match(source, /path\.dirname\(path\.resolve\(file\)\) !== path\.resolve\(RENDER_DIR\)/, "and the resolved path is confined");
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------------- the route

test("the route is public and GET-only: no session machinery, no other method, the token is its only gate", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/app/api/publish/media/[token]/route.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /currentUser|cookies|session|auth/i, "it cannot ask for a session, so it cannot require one");
  assert.match(code, /export async function GET\(/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    assert.doesNotMatch(code, new RegExp(`export async function ${method}\\b`), `${method} is not served`);
  }
  assert.match(code, /serveSignedMedia\(req, token\)/);

  // And it actually works with no cookie at all, end to end, through the handler.
  const s = await seed();
  const previous = process.env.BOOKREEL_TOKEN_KEY;
  process.env.BOOKREEL_TOKEN_KEY = KEY;
  try {
    const { GET } = await import("../src/app/api/publish/media/[token]/route");
    const token = signMediaToken(s.a, 60_000, process.env);
    const res = await GET(new Request(`https://reels.example.test${MEDIA_PATH}/${token}`), { params: Promise.resolve({ token }) });
    assert.equal(res.status, 200, "valid token, no cookie, no header: served");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), A_BYTES);
    const denied = await GET(new Request(`https://reels.example.test${MEDIA_PATH}/nope`), { params: Promise.resolve({ token: "nope" }) });
    assert.equal(denied.status, 403);
  } finally {
    if (previous === undefined) delete process.env.BOOKREEL_TOKEN_KEY;
    else process.env.BOOKREEL_TOKEN_KEY = previous;
    await s.cleanup();
  }
});

test("nothing outside media-link.ts and the Instagram publisher mints a media link", async () => {
  const offenders: string[] = [];
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && /signMedia(Url|Token)/.test(await fs.readFile(full, "utf8"))) {
        offenders.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  await walk(root);
  assert.deepEqual(offenders.sort(), ["lib/publish/instagram/publisher.ts", "lib/publish/media-link.ts"]);
  const publisher = await fs.readFile(path.join(root, "lib/publish/instagram/publisher.ts"), "utf8");
  assert.match(publisher, /signMediaUrl\(prepared\.episodeId, DEFAULT_MEDIA_TTL_MS/, "a link is minted inside a publish that already passed the owner and identity gates");
  assert.ok(new MediaLinkError("malformed", "x") instanceof Error);
});
