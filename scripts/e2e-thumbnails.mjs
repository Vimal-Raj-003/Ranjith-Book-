#!/usr/bin/env node
// Library-poster delivery harness: the regression test for "I am not able to see
// the thumbnails in our application."
//
// The posters were never missing. They were generated, stored and served
// correctly -- and then never arrived, because the library grid painted each one
// at 164 CSS px while downloading the 1080 px, ~270 KB original, with a
// `max-age=0, must-revalidate` header that made every visit do it all again.
// Measured on 2026-10-04 against a 100-episode library: only 38 of 63 images had
// decoded after twenty seconds; 45 requests, 4.1 MB; roughly 27 MB for the lot.
//
// Nothing in the unit suites could see that. The route test proves the right
// bytes come back; it cannot know whether a browser, issuing six requests at a
// time over HTTP/1.1, gets all of them onto the screen. Only a real browser
// against the real server can, so this drives one.
//
// What it asserts (spec criteria 1-3):
//   1. Every poster in the viewport has decoded within 3 s of the library
//      rendering (`img.complete && img.naturalWidth > 0`). Baseline: 38/63 at 20 s.
//   2. A second visit transfers no image body. A 304 is allowed (it carries no
//      body); anything that arrives with bytes is a failure.
//   3. The whole library -- scrolled end to end so every lazy image loads --
//      costs under 3 MB on the wire. Baseline: ~27 MB per 100 episodes.
//  1b. Criterion 1 again, on a 4 Mbps link with an empty browser cache. Not in
//      the spec, and here because on loopback the UNFIXED route also passes
//      criterion 1 (the first screen of 240 KB posters decodes in ~0.2 s when
//      the pipe is enormous), so 1 alone cannot tell the fix from the bug.
//      Bytes become time on a slower link, and this is the check that does.
//
// And one thing the criteria do not say but the bug report does:
//   D. Every poster the library lists is one the server will actually deliver.
//      A poster the server answers 404 shows the operator an initials tile, and
//      speed cannot help it. Those are counted OUT of 1-3 (so a slow poster is
//      never hidden behind a missing one, and a missing one is never blamed on
//      speed) and classified HERE, because "not able to see the thumbnails" is
//      satisfied by either cause. Each refused poster is one of:
//        ownerless     the episode has no owner and the route refused it anyway.
//                      A CODE defect: the library lists ownerless episodes, so
//                      the poster route must serve them (it once did not).
//        missing-file  nothing at THUMBS_ROOT/<episode>/<key>.jpg. A code or
//                      storage defect.
//        other         refused for a reason none of the above explains.
//      D fails on all three; there is no "warning" class left.
//
//      There used to be a fourth, `foreign-path`: the stored `spec.path` pointed
//      outside this install's thumbs directory -- 50 of the 115 postered
//      episodes, rows written by a `G:\YT-Book\` copy of the app that shared the
//      library -- and it was reported as a data warning whose repair was "re-
//      render them". BOTH halves of that were wrong. All 50 had their complete
//      set of six poster files in the correct local directory; the stored string
//      was the only defect, and its single possible effect was a refusal.
//      `selectThumb` now DERIVES the path from THUMBS_ROOT, the episode id and
//      the validated key, so a foreign row can neither refuse a poster nor
//      redirect one. Nothing needed re-rendering and the class cannot occur.
//
// It runs against the REAL server and the REAL database, so it is read-only by
// construction. The one write is a short-lived Session row (it has to be signed
// in to see the library), which is deleted in a `finally` and then verified
// gone. It never touches an Episode, a Setting, or a poster file.
//
// One side effect is not the script's but the product's: the first time a poster
// is asked for at `?size=grid`, the SERVER derives and caches the 324 px copy
// under `.bookreel/thumbs/<id>/grid/`. That is the same thing the operator's own
// first visit does, it is a pure function of the original, and deleting it is
// harmless (criterion 8). The script reports how many were already warm so a
// cold run and a warm run are never mistaken for each other.
//
// --prefix reproduces the behaviour from before the fix, without reverting a
// commit or disturbing the running server: a small proxy sits between the
// browser and the server, drops `?size=grid` from thumbnail URLs (so the full
// JPEG comes back) and rewrites the response to the old headers
// (`max-age=0, must-revalidate`, no ETag). A test that has never failed proves
// nothing; this is how it is made to.
//
// It refuses to run anywhere it could do that to someone who did not ask for
// it: `NODE_ENV=production` is refused outright, so is a BASE_URL that is not
// loopback, and E2E_USER_EMAIL is REQUIRED -- it used to mint the session for
// whichever account had the most episodes, which is not a choice a script
// should make about somebody's database. `e2e:thumbs` is a published npm
// script, so these are not hypothetical paths.
//
// Run:  E2E_USER_EMAIL=you@example.com npm run e2e:thumbs
//       E2E_USER_EMAIL=you@example.com npm run e2e:thumbs -- --prefix   (expected to FAIL)
// Env:  E2E_USER_EMAIL (required), BASE_URL (default http://localhost:3013;
//       must be loopback), E2E_LINK_MBPS (default 4; 0 skips 1b)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { prisma } from "../src/lib/db.ts";
import { SESSION_COOKIE } from "../src/lib/auth/config.ts";
import { pickPoster } from "../src/lib/thumbnails/choose.ts";
import { gridDir, thumbsDir } from "../src/lib/thumbnails/types.ts";
import { thumbUrl } from "../src/lib/thumbnails/url.ts";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3013").replace(/\/$/, "");
const PREFIX = process.argv.includes("--prefix");

