import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  renderPad,
  levelAndFade,
  toWav,
  addPercussion,
  semitone,
  SAMPLE_RATE,
  type MusicMood,
} from "../src/lib/media/music-synth";
import { MUSIC_MOODS, DUCK_PROFILES, duckFilter, generateMusicBed, meanLevelDb, FFMPEG } from "../src/lib/media/ffmpeg";
import { validateSetting, SETTING_FALLBACKS } from "../src/lib/settings/keys";
import { readMusicSettings, bedStyle } from "../src/lib/settings/music";
import { AUTO_MUSIC_MOOD, MUSIC_MOOD_OPTIONS, MUSIC_INTENSITIES, MUSIC_DUCKS, MUSIC_LEVEL_RANGE } from "../src/lib/strings";

const ORIGINAL_FOUR = ["terminal", "spotlight", "blueprint", "editorial"];

test("ten moods, and the original four are unchanged", () => {
  assert.equal(Object.keys(MUSIC_MOODS).length, 10);
  // The four that shipped keep their exact harmonic identity: an episode
  // re-rendered after this change must not come out in a different key.
  assert.deepEqual(MUSIC_MOODS.terminal.progression, [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]]);
  assert.equal(MUSIC_MOODS.terminal.root, 130.81);
  assert.equal(MUSIC_MOODS.terminal.chordSeconds, 4);
  assert.equal(MUSIC_MOODS.spotlight.root, 146.83);
  assert.equal(MUSIC_MOODS.blueprint.chordSeconds, 5);
  assert.equal(MUSIC_MOODS.editorial.root, 138.59);
});

test("every mood is well formed", () => {
  for (const [id, m] of Object.entries(MUSIC_MOODS)) {
    assert.equal(m.id, id, `${id} must carry its own id`);
    assert.ok(m.progression.length >= 2, `${id} needs a progression`);
    assert.ok(m.progression.every((c) => c.length >= 3), `${id} needs triads`);
    assert.ok(m.root > 80 && m.root < 220, `${id} root ${m.root} must stay out of the voice`);
    assert.ok(m.chordSeconds >= 2 && m.chordSeconds <= 8, `${id} chordSeconds out of range`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance criterion 19: intensity 0 is the bed this build already ships.
// ---------------------------------------------------------------------------

/**
 * `renderPad` exactly as it was at 9d60a66, before it had an `intensity`. It is
 * a frozen copy on purpose: the claim under test is "the new function at 0 is
 * THIS function", and that cannot be checked against itself. Do not tidy it, and
 * do not update it when `renderPad` changes -- if the two ever disagree at
 * intensity 0 the new code is what is wrong.
 *
 * It takes nothing from the module under test, not even `semitone` or the sample
 * rate: a change to either would otherwise move both sides together and leave the
 * comparison green. That division of labour is deliberate. This comparison catches
 * a change to the pad (its voices, envelopes, overlap or air); the recorded hashes
 * below catch a change to anything on the way to a file (`semitone`, the sample
 * rate, `levelAndFade`, `toWav`).
 */
function legacyRenderPad(durationSec: number, mood: MusicMood): Float32Array {
  const SAMPLE_RATE = 44100;
  const semitone = (root: number, step: number) => root * Math.pow(2, step / 12);
  const OVERLAP = 1.2;
  const VOICE_LEVELS = [0.5, 0.32, 0.2];
  const seededNoise = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s / 0x100000000) * 2 - 1;
    };
  };
  const ramp = (pos: number, len: number) => (len <= 0 ? 1 : Math.min(1, Math.max(0, pos / len)));

  const n = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const buf = new Float32Array(n);
  const slots = Math.ceil(durationSec / mood.chordSeconds);
  for (let slot = 0; slot < slots; slot++) {
    const at = slot * mood.chordSeconds;
    const len = Math.min(mood.chordSeconds + OVERLAP, durationSec - at);
    if (len <= 0.3) break;
    const chord = mood.progression[slot % mood.progression.length];
    const rise = Math.min(1.4, len * 0.45);
    const fall = Math.min(1.6, len * 0.5);
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(len * SAMPLE_RATE);
    chord.forEach((step, voice) => {
      const hz = semitone(mood.root, step);
      const level = VOICE_LEVELS[voice] ?? 0.2;
      const w = (2 * Math.PI * hz) / SAMPLE_RATE;
      for (let i = 0; i < count; i++) {
        const idx = start + i;
        if (idx >= n) break;
        const t = i / SAMPLE_RATE;
        const env = ramp(t, rise) * ramp(len - t, fall);
        buf[idx] += Math.sin(w * i) * level * env;
      }
    });
  }
  const noise = seededNoise(7);
  const a = 1 - Math.exp((-2 * Math.PI * 620) / SAMPLE_RATE);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += a * (noise() * 0.04 - lp);
    buf[i] += lp * 0.3;
  }
  return buf;
}

