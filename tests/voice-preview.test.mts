import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { POCKET_VOICES } from "../src/lib/media/pocket-tts";
import {
  assertIsolatedWorkRoot,
  requireIsolatedWorkRoot as requireShared,
} from "./setup/isolation";
import { PREVIEW_LINE, previewPath, previewVoice } from "../src/lib/media/voice-preview";

/**
 * `previewVoice` is tested rather than the route handler: the route's only other
 * job is `requireUser()`, which reads `cookies()` and throws outside a request
 * scope, so calling `POST()` here could only ever assert on that throw. The same
 * split `episodes-api.test.mts` uses against `listEpisodes`.
 *
 * Synthesis is always a stub. The real `synthPocket` would find the operator's
 * long-lived Pocket TTS server on :8123 if their render has started it (and
 * compete with that render for the CPU), or boot a second one if it had not.
 */

type Call = { text: string; out: string; voice: string };

// ------------------------------------------------- the operator's cache is not ours to write
//
// `previewVoice` caches one clip per voice under `WORK_ROOT/voice-preview`, and
// `WORK_ROOT` is the operator's real `.bookreel/` unless the `npm test` preload
// (`tests/setup/isolated-db.mjs`) has moved it. Run bare -- `tsx --test` -- every
// test below would write its stand-in clips into the live cache, and since a
// cache hit is never re-synthesised, the next real preview would serve them.
// That is not hypothetical: it happened, and left eleven voices unplayable.
//
// So any test that can write there asserts first, and fails closed. It checks
// where THIS process's `WORK_ROOT` actually points -- the preload names the
// copy it made (`work-<pid>` under `.bookreel/test/`) -- rather than whether
// some variable is set, so a stale or inherited `BOOKREEL_TEST_DB_PID` or
// `BOOKREEL_WORK_ROOT` from a parent process cannot satisfy it. Same shape as
// `tests/narration-audio.test.mts`.
//
// The guard itself now lives in `tests/setup/isolation.mts`, because the same
// hazard applies to every test file that writes posters or database rows and
// four hand-rolled copies of a safety check is how the copy in the file that
// needed it ends up subtly weaker. The self-test below is still here: it proves
// every branch of the shared one throws.

const normal = (p: string) => p.replace(/\\/g, "/");

const WHAT = "these tests write preview clips into the work root";
const requireIsolatedWorkRoot = () => requireShared(WHAT);

/**
 * The smallest honest WAV: a 44-byte PCM header (mono, 24 kHz, 16-bit) over
 * silence. If a stand-in ever escapes the guard above, what it leaves behind is
 * a file the browser can play, not poison the size check mistakes for a clip.
 */
function wavStub(total = 4096): Buffer {
  const buf = Buffer.alloc(Math.max(total, 44));
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28); // bytes per second
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(buf.length - 44, 40);
  return buf;
}

/** A synthesizer that records what it was asked for and writes a plausible clip. */
function fakeSynth(bytes = 4096) {
  requireIsolatedWorkRoot();
  const calls: Call[] = [];
  const synth = async (text: string, out: string, voice: string) => {
    calls.push({ text, out, voice });
    await fs.writeFile(out, wavStub(bytes));
  };
  return { synth, calls };
}

async function clean(voiceId: string) {
  requireIsolatedWorkRoot();
  await fs.rm(previewPath(voiceId), { force: true });
}

test("the isolation guard refuses a run that is not under `npm test`", () => {
  const cwd = process.cwd();
  const pid = process.pid;
  const own = path.join(cwd, ".bookreel", "test", `work-${pid}`);

  // A bare run: no preload, so no pid marker and the operator's real work root.
  assert.throws(
    () => assertIsolatedWorkRoot({ dbPid: undefined, workRoot: path.join(cwd, ".bookreel") }),
    /run them through `npm test`/,
  );
  // A marker that is set but is not this process's: inherited from a parent.
  assert.throws(() => assertIsolatedWorkRoot({ dbPid: String(pid + 1), workRoot: own }), /no isolated environment/);
  assert.throws(() => assertIsolatedWorkRoot({ dbPid: "1", workRoot: own }), /no isolated environment/);
  // This process's marker, but the work root is still the real one.
  assert.throws(
    () => assertIsolatedWorkRoot({ dbPid: String(pid), workRoot: path.join(cwd, ".bookreel") }),
    /not this process's own/,
  );
  // This process's marker, but the work root is another process's copy.
  assert.throws(
    () =>
      assertIsolatedWorkRoot({
        dbPid: String(pid),
        workRoot: path.join(cwd, ".bookreel", "test", `work-${pid + 1}`),
      }),
    /not this process's own/,
  );
  // And it does let the genuine article through.
  assert.doesNotThrow(() => assertIsolatedWorkRoot({ dbPid: String(pid), workRoot: own }));
});