const VIEWPORT = { width: 1600, height: 900 };
const DECODE_BUDGET_MS = 3_000;
const PAYLOAD_BUDGET_BYTES = 3_000_000;
/** How long to keep watching after the budget, only so a failure can say how bad it was. */
const DECODE_WATCH_MS = 20_000;
const SESSION_TTL_MS = 10 * 60_000;
/**
 * The constrained link for the second look at criterion 1. On a quiet loopback
 * the UNFIXED route also gets the first screen decoded in ~0.2 s -- the bytes
 * are the same, the pipe is just enormous -- so a loopback-only run cannot tell
 * the fix from the bug on criterion 1. Bytes become time on a slower link: at
 * 4 Mbps the first screen of full-size posters costs seconds, and of grid-size
 * ones a fraction of one. 0 skips the probe.
 */
const LINK_MBPS = Number(process.env.E2E_LINK_MBPS ?? 4);
const LINK_RTT_MS = 100;
/**
 * A 304 revalidation is headers only, a few hundred bytes. The smallest poster
 * body is far larger, so anything over this crossed the wire WITH a body.
 */
const BODY_THRESHOLD_BYTES = 2_048;

const THUMB_URL = /\/api\/episodes\/[^/]+\/thumbnail\//;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const rel = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

// ---------------------------------------------------------------------------
// The one write: a session row, and making sure it is gone.
// ---------------------------------------------------------------------------

let sessionId = null;
let sessionDeleted = false;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Refuse before anything is read or written.
 *
 * The session row is a real credential in a real database, and `DATABASE_URL`
 * decides which one. Nothing here can tell a development database from a live
 * one, so instead of guessing it insists on the three things that are true of
 * a developer's own machine and of nowhere else: not a production build, a
 * loopback base URL, and an account named on purpose.
 */
function refuseUnlessLocal() {
  const reasons = [];
  if (process.env.NODE_ENV === "production") {
    reasons.push("NODE_ENV=production: this mints a session row, so it does not run against a production build.");
  }
  let host = null;
  try {
    host = new URL(BASE_URL).hostname;
  } catch {
    reasons.push(`BASE_URL is not a URL: ${BASE_URL}`);
  }
  if (host !== null && !LOOPBACK.has(host)) {
    reasons.push(`BASE_URL host "${host}" is not loopback: this only runs against localhost or 127.0.0.1.`);
  }
  if (!process.env.E2E_USER_EMAIL?.trim()) {
    reasons.push(
      "E2E_USER_EMAIL is not set: name the account to sign in as. This will not pick one for you -- " +
        "it creates a session for whoever it names.",
    );
  }
  if (reasons.length) {
    console.error("Refusing to run:");
    for (const r of reasons) console.error(`  - ${r}`);
    process.exit(2);
  }
}

async function pickUser() {
  const wanted = process.env.E2E_USER_EMAIL.trim().toLowerCase();
  const users = await prisma.user.findMany({
    select: { id: true, email: true, _count: { select: { episodes: true } } },
  });
  const found = users.find((u) => u.email.toLowerCase() === wanted);
  if (!found) throw new Error(`No user ${wanted} in this database.`);
  if (found._count.episodes === 0) throw new Error(`${wanted} has no episodes: there is no library to load.`);
  return found;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const row = await prisma.session.create({
    data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    select: { id: true },
  });
  sessionId = row.id;
  return token;
}