const bytes = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

test("intensity 0 is byte-identical to the pad this build already ships", () => {
  // Acceptance criterion 19. This is the regression gate: the new layers must
  // be strictly additive on top of an untouched renderPad core.
  for (const id of ORIGINAL_FOUR) {
    // 12 s is a few chords; 7.3 s ends mid-chord, which is the path a real
    // episode's length takes.
    for (const seconds of [12, 7.3]) {
      const now = renderPad(seconds, MUSIC_MOODS[id], 0);
      const then = legacyRenderPad(seconds, MUSIC_MOODS[id]);
      assert.equal(now.length, then.length, `${id} ${seconds}s length`);
      assert.equal(Buffer.compare(bytes(now), bytes(then)), 0, `${id} ${seconds}s: intensity 0 differs from the shipped pad`);
    }
    // And the default arg is NOT 0: the fuller sound is the shipped default.
    const dflt = renderPad(12, MUSIC_MOODS[id]);
    assert.notEqual(Buffer.compare(bytes(dflt), bytes(renderPad(12, MUSIC_MOODS[id], 0))), 0, `${id}: the default must carry the bass`);
    assert.equal(Buffer.compare(bytes(dflt), bytes(renderPad(12, MUSIC_MOODS[id], 1))), 0, `${id}: the default is intensity 1`);
  }
  const pad = renderPad(12, MUSIC_MOODS.terminal, 0);
  assert.ok(pad.some((s) => s !== 0), "the pad must not be silent");
});

/**
 * SHA-256 of what the build at 9d60a66 produced for 12 seconds of each of the
 * original four: the raw pad, and the finished bed (levelled to -22, faded,
 * as a WAV) that `generateMusicBed` writes when there is no narration to duck
 * against. Captured by running that commit's `music-synth.ts`, not this one.
 *
 * The reference copy above proves the logic is unchanged; these pin the actual
 * bytes. They depend on the platform's `Math.sin`/`Math.exp`/`Math.pow`, which V8
 * implements itself and has not changed in years -- so if THESE fail while the
 * comparison above still passes, suspect a Node upgrade before suspecting the synth.
 */
const SHIPPED = {
  terminal: ["419b76f5f067883d4e8cfd4e987f904c77596aa657242be41ad310aafbd42d85", "374a331ca96215eef7bdac36a56a89b8086199b9af954aaa1376bd6327bb6bad"],
  spotlight: ["28e71843e0e1c906653dfe9e2168101c7e092ac506feb47fb17213fd90d59166", "daeb6fb4564872c479e1dd38002a6027171f1afc48d094c7d63d900444c7c204"],
  blueprint: ["dc8de72183cb95397de593ae0199282a739851afd45479d078ec138a7d02919c", "832fdd09e545890ba2e28f459655e653ca0f4261b45787ae91fa9f7aa86a993b"],
  editorial: ["ca9f91764159334844b1fc7af825ff2d8383007147193822492df9c5f99c1929", "4d3cb9d115193320d939c79e36d170bcbb6d123eb07e48fd5bda27eb14f93f50"],
} as const;

test("intensity 0 reproduces the recorded hashes of the shipped pad and the shipped bed", () => {
  for (const id of ORIGINAL_FOUR) {
    const [padHash, bedHash] = SHIPPED[id as keyof typeof SHIPPED];
    assert.equal(sha256(bytes(renderPad(12, MUSIC_MOODS[id], 0))), padHash, `${id}: raw pad`);
    // The default level (-22) is what the bed has always been.
    assert.equal(sha256(toWav(levelAndFade(renderPad(12, MUSIC_MOODS[id], 0), -22, 12))), bedHash, `${id}: finished bed`);
  }
});

