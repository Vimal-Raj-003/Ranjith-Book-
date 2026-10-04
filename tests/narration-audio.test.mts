/**
 * Real audio: Pocket TTS records a short narration, faster-whisper times it,
 * and the timings are checked against the recording's measured silences
 * (`helpers/audio-truth.mts`).
 *
 * Slow (a voice model and a speech model both load), so it only runs with
 *   BOOKREEL_AUDIO_TESTS=1 npm test
 * and skips — saying why — when either tool is not installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { synthesizeVoiceover, resolveVoice } from "../src/lib/media/tts";
import { setSetting, prisma } from "../src/lib/db";
import { voiceFields } from "../src/lib/episode-view";
import { pocketTtsStatus } from "../src/lib/media/pocket-tts";
import { timeNarration, alignPython } from "../src/lib/media/narration-timing";
import { toSrt } from "../src/lib/media/captions";
import { measureTiming, summarize } from "./helpers/audio-truth.mjs";

const BEATS = [
  "The obstacle is not in the way. It is the way.",
  "A page written long ago makes a simple claim. Whatever blocks your work becomes your work.",
  "So the next time something stops you, stop and look at it. That is the assignment.",
];

test("a real Pocket TTS narration is timed from its own audio", async (t) => {
  if (process.env.BOOKREEL_AUDIO_TESTS !== "1") return t.skip("set BOOKREEL_AUDIO_TESTS=1 to run the real-audio test");
  if (!alignPython()) return t.skip("faster-whisper is not set up (npm run setup:align)");
  const status = await pocketTtsStatus().catch(() => null);
  if (!status?.installed) return t.skip("Pocket TTS is not installed (npm run setup:voice)");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-narration-"));
  try {
    const voice = await synthesizeVoiceover(BEATS, dir);
    const timing = await timeNarration(voice, dir);

    assert.equal(timing.source, "audio", timing.notes.join(" | "));
    assert.equal(timing.words.length, BEATS.join(" ").split(/\s+/).length, "every script word is timed");
    const recognised = timing.perBeat.reduce((n, b) => n + b.matched, 0) / timing.words.length;
    assert.ok(recognised >= 0.85, `${Math.round(recognised * 100)}% of words recognised`);

    const acc = await measureTiming(voice.audioPath, voice.totalDuration, timing.beats, timing.words);
    const onset = summarize(acc.onsetErrors);
    const offset = summarize(acc.offsetErrors);
    const resume = summarize(acc.resumeErrors);
    t.diagnostic(`recognised ${Math.round(recognised * 100)}% · onset err mean ${onset.mean.toFixed(3)}s max ${onset.max.toFixed(3)}s · end err mean ${offset.mean.toFixed(3)}s · ${acc.internalPauses} pauses, resume err mean ${resume.mean.toFixed(3)}s · straddles ${acc.straddles.length}`);

    assert.equal(acc.outOfBounds, 0, "every timestamp is inside the recording");
    // Onset is graded against where SPEECH starts (helpers/audio-truth.mts), not where sound does: the TTS
    // inhales before most beats and silencedetect hears that as sound, which is how a first caption used to
    // lead its voice by 0.3-0.9 s. Left over is an occasional louder inhale (worst 0.59 s over 207 real beats).
    assert.ok(onset.mean < 0.2, `a beat's first word starts close to where its speech does (mean ${onset.mean.toFixed(3)})`);
    assert.ok(onset.max < 0.6, `and never far from it (max ${onset.max.toFixed(3)})`);
    assert.ok(offset.max < 0.35, `a beat's last word ends within 0.35 s of its sound (max ${offset.max.toFixed(3)})`);
    assert.ok(acc.internalPauses >= 2, "the two-sentence beats have measurable pauses to check against");
    assert.equal(acc.straddles.length, 0, `no word spans a measured pause: ${acc.straddles.join("; ")}`);

    // Subtitles: every line starts on a real word and stays inside the recording.
    for (const line of timing.captions) {
      assert.equal(line.start, line.words[0].start);
      assert.ok(line.end <= voice.totalDuration + 0.5);
    }
    const srt = toSrt(timing.captions, 0.7);
    const times = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)].map((m) => [
      +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
      +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
    ]);
    assert.equal(times.length, timing.captions.length);
    for (let i = 0; i < times.length; i++) {
      assert.ok(times[i][1] > times[i][0], "each cue ends after it starts");
      if (i) assert.ok(times[i][0] >= times[i - 1][1] - 1e-3, "cues never overlap");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- which voice a render uses
//
// `resolveVoice` is the part of `synthesizeVoiceover` that needs no audio, so
// the answer a finished episode records can be asserted without a TTS model.
// These write the `Setting` table, which is only safe in the per-process copy
// `tests/setup/isolated-db.mjs` hands out -- run bare (`tsx --test`) they would
// overwrite the operator's real voice choice, so they refuse to start without it.

async function freshVoiceSettings(): Promise<void> {
  assert.ok(
    process.env.BOOKREEL_TEST_DB_PID,
    "these tests write Setting rows: run them through `npm test`, which isolates the database",
  );
  await prisma.setting.deleteMany({ where: { key: { in: ["voiceId", "voiceProvider"] } } });
}

test("resolveVoice falls back to the shipped default when nothing is stored", async () => {
  await freshVoiceSettings();
  assert.deepEqual(await resolveVoice(null), { provider: "pocket", voiceId: "charles" });
});

test("resolveVoice prefers an explicit override over the stored setting", async () => {
  await freshVoiceSettings();
  await setSetting("voiceId", "vera");
  assert.deepEqual(await resolveVoice("george"), { provider: "pocket", voiceId: "george" });
});

test("resolveVoice reads the stored setting", async () => {
  await freshVoiceSettings();
  await setSetting("voiceId", "vera");
  assert.deepEqual(await resolveVoice(null), { provider: "pocket", voiceId: "vera" });
});

test("resolveVoice gives a provider with no stored voice an empty id, not Pocket's default", async () => {
  // Pocket's default is a Pocket voice. Handing "charles" to ElevenLabs would
  // be a request for a voice that provider does not have, so the empty id is
  // left for the provider's own default -- and for the recorder below to treat
  // as "nothing to record".
  await freshVoiceSettings();
  await setSetting("voiceProvider", "openai");
  assert.deepEqual(await resolveVoice(null), { provider: "openai", voiceId: "" });
});

// ------------------------------------------------ what an episode records about it

test("voiceFields records a voice, and reads falsy as 'not recorded' on both sides", () => {
  assert.deepEqual(voiceFields({ voiceId: "vera", voiceProvider: "pocket" }), { voiceId: "vera", voiceProvider: "pocket" });
  // The column's contract is NULL = not recorded, and the inspector says "not
  // recorded" only for null. `resolveVoice` hands back "" for a provider with no
  // stored voice; written as-is it would render as "Narrated by " with no name.
  assert.deepEqual(voiceFields({ voiceId: "", voiceProvider: "openai" }), { voiceId: null, voiceProvider: "openai" });
  assert.deepEqual(voiceFields({ voiceId: "", voiceProvider: "" }), { voiceId: null, voiceProvider: null });
  assert.deepEqual(voiceFields({ voiceId: null, voiceProvider: null }), { voiceId: null, voiceProvider: null });
  assert.deepEqual(voiceFields({}), { voiceId: null, voiceProvider: null }, "an old row has neither column set");
});