/** Idempotent, and it checks its own work: a delete that did not delete is reported, loudly. */
async function removeSession() {
  if (!sessionId || sessionDeleted) return;
  try {
    await prisma.session.deleteMany({ where: { id: sessionId } });
    const left = await prisma.session.count({ where: { id: sessionId } });
    if (left !== 0) throw new Error(`${left} row(s) remain after delete`);
    sessionDeleted = true;
    console.log(`\nsession ${sessionId}: deleted, verified 0 rows remain.`);
  } catch (err) {
    process.exitCode = 1;
    console.error(
      `\n!!! SESSION ROW ${sessionId} WAS NOT DELETED (${err instanceof Error ? err.message : String(err)}). ` +
        `It expires on its own within ${SESSION_TTL_MS / 60_000} minutes; remove it by hand if you want it gone sooner.`,
    );
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    removeSession().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// --prefix: the behaviour from before the fix, reproduced in a proxy.
// ---------------------------------------------------------------------------

/**
 * Forward everything to `target`, except that thumbnail requests are answered
 * the way the route answered before `4a32b4b`: always the full JPEG (the `size`
 * parameter did not exist), `private, max-age=0, must-revalidate`, no ETag.
 * Nothing about the page or the server changes, so what the browser then does
 * with those responses is the real, unfaked behaviour.
 */
function startPrefixProxy(target) {
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://proxy.invalid");
    const thumb = THUMB_URL.test(u.pathname);
    const headers = { ...req.headers, host: t.host };
    if (headers.origin) headers.origin = t.origin;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, t.origin);
    let reqPath = req.url;
    if (thumb) {
      u.searchParams.delete("size");
      reqPath = u.pathname + u.search;
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }
    const up = http.request({ hostname: t.hostname, port: t.port, method: req.method, path: reqPath, headers }, (ur) => {
      const out = { ...ur.headers };
      if (thumb && ur.statusCode === 200) {
        out["cache-control"] = "private, max-age=0, must-revalidate";
        delete out.etag;
      }
      res.writeHead(ur.statusCode ?? 502, out);
      ur.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
  });
  // The dev server's HMR socket. Not needed for the measurement, but without it
  // the page logs a reconnect loop that has nothing to do with posters.
  server.on("upgrade", (req, socket, head) => {
    const up = net.connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === "host" ? t.host : req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "localhost", () => resolve({ server, origin: `http://localhost:${server.address().port}` }));
  });
}

// ---------------------------------------------------------------------------
// Measurement. Network facts come from the browser's own network layer (CDP),
// not from the server's log or from what this script asked for.
// ---------------------------------------------------------------------------

function watchNetwork(cdp) {
  const reqs = new Map();
  const get = (id) => reqs.get(id);
  cdp.on("Network.requestWillBeSent", (e) => {
    if (THUMB_URL.test(e.request.url)) {
      reqs.set(e.requestId, { url: e.request.url, status: 0, fromCache: false, bytes: null, done: false, failed: false, cc: "" });
    }
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.fromCache = Boolean(e.response.fromDiskCache || e.response.fromPrefetchCache);
    for (const [k, v] of Object.entries(e.response.headers ?? {})) if (k.toLowerCase() === "cache-control") r.cc = String(v);
  });
  cdp.on("Network.requestServedFromCache", (e) => {
    const r = get(e.requestId);
    if (r) r.fromCache = true;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = get(e.requestId);
    if (r) Object.assign(r, { done: true, bytes: e.encodedDataLength });
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = get(e.requestId);
    if (r) Object.assign(r, { done: true, failed: true });
  });

  const all = () => [...reqs.values()];
  const ok2xx = (r) => r.status >= 200 && r.status < 300;
  return {
    inflight: () => all().filter((r) => !r.done).length,
    /** Bytes that crossed the wire: headers and body, cache hits excluded. */
    wireBytes: () => all().reduce((n, r) => n + (r.fromCache ? 0 : (r.bytes ?? 0)), 0),
    /** Posters the server answered 404, by the URL the page asked for. */
    notFound: () => [...new Set(all().filter((r) => r.status === 404).map((r) => rel(r.url)))],
    /** Image responses that arrived WITH a body: not a cache hit, not a bodiless 304. */
    bodies: () => all().filter((r) => ok2xx(r) && !r.fromCache && !r.failed && (r.bytes ?? 0) > BODY_THRESHOLD_BYTES),
    summary: () => {
      const rs = all();
      return {
        requests: rs.length,
        fromCache: rs.filter((r) => r.fromCache).length,
        bodies: rs.filter((r) => ok2xx(r) && !r.fromCache && (r.bytes ?? 0) > BODY_THRESHOLD_BYTES).length,
        s304: rs.filter((r) => r.status === 304).length,
        s404: rs.filter((r) => r.status === 404).length,
        failed: rs.filter((r) => r.failed).length,
        unfinished: rs.filter((r) => !r.done).length,
        cacheControl: [...new Set(rs.filter((r) => !r.fromCache && ok2xx(r) && r.cc).map((r) => r.cc))],
      };
    },
  };
}