test("the ducked pass at the default setting is the compressor the bed has always had", () => {
  // The ducked output cannot be compared byte for byte -- on some runs ffmpeg's own
  // result for this graph comes out a fraction of a second short (the tail is cut
  // at a variable whole number of frames, inside the closing fade-out; the start is
  // unaffected), in the build before this one as well -- so what is pinned is the
  // filter it is given. With `duck: "off"` there is no ffmpeg pass and no variance.
  assert.equal(duckFilter("normal"), "sidechaincompress=threshold=0.05:ratio=6:attack=20:release=500:makeup=1");
});

// ---------------------------------------------------------------------------
// The layers.
// ---------------------------------------------------------------------------

const rms = (b: Float32Array) => Math.sqrt(b.reduce((a, s) => a + s * s, 0) / b.length);
const peak = (b: Float32Array) => b.reduce((a, s) => Math.max(a, Math.abs(s)), 0);

/**
 * Amplitude of one frequency over [fromSec, toSec). Hann-windowed by default so a
 * neighbouring tone does not leak into it; `hann: false` weighs every sample alike,
 * for a note that is loudest the instant the window opens.
 */
function toneAt(buf: Float32Array, hz: number, fromSec: number, toSec: number, hann = true): number {
  const a = Math.round(fromSec * SAMPLE_RATE);
  const b = Math.round(toSec * SAMPLE_RATE);
  let re = 0, im = 0, norm = 0;
  for (let i = a; i < b; i++) {
    const w = hann ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a)) : 1;
    const ph = (2 * Math.PI * hz * i) / SAMPLE_RATE;
    re += buf[i] * w * Math.cos(ph);
    im += buf[i] * w * Math.sin(ph);
    norm += w;
  }
  return (2 * Math.hypot(re, im)) / norm;
}

test("higher intensity adds energy without making the bed clip", () => {
  const sparse = renderPad(12, MUSIC_MOODS.spotlight, 0);
  const warm = renderPad(12, MUSIC_MOODS.spotlight, 1);
  const full = renderPad(12, MUSIC_MOODS.spotlight, 2);
  assert.equal(sparse.length, full.length);
  assert.ok(rms(warm) > rms(sparse), "intensity 1 should be fuller than intensity 0");
  assert.ok(rms(full) > rms(sparse), "intensity 2 should be fuller than intensity 0");
});

test("no finished bed clips, in any mood at any intensity, even asked for far more than the setting allows", () => {
  // The brief asked for "no sample may clip" of the raw pad. It cannot be held:
  // the pad that shipped peaks at 1.02 to 1.26 before levelling, and it must stay
  // byte-identical. The raw buffer is never written out, though -- `levelAndFade`
  // rescales it -- so the claim that matters is about what comes out of that. -6
  // is beyond the top of the level slider (-13), where without the ceiling the
  // pad's own peak is 1.3 to 1.4: this is the safety net holding where the setting
  // no longer lets anyone ask.
  for (const [id, mood] of Object.entries(MUSIC_MOODS)) {
    for (const intensity of [0, 1, 2]) {
      const seconds = Math.ceil(2 * mood.chordSeconds + 2);
      const out = levelAndFade(renderPad(seconds, mood, intensity), -6, seconds);
      assert.ok(peak(out) <= 1, `${id} at intensity ${intensity}, level -6: peak ${peak(out).toFixed(3)}`);
    }
  }
});

test("the peak ceiling holds a too-loud level back, and leaves a normal one exactly as it was", () => {
  const spiky = () => {
    const b = new Float32Array(SAMPLE_RATE * 8).fill(0.1);
    b[SAMPLE_RATE * 4] = 1; // mid-buffer, clear of both fades
    return b;
  };
  // -6 dB RMS of a buffer whose peak is ten times its RMS would be a peak of 5.
  const loud = levelAndFade(spiky(), -6, 8);
  assert.ok(Math.abs(loud[SAMPLE_RATE * 4] - 0.98) < 1e-6, `capped to the ceiling, got ${loud[SAMPLE_RATE * 4]}`);
  // At -22 the same buffer needs no help, and the gain is the plain RMS gain.
  const a = spiky();
  let sum = 0;
  for (const s of a) sum += s * s;
  const plain = Math.pow(10, -22 / 20) / Math.sqrt(sum / a.length);
  const quiet = levelAndFade(spiky(), -22, 8);
  assert.equal(quiet[SAMPLE_RATE * 4], Math.fround(1 * plain), "below the ceiling the cap does nothing");
});