test("this process writes previews into its own isolated work root, never the operator's", () => {
  // Fails on a bare run -- the message says to use `npm test`.
  requireIsolatedWorkRoot();
  const own = normal(path.join(process.cwd(), ".bookreel", "test", `work-${process.pid}`));
  assert.ok(normal(previewPath("alba")).startsWith(`${own}/`), `${previewPath("alba")} is outside ${own}`);
});

test("an unsupported voice is rejected before any synthesis", async () => {
  const { synth, calls } = fakeSynth();
  for (const bad of ["scarlett", "", "ALBA", "../alba", "alba/../../x", "alba.wav", "__proto__", "constructor"]) {
    const result = await previewVoice(bad, synth);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    if (!result.ok) assert.equal(result.code, "bad_voice");
  }
  assert.equal(calls.length, 0, "a refused voice never reaches the synthesizer");
});

test("a malformed voice id is rejected, whatever its type", async () => {
  const { synth, calls } = fakeSynth();
  for (const bad of [undefined, null, 7, {}, ["alba"], true]) {
    const result = await previewVoice(bad, synth);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "bad_voice");
  }
  assert.equal(calls.length, 0);
});

test("every catalogue voice can be previewed, each to a file of its own", async () => {
  const { synth, calls } = fakeSynth();
  const paths = new Set<string>();
  for (const v of POCKET_VOICES) {
    await clean(v.id);
    const result = await previewVoice(v.id, synth);
    assert.equal(result.ok, true, `${v.id} is in the catalogue`);
    if (result.ok) paths.add(result.path);
  }
  assert.equal(paths.size, POCKET_VOICES.length, "two voices must never share a clip");
  assert.deepEqual(
    calls.map((c) => c.voice).sort(),
    POCKET_VOICES.map((v) => v.id).sort(),
    "each voice was asked for by its own id",
  );
});

test("every voice speaks the same line, so two previews differ only by the voice", async () => {
  const { synth, calls } = fakeSynth();
  await clean("alba");
  await clean("george");
  await previewVoice("alba", synth);
  await previewVoice("george", synth);
  assert.deepEqual(calls.map((c) => c.text), [PREVIEW_LINE, PREVIEW_LINE]);
});

test("a clip is synthesized once and reused", async () => {
  const { synth, calls } = fakeSynth();
  await clean("vera");
  const first = await previewVoice("vera", synth);
  const second = await previewVoice("vera", synth);
  assert.equal(first.ok && second.ok, true);
  assert.equal(calls.length, 1, "the line is fixed, so the second preview is the same audio");
  if (first.ok && second.ok) assert.equal(first.path, second.path);
});

test("a cached clip too small to be audio is synthesized again", async () => {
  const { synth, calls } = fakeSynth();
  await clean("eve");
  await fs.mkdir(path.dirname(previewPath("eve")), { recursive: true });
  await fs.writeFile(previewPath("eve"), Buffer.alloc(200, 1));
  const result = await previewVoice("eve", synth);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "a stub of a file is not a cache hit");
  assert.ok((await fs.stat(previewPath("eve"))).size >= 1024);
});

async function plantCached(voiceId: string, bytes: Buffer): Promise<void> {
  await clean(voiceId);
  await fs.mkdir(path.dirname(previewPath(voiceId)), { recursive: true });
  await fs.writeFile(previewPath(voiceId), bytes);
}

test("a cached file with a RIFF/WAVE header is a cache hit", async () => {
  const { synth, calls } = fakeSynth();
  const planted = wavStub(2048);
  await plantCached("cosette", planted);
  const result = await previewVoice("cosette", synth);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0, "a real clip already on disk is served, not made again");
  assert.deepEqual(await fs.readFile(previewPath("cosette")), planted, "and it is left exactly as it was");
});

test("a cached file big enough to be audio but not a WAV is a miss, and is synthesized again", async () => {
  // The size check alone let 4 KiB of 0x01 stand as a clip for good: it was served as
  // audio/wav, the browser refused it, and no later request ever replaced it.
  const avi = wavStub(4096);
  avi.write("AVI ", 8, "ascii");
  const notWavs: Record<string, Buffer> = {
    "raw bytes": Buffer.alloc(4096, 1),
    "zeros": Buffer.alloc(4096),
    "RIFF with a different form type": avi,
    "WAVE where RIFF belongs": Buffer.concat([Buffer.from("WAVERIFF"), Buffer.alloc(4096)]),
    "an MP3 under a .wav name": Buffer.concat([Buffer.from("ID3\u0004\u0000"), Buffer.alloc(4096, 0xff)]),
  };
  for (const [what, bytes] of Object.entries(notWavs)) {
    const { synth, calls } = fakeSynth();
    await plantCached("peter_yearsley", bytes);
    const result = await previewVoice("peter_yearsley", synth);
    assert.equal(result.ok, true, `${what}: a bad cache entry degrades to making it again, never to an error`);
    assert.equal(calls.length, 1, `${what} is not a cache hit`);
    const head = (await fs.readFile(previewPath("peter_yearsley"))).subarray(0, 12);
    assert.equal(head.toString("ascii", 0, 4), "RIFF", `${what} was replaced by a real clip`);
    assert.equal(head.toString("ascii", 8, 12), "WAVE");
  }
});