/**
 * In the page: of the posters we expect, how many are in view (or anywhere, when
 * `onlyVisible` is false), how many have decoded, and how many are a placeholder
 * because the server answered 404 for them.
 *
 * A poster that failed to load is swapped for the initials tile, which has no
 * <img> at all, so counting only the images that remain would let one broken
 * poster shrink the set and "pass". A placeholder is therefore `missing` only if
 * the network layer saw that exact URL answered 404; any other placeholder is
 * neither decoded nor missing, and keeps the poster from ever counting as settled.
 */
const SAMPLE = ({ expected, onlyVisible, notFound }) => {
  const ul = document.querySelector(".library-grid");
  const nf = new Set(notFound);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let total = 0;
  let decoded = 0;
  let missing = 0;
  for (const e of expected) {
    const li = ul?.children[e.index];
    if (!li) continue;
    if (onlyVisible) {
      const r = li.getBoundingClientRect();
      if (!(r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0)) continue;
    }
    total++;
    const img = li.querySelector("img");
    if (img && img.getAttribute("src") === e.src && img.complete && img.naturalWidth > 0) decoded++;
    else if (!img && nf.has(e.src)) missing++;
  }
  return { total, decoded, missing };
};

async function openLibrary(page, origin, expectedCount, beforeClick) {
  await page.goto(`${origin}/`, { waitUntil: "load" });
  // After the app has loaded, so the throttle prices the posters and not the JavaScript.
  await beforeClick?.();
  const tClick = Date.now();
  await page.locator("button.nav-item", { hasText: /^\s*Library\s*$/ }).click();
  await page.waitForFunction(
    (n) => (document.querySelector(".library-grid")?.children.length ?? 0) >= n,
    expectedCount,
    { timeout: 20_000 },
  );
  // "Of the library rendering" is when its cards exist, not when the button was clicked.
  return { tRendered: Date.now(), tClick };
}

const settled = (s) => s.total > 0 && s.decoded + s.missing === s.total;

async function waitVisibleSettled(page, net, expected, tRendered) {
  const series = [];
  for (;;) {
    const s = await page.evaluate(SAMPLE, { expected, onlyVisible: true, notFound: net.notFound() });
    const t = Date.now() - tRendered;
    series.push({ t, ...s });
    if (settled(s)) return { allMs: t, series };
    if (t > DECODE_WATCH_MS) return { allMs: null, series };
    await page.waitForTimeout(40);
  }
}

/** Bring every card into view so every lazy image is asked for, as a scrolling operator would. */
async function scrollWholeLibrary(page, expected) {
  await page.evaluate(async (exp) => {
    const ul = document.querySelector(".library-grid");
    for (const e of exp) {
      ul?.children[e.index]?.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 40));
    }
    ul?.children[0]?.scrollIntoView({ block: "start" });
  }, expected);
}

async function waitAllSettled(page, net, expected, timeoutMs) {
  const t0 = Date.now();
  let last = { total: 0, decoded: 0, missing: 0 };
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(SAMPLE, { expected, onlyVisible: false, notFound: net.notFound() });
    if (settled(last)) break;
    await page.waitForTimeout(100);
  }
  return last;
}

async function settleNetwork(page, net) {
  let quietSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    if (net.inflight() > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) return;
    await page.waitForTimeout(100);
  }
}

/** Every class of refusal means the code (or the storage) is wrong. */
const DEFECT_CLASSES = ["ownerless", "missing-file", "other"];