test("at the top of the slider the delivered mean is the label, exactly, in every mood and tier", () => {
  // `levelAndFade` holds the bed to a MEAN level and a peak ceiling takes over where
  // the peak would pass full scale. If the slider reached into that region its
  // number would overstate what is delivered, by a different amount for each mood.
  // So the setting stops where the ceiling never engages, and this is the proof:
  // the gain applied at the top of the range is the plain RMS gain and nothing
  // else, bit for bit, so the bed's mean level is the number on the slider.
  //
  // The ceiling first engages (measured over every mood, tier and end phase) between
  // -9.5 and -12.2 dB. Momentum is the worst: its quick chords stack more often.
  // At -12 its upper tiers still cross, by 0.01 to 0.2 dB, which is why the top is
  // -13. The specific beds below are momentum's worst end phases found by that
  // sweep (beds this short never occur, and the longer ones are only a fraction of
  // a decibel better); every mood and tier is also checked at 30 s, the shortest a
  // real video's bed gets with room to spare (the shortest target is 45 s).
  const top = MUSIC_LEVEL_RANGE.max;
  const deliversTheLabel = (id: string, tier: number, seconds: number): string | null => {
    const raw = renderPad(seconds, MUSIC_MOODS[id], tier);
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
    const gain = Math.pow(10, top / 20) / Math.sqrt(sum / raw.length);
    // The loudest sample clear of both fades: the ceiling, if it engaged, would have changed the gain.
    const fadeOut = Math.max(1, Math.min(4, seconds * 0.1));
    let at = 2 * SAMPLE_RATE + 1;
    for (let i = at; i < raw.length - Math.ceil(fadeOut * SAMPLE_RATE) - 1; i++) if (Math.abs(raw[i]) > Math.abs(raw[at])) at = i;
    const out = levelAndFade(Float32Array.from(raw), top, seconds);
    return out[at] === Math.fround(raw[at] * gain) ? null : `${id} tier ${tier} at ${seconds} s`;
  };
  const held: string[] = [];
  for (const id of Object.keys(MUSIC_MOODS)) {
    for (const tier of [0, 1, 2]) {
      const cost = deliversTheLabel(id, tier, 30);
      if (cost) held.push(cost);
    }
  }
  for (const [tier, seconds] of [[1, 11.25], [1, 31.3], [2, 9], [2, 38.9]] as const) {
    const cost = deliversTheLabel("momentum", tier, seconds);
    if (cost) held.push(cost);
  }
  assert.deepEqual(held, [], "the ceiling engaged at the top of the slider: the number on it overstates the bed");
});

test("intensity 1 puts a bass an octave under each chord's root, and follows the chord", () => {
  const m = MUSIC_MOODS.terminal; // chord 0 is rooted on C3, chord 1 on G#3
  const bass0 = semitone(m.root, 0) / 2;
  const bass1 = semitone(m.root, 8) / 2;
  const without = renderPad(10, m, 0);
  const warm = renderPad(10, m, 1);
  // Chord 0's plateau is 1.4 s..4 s; chord 1 holds from 5.6 s.
  assert.ok(toneAt(without, bass0, 1.6, 3.8) < 0.01, "the pad alone has nothing down there");
  assert.ok(toneAt(warm, bass0, 1.6, 3.8) > 0.08, "the bass sounds under chord 0");
  assert.ok(toneAt(warm, bass1, 5.8, 8) > 0.08, "and moves to chord 1's root");
  assert.ok(toneAt(warm, bass0, 5.8, 8) < 0.05, "leaving chord 0's root behind");
});

