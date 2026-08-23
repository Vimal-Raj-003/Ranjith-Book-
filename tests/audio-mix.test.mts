import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  generateMusicBed,
  meanLevelDb,
  MUSIC_MOODS,
  FFMPEG,
} from "../src/lib/media/ffmpeg";
import { DEFAULT_POCKET_VOICE, POCKET_VOICES } from "../src/lib/media/pocket-tts";

/**
 * The operator's complaint was concrete: "the music cannot be heard." The bed
 * used to sit at -32 (16 dB under the -16 LUFS narration); it now targets -22
 * (about 6 dB under, "half the volume"). These tests hold the audible half of
 * that promise to a real measurement rather than trusting the constant, and
 * hold the voice-default change to what the source actually exports.
 */

const HAS_FFMPEG = fs.existsSync(path.join(process.cwd(), "tools", "bin", "ffmpeg"));

test("the default TTS voice is Charles, and Charles is in the catalog", () => {
  assert.equal(DEFAULT_POCKET_VOICE, "charles");
  const charles = POCKET_VOICES.find((v) => v.id === "charles");
  assert.ok(charles, "charles must still be a catalog entry");
  assert.equal(charles?.gender, "male");
});

test("every mood is still registered (bed loudness changes must not drop a mood)", () => {
  for (const id of ["terminal", "spotlight", "blueprint", "editorial"]) {
    assert.ok(MUSIC_MOODS[id], `mood '${id}' should exist`);
  }
});

test(
  "a rendered music bed lands near -22 dB mean level, not the old -32",
  { skip: !HAS_FFMPEG && "no ffmpeg binary under tools/bin in this environment" },
  async () => {
    const out = path.join(os.tmpdir(), `bookreel-bed-test-${process.pid}.wav`);
    try {
      await generateMusicBed(6, out, { style: "terminal" });
      const level = await meanLevelDb(out);
      // The two-pass gain correction targets -22 exactly off a measurement of
      // the same (already-faded) signal, so it should land within a fraction
      // of a dB — well inside a 1.5 dB tolerance — and nowhere near the old
      // -32 target.
      assert.ok(
        Math.abs(level - (-22)) < 1.5,
        `expected mean level near -22 dB, got ${level} dB`,
      );
    } finally {
      await fs.promises.rm(out, { force: true });
      await fs.promises.rm(`${out}.raw.wav`, { force: true });
    }
  },
);

const exec = promisify(execFile);

/**
 * Mean level of one two-second window, measured with `atrim` rather than by
 * seeking. Seeking is what made the original investigation ambiguous; `atrim`
 * is frame-exact and reports the sample count it actually looked at.
 */
async function windowDb(file: string, startSec: number): Promise<number> {
  const { stderr } = await exec(FFMPEG, [
    "-hide_banner", "-i", file,
    "-af", `atrim=start=${startSec}:end=${startSec + 2},volumedetect`,
    "-f", "null", "-",
  ], { maxBuffer: 1024 * 1024 * 8 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const m = /mean_volume: (-?[\d.]+) dB/.exec(stderr ?? "")?.[1];
  return Number(m);
}

/**
 * THE REGRESSION TEST FOR THE SILENT BED.
 *
 * The bed was previously assembled by ffmpeg from one `sine` input per chord
 * voice, each delayed with `adelay` and all mixed with `amix`. At the six
 * seconds the test above uses, that is a handful of inputs and it works. At a
 * real video length it is ~67, and it raced: the finished bed came out loud
 * for its first eight seconds and then digitally silent (-91 dB, every sample
 * zero) for the remaining ninety. Every real video shipped with a bed that
 * stopped almost immediately.
 *
 * A whole-file mean cannot catch this — the broken bed still averaged -22,
 * because the surviving eight seconds were correspondingly too loud. Only
 * sampling ACROSS the timeline catches it, which is what this does, at a
 * length long enough to be representative of an actual episode.
 */
test(
  "the bed is audible across a full-length video, not just at its start",
  { skip: !HAS_FFMPEG && "no ffmpeg binary under tools/bin in this environment" },
  async () => {
    const out = path.join(os.tmpdir(), `bookreel-bed-long-${process.pid}.wav`);
    const duration = 95;
    try {
      await generateMusicBed(duration, out, { style: "editorial" });
      for (const start of [0, 20, 40, 60, 80, 91]) {
        const level = await windowDb(out, start);
        assert.ok(
          Number.isFinite(level) && level > -45,
          `the bed is silent or near-silent at ${start}s (${level} dB) — this is the amix starvation bug returning`,
        );
      }
    } finally {
      await fs.promises.rm(out, { force: true });
      await fs.promises.rm(`${out}.raw.wav`, { force: true });
    }
  },
);

/**
 * A re-render must produce the same video, which means the bed must be the
 * same bytes. The filter-graph version could not promise this — that was the
 * bug above, seen from the other side. Synthesis has no randomness and no
 * clock, so identical input must give an identical file.
 */
test(
  "the same mood and duration always produce byte-identical audio",
  { skip: !HAS_FFMPEG && "no ffmpeg binary under tools/bin in this environment" },
  async () => {
    const a = path.join(os.tmpdir(), `bookreel-bed-det-a-${process.pid}.wav`);
    const b = path.join(os.tmpdir(), `bookreel-bed-det-b-${process.pid}.wav`);
    try {
      await generateMusicBed(45, a, { style: "blueprint" });
      await generateMusicBed(45, b, { style: "blueprint" });
      const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
      assert.equal(hash(a), hash(b), "two renders of the same bed differ — something non-deterministic crept in");
    } finally {
      for (const f of [a, b]) {
        await fs.promises.rm(f, { force: true });
        await fs.promises.rm(`${f}.raw.wav`, { force: true });
      }
    }
  },
);
