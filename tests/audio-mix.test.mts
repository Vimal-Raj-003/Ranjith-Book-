import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateMusicBed,
  meanLevelDb,
  MUSIC_MOODS,
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