test("intensity 2 adds an arpeggio over the chord tones, which intensity 1 does not have", () => {
  const m = MUSIC_MOODS.terminal;
  // Chord 0 is [0, 3, 7]; the arpeggio sits an octave above the pad's voicing, where the pad is empty.
  const octave = [0, 3, 7].map((s) => semitone(m.root, s + 12));
  const warm = renderPad(10, m, 1);
  const full = renderPad(10, m, 2);
  for (const hz of octave) {
    // Across the chord's four seconds, unwindowed: a pluck is loudest where it starts.
    assert.ok(toneAt(warm, hz, 0, 4, false) < 0.003, `no ${hz.toFixed(0)} Hz at intensity 1`);
    assert.ok(toneAt(full, hz, 0, 4, false) > 0.01, `${hz.toFixed(0)} Hz is played at intensity 2`);
  }
});

test("the percussion is an accent at each chord change and silence between", () => {
  const m = MUSIC_MOODS.terminal; // a chord every 4 s
  const hits = new Float32Array(10 * SAMPLE_RATE);
  addPercussion(hits, m, 10);
  const window = (a: number, b: number) => rms(hits.slice(Math.round(a * SAMPLE_RATE), Math.round(b * SAMPLE_RATE)));
  for (const at of [0, 4, 8]) {
    assert.ok(window(at, at + 0.2) > 0.03, `an accent at ${at}s`);
    assert.equal(window(at + 0.5, at + 3.5 > 10 ? 10 : at + 3.5), 0, `nothing after it, ${at}s on`);
  }
  assert.ok(peak(hits) < 0.5, "soft: a hit never takes half of full scale");
});

test("intensity below 1 is the bare pad and above 2 is 2", () => {
  const m = MUSIC_MOODS.vista;
  const same = (a: Float32Array, b: Float32Array) => Buffer.compare(bytes(a), bytes(b)) === 0;
  assert.ok(same(renderPad(6, m, -1), renderPad(6, m, 0)));
  assert.ok(same(renderPad(6, m, 3), renderPad(6, m, 2)));
});

test("the six new moods all render, and each is audibly its own", () => {
  const fingerprints = new Set<string>();
  for (const [id, mood] of Object.entries(MUSIC_MOODS)) {
    const pad = renderPad(Math.ceil(mood.chordSeconds * 2), mood, 2);
    assert.ok(pad.some((s) => s !== 0), `${id} is silent`);
    fingerprints.add(sha256(bytes(pad)));
  }
  assert.equal(fingerprints.size, 10, "two moods render to the same samples");
});

test("rendering is deterministic", () => {
  const a = renderPad(8, MUSIC_MOODS.editorial, 1);
  const b = renderPad(8, MUSIC_MOODS.editorial, 1);
  assert.deepEqual(Array.from(a.slice(0, 2000)), Array.from(b.slice(0, 2000)));
  // The whole buffer, at every tier: nothing in a layer may depend on a clock or Math.random.
  for (const intensity of [0, 1, 2]) {
    assert.equal(sha256(bytes(renderPad(9, MUSIC_MOODS.nocturne, intensity))), sha256(bytes(renderPad(9, MUSIC_MOODS.nocturne, intensity))), `intensity ${intensity}`);
  }
});

// ---------------------------------------------------------------------------
// The controls on generateMusicBed.
// ---------------------------------------------------------------------------

test("duck profiles run from light to strong around the shipped one", () => {
  assert.deepEqual(DUCK_PROFILES.normal, { threshold: 0.05, ratio: 6 });
  assert.ok(DUCK_PROFILES.light.threshold > DUCK_PROFILES.normal.threshold && DUCK_PROFILES.light.ratio < DUCK_PROFILES.normal.ratio);
  assert.ok(DUCK_PROFILES.strong.threshold < DUCK_PROFILES.normal.threshold && DUCK_PROFILES.strong.ratio > DUCK_PROFILES.normal.ratio);
  for (const duck of ["light", "normal", "strong"] as const) {
    // ffmpeg's accepted ranges for sidechaincompress.
    const { threshold, ratio } = DUCK_PROFILES[duck];
    assert.ok(threshold >= 0.000976563 && threshold <= 1, `${duck} threshold`);
    assert.ok(ratio >= 1 && ratio <= 20, `${duck} ratio`);
    assert.match(duckFilter(duck), new RegExp(`^sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=20:release=500:makeup=1$`));
  }
});