/**
 * Read-only: WHY did the server refuse each of these? The route serves
 * THUMBS_ROOT/<episode>/<key>.jpg to the episode's owner or, for an ownerless
 * episode, to any signed-in user. The file is checked first because a poster
 * that is not on disk is refused whoever owns the episode; "ownerless"
 * therefore means the owner rule is the only thing left that could have
 * refused it.
 *
 * The stored `spec.path` is deliberately NOT consulted. It contributes nothing
 * to what the route opens (`selectThumb` derives the path), so a row that names
 * another install cannot be the reason a poster was refused -- and reading it
 * here is what produced the old, wrong `foreign-path` diagnosis.
 */
async function classifyMissing(missing) {
  const byId = new Map(missing.map((m) => [m.episodeId, m]));
  const rows = await prisma.episode.findMany({
    where: { id: { in: [...byId.keys()] } },
    select: { id: true, userId: true, createdAt: true },
  });
  return rows
    .map((row) => {
      const m = byId.get(row.id);
      const file = path.join(path.resolve(thumbsDir(row.id)), `${m.key}.jpg`);
      let cls = "other";
      let why = "refused, and the file and the owner both look right";
      if (!fs.existsSync(file)) {
        cls = "missing-file";
        why = `nothing at ${file}`;
      } else if (row.userId == null) {
        cls = "ownerless";
        why = "episode has no owner and the poster route refused it, though the library lists it";
      }
      return { id: row.id, createdAt: row.createdAt.toISOString().slice(0, 16), index: m.index, cls, why };
    })
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------

async function main() {
  refuseUnlessLocal();

  const reach = await fetch(`${BASE_URL}/login`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!reach?.ok) {
    console.error(`Nothing answering at ${BASE_URL}. Start the app (npm run dev) or set BASE_URL.`);
    process.exit(2);
  }

  const user = await pickUser();
  const token = await createSession(user.id);
  console.log(`session ${sessionId} created for ${user.email} (${user._count.episodes} episodes), expires in ${SESSION_TTL_MS / 60_000} min`);

  // The same list the page is about to fetch, so we know which cards must hold a poster.
  const listRes = await fetch(`${BASE_URL}/api/episodes`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  if (!listRes.ok) {
    console.error(
      `GET /api/episodes answered ${listRes.status} for the session just created. If it is 401, the server is ` +
        `reading a different database than ${process.cwd()}/prisma/dev.db (is DATABASE_URL set?).`,
    );
    process.exitCode = 1;
    return;
  }
  const { episodes } = await listRes.json();
  const expected = [];
  episodes.forEach((ep, index) => {
    const poster = pickPoster(ep.thumbnails ?? [], ep.thumbChoice);
    if (poster) expected.push({ index, src: thumbUrl(ep.id, poster, "grid"), episodeId: ep.id, key: poster.key });
  });
  const warm = () => expected.filter((e) => fs.existsSync(path.join(gridDir(e.episodeId), `${e.key}.webp`))).length;
  const warmBefore = warm();
  console.log(
    `library: ${episodes.length} episodes listed, ${expected.length} with a poster. ` +
      `grid cache before this run: ${warmBefore}/${expected.length} warm ` +
      `(${warmBefore === 0 ? "cold" : warmBefore === expected.length ? "fully warm" : "partly warm; the rest derive on first view"}).`,
  );
  if (expected.length === 0) {
    console.error("No episode has a poster, so there is nothing to measure.");
    process.exitCode = 1;
    return;
  }

  let proxy = null;
  let origin = BASE_URL;
  if (PREFIX) {
    proxy = await startPrefixProxy(BASE_URL);
    origin = proxy.origin;
    console.log(`\n*** --prefix: SIMULATING THE PRE-FIX ROUTE via ${origin} -> ${BASE_URL}`);
    console.log("***   ?size=grid dropped (full 1080px JPEG), Cache-Control: private, max-age=0, must-revalidate, no ETag.");
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error(`Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    proxy?.server.close();
    return;
  }

  const verdicts = [];
  let missing = [];
  try {
    // One context for both visits: the HTTP cache belongs to it, so the second
    // visit meets exactly what the first left behind.
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: origin }]);

    // The network listener is attached BEFORE navigation, or the first requests are missed.
    const visit = async (ctx = context, linkMbps = 0) => {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      const net = watchNetwork(cdp);
      const throttle = linkMbps
        ? () =>
            cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: LINK_RTT_MS,
              downloadThroughput: (linkMbps * 1e6) / 8,
              uploadThroughput: (linkMbps * 1e6) / 16,
            })
        : null;
      const { tRendered, tClick } = await openLibrary(page, origin, episodes.length, throttle);
      const first = await waitVisibleSettled(page, net, expected, tRendered);
      return { page, net, tRendered, tClick, first };
    };
    const at = (series, ms) => [...series].reverse().find((s) => s.t <= ms) ?? series[0];

    // ---- Visit 1 ---------------------------------------------------------
    const v1 = await visit();
    const at3 = at(v1.first.series, DECODE_BUDGET_MS);
    const last1 = v1.first.series.at(-1);
    const c1Ok = v1.first.allMs !== null && v1.first.allMs <= DECODE_BUDGET_MS && last1.decoded > 0;
    console.log(
      `\n[1] in-viewport posters: ${last1.total} in view. At ${DECODE_BUDGET_MS} ms: ${at3.decoded} decoded, ${at3.missing} 404. ` +
        (v1.first.allMs !== null
          ? `All settled at ${v1.first.allMs} ms (${last1.decoded} decoded, ${last1.missing} 404).`
          : `At ${DECODE_WATCH_MS / 1000} s: ${last1.decoded} decoded, ${last1.missing} 404, ${last1.total - last1.decoded - last1.missing} still not there.`) +
        ` Cards existed ${v1.tRendered - v1.tClick} ms after the Library click.`,
    );
    verdicts.push({
      n: "1",
      ok: c1Ok,
      line: `every deliverable in-viewport poster decoded within ${DECODE_BUDGET_MS} ms of the library rendering`,
      detail: c1Ok
        ? `${last1.decoded} decoded by ${v1.first.allMs} ms` + (last1.missing ? ` (${last1.missing} more in view are 404, see D)` : "")
        : `${at3.decoded}/${last1.total - last1.missing} at 3 s, ` + (v1.first.allMs !== null ? `all ${last1.decoded} at ${v1.first.allMs} ms` : `${last1.decoded}/${last1.total - last1.missing} at ${DECODE_WATCH_MS / 1000} s`),
    });

    // The whole library, so the payload is the library's and not just its first screen.
    await scrollWholeLibrary(v1.page, expected);
    const all1 = await waitAllSettled(v1.page, v1.net, expected, 30_000);
    await settleNetwork(v1.page, v1.net);
    const wire = v1.net.wireBytes();
    const s1 = v1.net.summary();
    const covered = settled(all1);
    const deliverable = all1.total - all1.missing;
    const c3Ok = covered && wire < PAYLOAD_BUDGET_BYTES;
    console.log(
      `[3] whole library: ${all1.decoded}/${all1.total} posters decoded, ${all1.missing} are 404. ${s1.requests} requests ` +
        `(${s1.bodies} with a body, ${s1.s304} x 304, ${s1.fromCache} from cache, ${s1.s404} x 404, ${s1.failed} failed, ${s1.unfinished} unfinished). ` +
        `${mb(wire)} on the wire = ${mb((wire / Math.max(1, deliverable)) * 100)} per 100 posters. ` +
        `Cache-Control seen: ${s1.cacheControl.join(" | ") || "(none)"}`,
    );
    verdicts.push({
      n: "3",
      ok: c3Ok,
      line: `whole-library payload under ${mb(PAYLOAD_BUDGET_BYTES)}`,
      detail: covered
        ? `${mb(wire)} for ${all1.decoded} posters`
        : `only ${all1.decoded}/${all1.total} settled after 30 s, so ${mb(wire)} UNDERSTATES the real cost`,
    });
    missing = expected.filter((e) => v1.net.notFound().includes(e.src));
    await v1.page.close();

    // ---- Visit 2: a new page, the same context, so the same cache ----------
    const v2 = await visit();
    await scrollWholeLibrary(v2.page, expected);
    const all2 = await waitAllSettled(v2.page, v2.net, expected, 30_000);
    await settleNetwork(v2.page, v2.net);
    const bodies = v2.net.bodies();
    const s2 = v2.net.summary();
    const c2Ok = bodies.length === 0 && settled(all2);
    console.log(
      `[2] second visit: ${all2.decoded}/${all2.total} posters decoded, ${all2.missing} are 404. ${s2.requests} thumbnail requests ` +
        `reached the network layer: ${bodies.length} carried a body, ${s2.fromCache} from cache, ${s2.s304} x 304, ${s2.s404} x 404. ` +
        `${mb(v2.net.wireBytes())} on the wire.`,
    );
    for (const b of bodies.slice(0, 5)) console.log(`      body: ${b.status} ${b.bytes} B  cc="${b.cc}"  ${b.url}`);
    verdicts.push({
      n: "2",
      ok: c2Ok,
      line: "second visit transfers zero image bodies",
      detail: settled(all2)
        ? `${bodies.length} bodies across ${all2.decoded} posters (${s2.requests} requests reached the network layer)`
        : `only ${all2.decoded}/${all2.total} settled, so the count is not meaningful`,
    });
    await v2.page.close();

    // ---- Visit 3: the same first screen, cold cache, on a constrained link ----
    if (LINK_MBPS > 0) {
      const slow = await browser.newContext({ viewport: VIEWPORT });
      await slow.addCookies([{ name: SESSION_COOKIE, value: token, url: origin }]);
      const v3 = await visit(slow, LINK_MBPS);
      const at3s = at(v3.first.series, DECODE_BUDGET_MS);
      const last3 = v3.first.series.at(-1);
      const c3bOk = v3.first.allMs !== null && v3.first.allMs <= DECODE_BUDGET_MS && last3.decoded > 0;
      console.log(
        `[1b] first screen, cold cache, ${LINK_MBPS} Mbps / ${LINK_RTT_MS} ms RTT: ${last3.total} in view. At ${DECODE_BUDGET_MS} ms: ` +
          `${at3s.decoded} decoded. ` +
          (v3.first.allMs !== null
            ? `All settled at ${v3.first.allMs} ms (${last3.decoded} decoded, ${last3.missing} 404).`
            : `At ${DECODE_WATCH_MS / 1000} s: ${last3.decoded} decoded, ${last3.missing} 404, ${last3.total - last3.decoded - last3.missing} still not there.`) +
          ` ${mb(v3.net.wireBytes())} on the wire so far.`,
      );
      verdicts.push({
        n: "1b",
        ok: c3bOk,
        line: `the same, on a ${LINK_MBPS} Mbps link with an empty browser cache (loopback cannot tell the fix from the bug)`,
        detail: c3bOk
          ? `${last3.decoded} decoded by ${v3.first.allMs} ms`
          : `${at3s.decoded}/${last3.total - last3.missing} at 3 s, ` + (v3.first.allMs !== null ? `all ${last3.decoded} at ${v3.first.allMs} ms` : `${last3.decoded}/${last3.total - last3.missing} at ${DECODE_WATCH_MS / 1000} s`),
      });
      await slow.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    proxy?.server.close();
  }

  // ---- D: posters the server will not deliver, whatever the speed ----------
  const classified = missing.length ? await classifyMissing(missing) : [];
  const count = (cls) => classified.filter((c) => c.cls === cls).length;
  const defects = classified.filter((c) => DEFECT_CLASSES.includes(c.cls));
  verdicts.push({
    n: "D",
    ok: defects.length === 0,
    line: "every poster the library lists is one the server delivers",
    detail:
      `${expected.length - missing.length} of ${expected.length} delivered; refused: ownerless ${count("ownerless")}, ` +
      `missing-file ${count("missing-file")}, other ${count("other")}`,
  });

  console.log(`\ngrid cache after this run: ${warm()}/${expected.length} warm (was ${warmBefore}).`);

  console.log(`\n${PREFIX ? "PRE-FIX SIMULATION" : "RESULT"} against ${BASE_URL}, viewport ${VIEWPORT.width}x${VIEWPORT.height}:`);
  verdicts.sort((a, b) => String(a.n).localeCompare(String(b.n)));
  for (const v of verdicts) {
    console.log(`  ${v.ok ? "PASS" : "FAIL"}  ${/^\d/.test(v.n) ? "criterion " : ""}${v.n}: ${v.line} -- ${v.detail}`);
  }
  if (defects.length) {
    console.log(`\n  ${defects.length} poster(s) answer 404 because of a CODE defect (library position = grid index):`);
    for (const x of defects) console.log(`    #${x.index}  ${x.id}  ${x.createdAt}  [${x.cls}] ${x.why}`);
  }
  if (verdicts.some((v) => !v.ok)) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  process.exitCode = 1;
  console.error(err instanceof Error ? err.stack || err.message : err);
} finally {
  await removeSession();
  await prisma.$disconnect().catch(() => {});
}