test("a bad cached file whose replacement also fails is reported, not thrown, and tried again next time", async () => {
  await plantCached("peter_yearsley", Buffer.alloc(4096, 1));
  const result = await previewVoice("peter_yearsley", async () => {
    throw new Error("engine offline");
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "voice_unavailable");

  const { synth, calls } = fakeSynth();
  const again = await previewVoice("peter_yearsley", synth);
  assert.equal(again.ok, true, "the bad entry was never trusted, so the next request still repairs it");
  assert.equal(calls.length, 1);
});

test("preview never creates an episode", async () => {
  // Acceptance criterion 14: previewing must not start a render.
  const before = await prisma.episode.count();
  const { synth } = fakeSynth();
  const failing = async () => {
    throw new Error("boom");
  };
  await clean("charles");
  await previewVoice("charles", synth);
  await previewVoice("charles", synth);
  await previewVoice("scarlett", synth);
  await previewVoice("jane", failing);
  assert.equal(await prisma.episode.count(), before);
});

test("preview cannot reach the pipeline: nothing it imports can start a render", async () => {
  // The count above proves one run did not. This holds the next edit to it: a
  // preview that imported the pipeline or the episode queue would be one call
  // away from rendering something.
  const files = [
    "../src/lib/media/voice-preview.ts",
    "../src/app/api/voice/preview/route.ts",
  ];
  for (const file of files) {
    const source = await fs.readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    for (const m of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.doesNotMatch(m[1], /pipeline|episodes?\/|\/queue|\/live/, `${file} imports ${m[1]}`);
    }
  }
});

test("a missing Pocket TTS install surfaces as a named error, not a hang", async () => {
  // Review Focus 5. `ensureServer` throws this when no binary resolves; the
  // route turns the code into a 503 the UI shows as a toast.
  const message = "Pocket TTS is not installed. Run `npm run setup:voice`, or pick a different voice engine in Settings.";
  const notInstalled = async () => {
    throw new Error(message);
  };
  await clean("paul");
  const result = await previewVoice("paul", notInstalled);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "voice_unavailable");
    assert.equal(result.error, message, "the operator is told what to do, in the engine's own words");
  }
});

test("a thrown non-Error still comes back as voice_unavailable", async () => {
  await clean("paul");
  const result = await previewVoice("paul", async () => {
    throw "a string, not an Error";
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "voice_unavailable");
    assert.ok(result.error.length > 0, "never an empty message");
  }
});

test("a failed synthesis leaves nothing behind, and the next preview tries again", async () => {
  await clean("michael");
  let calls = 0;
  const partialThenFail = async (_text: string, out: string) => {
    calls++;
    await fs.writeFile(out, wavStub(5000)); // the half of a clip that arrived
    throw new Error("connection dropped");
  };
  const failed = await previewVoice("michael", partialThenFail);
  assert.equal(failed.ok, false);

  await assert.rejects(fs.stat(previewPath("michael")), "a half-written clip must not become the cache");
  const leftovers = (await fs.readdir(path.dirname(previewPath("michael")))).filter((n) => n.startsWith("michael"));
  assert.deepEqual(leftovers, [], "and no scratch file is left either");

  const { synth, calls: retried } = fakeSynth();
  const again = await previewVoice("michael", synth);
  assert.equal(again.ok, true, "a failure is not remembered");
  assert.equal(retried.length, 1);
  assert.equal(calls, 1);
});

test("a clip being written is never served half-finished, and a second request joins it", async () => {
  await clean("stuart_bell");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  const slow = async (_text: string, out: string) => {
    calls++;
    await fs.writeFile(out, wavStub(3000)); // enough to pass for a clip
    started();
    await gate;
    await fs.writeFile(out, wavStub(9000));
  };

  const first = previewVoice("stuart_bell", slow);
  await running;
  // Mid-synthesis: a second request for the same voice, and a look at the path
  // that would be served. Neither may see (or start over) the unfinished clip.
  const second = previewVoice("stuart_bell", slow);
  await assert.rejects(fs.stat(previewPath("stuart_bell")), "the finished path does not exist until the clip does");
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(calls, 1, "two requests for one voice are one synthesis, not two competing for the CPU");
  assert.equal((await fs.stat(previewPath("stuart_bell"))).size, 9000, "what is served is the whole clip");
});