const HAS_FFMPEG = fs.existsSync(FFMPEG);
const execFileAsync = promisify(execFile);

/** Mean level of [from, to) seconds, in dB, as ffmpeg's volumedetect reports it. */
async function windowDb(file: string, from: number, to: number): Promise<number> {
  const { stderr } = await execFileAsync(FFMPEG, ["-hide_banner", "-i", file, "-af", `atrim=start=${from}:end=${to},volumedetect`, "-f", "null", "-"], {
    maxBuffer: 1024 * 1024 * 8,
  }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr ?? "")?.[1]);
}

/** Speech-like narration: voiced phrases with gaps, so there is something to duck against. */
function fixtureVoice(seconds: number): Buffer {
  const n = Math.round(seconds * SAMPLE_RATE);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const on = t % 1.6 < 1.1 ? 1 : 0; // 1.1 s of speech, 0.5 s of gap
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    buf[i] = on * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 280 * t) + 0.4 * Math.sin(2 * Math.PI * 560 * t)) * 0.22;
  }
  return toWav(buf);
}

test(
  "level sets the bed's mean level, and duck off leaves the bed untouched by the narration",
  { skip: !HAS_FFMPEG && "no ffmpeg binary available" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bookreel-bed-controls-"));
    try {
      const voice = path.join(dir, "voice.wav");
      fs.writeFileSync(voice, fixtureVoice(8));
      const quiet = path.join(dir, "quiet.wav");
      const loud = path.join(dir, "loud.wav");
      await generateMusicBed(6, quiet, { style: "terminal", level: -34 });
      await generateMusicBed(6, loud, { style: "terminal", level: -14 });
      const q = await meanLevelDb(quiet);
      const l = await meanLevelDb(loud);
      assert.ok(Math.abs(q - -34) < 1.5, `asked for -34, got ${q}`);
      // -14 is under the ceiling for this bed, so it lands where it was asked.
      assert.ok(Math.abs(l - -14) < 1.5, `asked for -14, got ${l}`);

      // `off` writes the levelled pad and nothing else, narration or not: the file is
      // byte-for-byte the bed made with no narration at all.
      const dry = path.join(dir, "dry.wav");
      const off = path.join(dir, "off.wav");
      await generateMusicBed(6, dry, { style: "terminal" });
      await generateMusicBed(6, off, { style: "terminal", voicePath: voice, voiceOffsetSec: 0, duck: "off" });
      assert.equal(Buffer.compare(fs.readFileSync(dry), fs.readFileSync(off)), 0, "duck off must not run the compressor");
      assert.equal(fs.existsSync(`${off}.raw.wav`), false, "and leaves no scratch file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "light, normal and strong duck the bed progressively harder under speech",
  { skip: !HAS_FFMPEG && "no ffmpeg binary available" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bookreel-bed-duck-"));
    try {
      const voice = path.join(dir, "voice.wav");
      fs.writeFileSync(voice, fixtureVoice(8));
      const bed = async (duck: "off" | "light" | "normal" | "strong") => {
        const f = path.join(dir, `${duck}.wav`);
        await generateMusicBed(8, f, { style: "terminal", voicePath: voice, voiceOffsetSec: 0, duck });
        // The third phrase (3.2 s..4.3 s), past the 2 s fade-in and once the compressor has settled.
        return windowDb(f, 3.6, 4.2);
      };
      const off = await bed("off");
      const reduction: Record<string, number> = {};
      for (const duck of ["light", "normal", "strong"] as const) reduction[duck] = off - (await bed(duck));
      assert.ok(reduction.light > 1, `light should duck by something, got ${reduction.light.toFixed(1)} dB`);
      assert.ok(reduction.normal > reduction.light + 1, `normal ${reduction.normal.toFixed(1)} dB should duck harder than light ${reduction.light.toFixed(1)}`);
      assert.ok(reduction.strong > reduction.normal + 1, `strong ${reduction.strong.toFixed(1)} dB should duck harder than normal ${reduction.normal.toFixed(1)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// What the inspector offers is what the server accepts and the bed can play.
// ---------------------------------------------------------------------------

test("the picker's moods are exactly the registry, in its order, and the server accepts each", () => {
  // strings.ts is a hand-copy (a client component cannot import the registry's
  // consumers), so this is what notices a mood added to one and not the other.
  assert.deepEqual(MUSIC_MOOD_OPTIONS.map((m) => m.id), Object.keys(MUSIC_MOODS));
  for (const m of MUSIC_MOOD_OPTIONS) {
    assert.equal(validateSetting("musicMood", m.id), m.id, m.id);
    assert.ok(m.label && m.note, `${m.id} needs a name and a note`);
  }
  assert.equal(validateSetting("musicMood", AUTO_MUSIC_MOOD.id), AUTO_MUSIC_MOOD.id, "Follows the theme is the server's own 'auto'");
  assert.equal(AUTO_MUSIC_MOOD.id, SETTING_FALLBACKS.musicMood, "and it is the default");
});

test("the picker's duck levels are off plus every profile ffmpeg has, and the server accepts each", () => {
  assert.deepEqual([...MUSIC_DUCKS.map((d) => d.id)].sort(), ["off", ...Object.keys(DUCK_PROFILES)].sort());
  for (const d of MUSIC_DUCKS) assert.equal(validateSetting("musicDuck", d.id), d.id, d.id);
  assert.ok(MUSIC_DUCKS.some((d) => d.id === SETTING_FALLBACKS.musicDuck), "the default is offered");
});

test("the picker's layer tiers are the ones renderPad has, and the default is one of them", () => {
  assert.deepEqual(MUSIC_INTENSITIES.map((o) => o.id), ["0", "1", "2"]);
  for (const o of MUSIC_INTENSITIES) assert.equal(validateSetting("musicIntensity", o.id), o.id, o.id);
  assert.equal(validateSetting("musicIntensity", "3"), null, "there is no tier 3 to offer");
  assert.equal(SETTING_FALLBACKS.musicIntensity, "1", "the shipped default is the fuller sound, not the bare pad");
});

test("the level slider spans exactly what the setting accepts", () => {
  const { min, max, step } = MUSIC_LEVEL_RANGE;
  assert.equal(validateSetting("musicLevel", min), String(min));
  assert.equal(validateSetting("musicLevel", max), String(max));
  assert.equal(validateSetting("musicLevel", min - 1), null);
  assert.equal(validateSetting("musicLevel", max + 1), null);
  assert.equal(step, 1, "the server refuses a fractional level");
  assert.equal(SETTING_FALLBACKS.musicLevel, "-22", "the default is the level the bed has always had");
});

// ---------------------------------------------------------------------------
// What the render reads.
// ---------------------------------------------------------------------------

/** A settings store that is a plain object, so no database is involved. */
const store = (rows: Record<string, string>) => async (key: string) => rows[key] ?? null;

test("with nothing stored the render gets the bed it always had, plus the shipped bass", async () => {
  assert.deepEqual(await readMusicSettings(store({})), { mood: "auto", intensity: 1, level: -22, duck: "normal" });
});

test("stored music settings reach the bed as numbers and ids", async () => {
  const got = await readMusicSettings(store({ musicMood: "vista", musicIntensity: "2", musicLevel: "-30", musicDuck: "strong" }));
  assert.deepEqual(got, { mood: "vista", intensity: 2, level: -30, duck: "strong" });
  // Spelled as an older writer might have: normalised on the way in, like GET does.
  assert.deepEqual(await readMusicSettings(store({ musicLevel: "-22.0", musicIntensity: "0" })), { mood: "auto", intensity: 0, level: -22, duck: "normal" });
});

test("a stored value this build no longer accepts falls back for that setting alone", async () => {
  const got = await readMusicSettings(store({ musicMood: "retired", musicIntensity: "9", musicLevel: "-5", musicDuck: "strong" }));
  assert.deepEqual(got, { mood: "auto", intensity: 1, level: -22, duck: "strong" });
});

test("'auto' keeps the theme's own mood, and a chosen mood overrides it", () => {
  assert.equal(bedStyle("auto", "blueprint"), "blueprint");
  assert.equal(bedStyle("vista", "blueprint"), "vista");
});

test(
  "making a bed touches no network: the music is synthesized here and nothing is fetched",
  { skip: !HAS_FFMPEG && "no ffmpeg binary available" },
  async () => {
    // A standing constraint, not a one-off check: all music is arithmetic in
    // music-synth.ts. No stock library, no download, no licensed sample, so there is
    // nothing to clear and nothing that can fail for want of a connection. The traps
    // sit on every way JS code in this process can reach out; ffmpeg is a child that
    // is handed local files only.
    const calls: string[] = [];
    const restore: Array<() => void> = [];
    const trap = (owner: Record<string, unknown>, name: string, label: string) => {
      const original = owner[name];
      owner[name] = () => {
        calls.push(label);
        throw new Error(`network call attempted: ${label}`);
      };
      restore.push(() => {
        owner[name] = original;
      });
    };
    trap(globalThis as unknown as Record<string, unknown>, "fetch", "fetch");
    for (const [mod, label] of [[http, "http"], [https, "https"]] as const) {
      trap(mod as unknown as Record<string, unknown>, "request", `${label}.request`);
      trap(mod as unknown as Record<string, unknown>, "get", `${label}.get`);
    }
    trap(net.Socket.prototype as unknown as Record<string, unknown>, "connect", "net.Socket.connect");
    trap(dns as unknown as Record<string, unknown>, "lookup", "dns.lookup");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bookreel-bed-offline-"));
    try {
      // The trap is real: a call is caught, or this test proves nothing.
      assert.throws(() => http.get("http://127.0.0.1:1/"), /network call attempted/);
      assert.deepEqual(calls.splice(0), ["http.get"]);

      const voice = path.join(dir, "voice.wav");
      fs.writeFileSync(voice, fixtureVoice(6));
      for (const [style, intensity] of [["vista", 2], ["terminal", 0]] as const) {
        await generateMusicBed(6, path.join(dir, `${style}.wav`), { style, intensity, voicePath: voice, voiceOffsetSec: 0 });
      }
      assert.deepEqual(calls, [], "music generation reached for the network");
    } finally {
      for (const undo of restore.reverse()) undo();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// The layers must not make the bed quieter where a small speaker can hear it.
// ---------------------------------------------------------------------------

/** A second-order highpass (RBJ), run forward: enough to compare the energy above a corner. */
function highpass(buf: Float32Array, corner: number): Float32Array {
  const w0 = (2 * Math.PI * corner) / SAMPLE_RATE;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2;
  const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
  const out = new Float32Array(buf.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

/** Level, in dB, of what is above `corner` Hz once the bed has been levelled to -22 (the first 3 s, where it is still settling, left out). */
function levelAbove(pad: Float32Array, corner: number): number {
  const from = 3 * SAMPLE_RATE;
  const sumSq = (b: Float32Array) => b.slice(from).reduce((a, s) => a + s * s, 0);
  const gain = Math.pow(10, -22 / 20) / rms(pad); // levelAndFade's own
  return 20 * Math.log10(gain * Math.sqrt(sumSq(highpass(pad, corner)) / (pad.length - from)));
}

test("the default tier does not make the bed quieter on a small speaker, and the full tier makes it fuller", () => {
  // `levelAndFade` holds the bed to one RMS, and a bass is mostly RMS a phone
  // cannot reproduce -- so a bass that is too strong turns the part people hear
  // DOWN. The operator's complaint before this was "the music cannot be heard";
  // it must not come back as the default tier. Above 150 Hz is a phone's range;
  // above 380 Hz is where the pad has least and the arpeggio sits.
  for (const id of ["terminal", "vista", "momentum"]) {
    const mood = MUSIC_MOODS[id];
    const seconds = Math.ceil(4 * mood.chordSeconds + 3);
    const [bare, warm, full] = [0, 1, 2].map((i) => renderPad(seconds, mood, i));
    assert.ok(levelAbove(warm, 150) > levelAbove(bare, 150) - 0.6, `${id}: the bass costs the audible bed more than 0.6 dB`);
    assert.ok(levelAbove(full, 380) > levelAbove(bare, 380) + 0.3, `${id}: the full tier adds nothing audible above 380 Hz`);
    assert.ok(levelAbove(full, 150) > levelAbove(bare, 150) - 0.4, `${id}: the full tier is quieter than the bare pad on a small speaker`);
  }
});
