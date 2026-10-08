/**
 * The music bed, synthesized sample by sample in Node rather than assembled
 * from an ffmpeg filter graph.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bed used to be built by handing ffmpeg one `sine` input per chord voice,
 * delaying each with `adelay`, and mixing them all with `amix`. At a 30-second
 * test length that is ~22 inputs and it works. At a real video length — 90 to
 * 100 seconds — it is 67 inputs, and it does not: the finished bed came out
 * loud for its first ~8 seconds and then DIGITALLY SILENT (-91 dB, every
 * sample zero) for the remaining 91.
 *
 * It was not a configuration error. The identical command, byte for byte,
 * produced a correct bed on one run and a broken one on the next — `amix`
 * pulling on 67 inputs where all but a few are delayed and producing nothing
 * yet is a starvation race, and which way it falls is timing. That is why it
 * survived review and a 30-second harness: the failure needs the input count
 * of a real video to show up, and even then it is intermittent.
 *
 * Synthesizing the samples directly removes the whole class of problem. It is
 * also exactly deterministic (a requirement — a re-render must be identical),
 * needs no lavfi decoders, and lets the level be set to an exact target
 * arithmetically instead of measured off a file and corrected.
 *
 * ffmpeg still does the ducking, because sidechain compression is genuinely
 * its job — but that graph has two inputs, not sixty-seven.
 */

/** Semitone offset from a root frequency, in equal temperament. */
export const semitone = (root: number, n: number) => root * Math.pow(2, n / 12);

export interface MusicMood {
  id: string;
  /** Chord voicings as semitone offsets from the root. */
  progression: number[][];
  /** Seconds per chord. Slower reads calmer. */
  chordSeconds: number;
  /** Root note in Hz. Kept low-mid so it never crowds the voice. */
  root: number;
}

export const SAMPLE_RATE = 44100;
/** A chord keeps sounding this long into its successor, so the bed never lands
 *  on a silent seam between them. */
const OVERLAP = 1.2;
/** Per-voice mix levels, root first: a pad is felt through its root, not its top. */
const VOICE_LEVELS = [0.5, 0.32, 0.2];

/**
 * A deterministic noise source. `Math.random()` is forbidden anywhere that
 * affects a render — the same episode must produce the same bytes — so this is
 * a plain 32-bit LCG with a fixed seed, standing in for the `anoisesrc`
 * `seed=7` the filter graph used.
 */
function seededNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

/** Linear ramp from 0 to 1 over `len`, guarding a zero-length ramp. */
function ramp(pos: number, len: number): number {
  if (len <= 0) return 1;
  return Math.min(1, Math.max(0, pos / len));
}

/**
 * Render the pad to a Float32Array at `SAMPLE_RATE`, mono, before levelling.
 *
 * Chords are laid end to end and each overlaps its neighbour. Every voice gets
 * a slow swell and release, which is what makes this read as music with phrases
 * rather than as a drone — a drone stops being background after about fifteen
 * seconds and starts being a fault.
 *
 * `intensity` says how much is layered on top. At 0 the pad is the WHOLE output,
 * sample for sample what this function returned before intensity existed: the
 * operator's requirement was that nothing change for anyone who does not ask, and
 * `tests/music-moods.test.mts` holds that to the byte. The pad and its air are
 * therefore computed first and never touched afterwards; the layers are added to
 * the finished buffer, so a layer can be wrong without the pad being wrong.
 *
 *   1  a bass an octave under each chord's root
 *   2  1, plus a soft arpeggio over the chord tones and a thump at each change
 *
 * The default is 1, not 0: the shipped sound is "the same harmony, fuller". If 0
 * were the default the layers would never play for anyone who had not found the
 * control. Anything below 1 is the bare pad and anything above 2 is 2.
 *
 * The raw output can pass +/-1 (the pad alone does, by up to ~25%), and that is
 * fine: this buffer is never written out. `levelAndFade` rescales it to an RMS
 * target and is the thing that keeps the finished bed inside full scale.
 */
export function renderPad(durationSec: number, mood: MusicMood, intensity = 1): Float32Array {
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
        // Swell in, hold, release out — the same shape the two afade filters
        // described, computed directly.
        const env = ramp(t, rise) * ramp(len - t, fall);
        // Phase is derived from the sample index within this voice, so the
        // chord always starts at phase zero and the result is reproducible.
        buf[idx] += Math.sin(w * i) * level * env;
      }
    });
  }

  // A breath of filtered noise so the pad has air around it rather than
  // sounding like a synthesizer alone in a dry room. One-pole lowpass, which
  // is what turns white noise into something pink enough to sit under speech.
  const noise = seededNoise(7);
  const a = 1 - Math.exp((-2 * Math.PI * 620) / SAMPLE_RATE);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += a * (noise() * 0.04 - lp);
    buf[i] += lp * 0.3;
  }

  if (intensity >= 1) addBass(buf, mood, durationSec);
  if (intensity >= 2) {
    addArpeggio(buf, mood, durationSec);
    addPercussion(buf, mood, durationSec);
  }

  return buf;
}

/**
 * Where each chord sits on the timeline, laid out exactly as `renderPad` lays out
 * the pad (same slot count, same overlap, same stopping rule) so a layer begins
 * and ends with the chord it belongs to.
 *
 * The pad does not use this: its own copy of the arithmetic is deliberately left
 * as it was, because the pad is the thing that must not change.
 */
function chordSlots(mood: MusicMood, durationSec: number) {
  const slots: { chord: number[]; at: number; len: number }[] = [];
  const count = Math.ceil(durationSec / mood.chordSeconds);
  for (let slot = 0; slot < count; slot++) {
    const at = slot * mood.chordSeconds;
    const len = Math.min(mood.chordSeconds + OVERLAP, durationSec - at);
    if (len <= 0.3) break;
    slots.push({ chord: mood.progression[slot % mood.progression.length], at, len });
  }
  return slots;
}

/**
 * Peak levels of the layers, against a pad whose voices sum to about 1.
 *
 * They are set by a budget, not by taste. `levelAndFade` holds the whole bed to
 * one RMS, so anything added takes loudness from everything already there, and
 * the layers are low-end heavy: the first bass level tried (0.3) cost the audible
 * part of the bed about 1.5 dB, in a build whose operator had just complained the
 * music could not be heard, and the default tier would have shipped that on every
 * video. Measured on a phone-like band (above 150 Hz) the bass now costs about
 * 0.35 dB, and the arpeggio and accents win back what they cost, and then some,
 * above 380 Hz. `tests/music-moods.test.mts` holds those numbers.
 */
const BASS_LEVEL = 0.14;
const ARP_LEVEL = 0.26;
const THUMP_LEVEL = 0.28;
const TICK_LEVEL = 0.1;

/**
 * A bass an octave below each chord's root, swelling in and out with the chord.
 *
 * A pad is felt through its root, and this is that root, doubled down. Its second
 * harmonic is mixed in on purpose: the fundamental sits at 45-120 Hz, which a
 * phone speaker (where a 9:16 video is mostly heard) cannot reproduce, so a pure
 * sine would add RMS the listener never hears, and `levelAndFade` would then turn
 * the whole bed down to make room for it. The harmonic is the root itself, one
 * octave up, which is audible everywhere.
 */
export function addBass(buf: Float32Array, mood: MusicMood, durationSec: number): void {
  for (const { chord, at, len } of chordSlots(mood, durationSec)) {
    const w = (2 * Math.PI * (semitone(mood.root, chord[0]) / 2)) / SAMPLE_RATE;
    const rise = Math.min(0.3, len * 0.2);
    // Shorter than the pad's release: two bass notes a fifth apart sounding
    // together are muddy long before two pad chords are.
    const fall = Math.min(0.8, len * 0.3);
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(len * SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      if (idx >= buf.length) break;
      const t = i / SAMPLE_RATE;
      const env = ramp(t, rise) * ramp(len - t, fall);
      buf[idx] += (Math.sin(w * i) + 0.5 * Math.sin(2 * w * i)) * BASS_LEVEL * env;
    }
  }
}

/**
 * Eight steps a chord, so the arpeggio is phrased against the harmonic rhythm:
 * a mood with long chords arpeggiates slowly and a quick one briskly, without
 * the mood having to say anything about tempo. Indices run through the chord's
 * tones and then its root an octave up (`-1` is a rest). It climbs, turns, and
 * leaves the last step empty so the chord change lands clean.
 */
const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, -1];

/**
 * A soft pluck arpeggio over the chord tones, an octave above the pad so it sits
 * on top of the harmony rather than inside it. Each note decays on its own and is
 * cut off just past the end of its chord, so a note from the old chord never
 * rings against the new one.
 */
export function addArpeggio(buf: Float32Array, mood: MusicMood, durationSec: number): void {
  const stepSec = mood.chordSeconds / ARP_PATTERN.length;
  const tau = stepSec * 1.2;
  for (const { chord, at } of chordSlots(mood, durationSec)) {
    ARP_PATTERN.forEach((index, k) => {
      if (index < 0) return;
      const noteAt = at + k * stepSec;
      if (noteAt >= durationSec) return;
      const tone = chord[index % chord.length] + 12 * Math.floor(index / chord.length);
      const w = (2 * Math.PI * semitone(mood.root, tone + 12)) / SAMPLE_RATE;
      // The downbeat and the half-bar lead; the steps between are lighter.
      const velocity = k === 0 ? 1 : k === 4 ? 0.85 : 0.65;
      const noteLen = Math.min(3.5 * stepSec, at + mood.chordSeconds - noteAt + 0.3);
      const start = Math.round(noteAt * SAMPLE_RATE);
      const count = Math.round(noteLen * SAMPLE_RATE);
      for (let i = 0; i < count; i++) {
        const idx = start + i;
        if (idx >= buf.length) break;
        const t = i / SAMPLE_RATE;
        const env = ramp(t, 0.008) * Math.exp(-t / tau) * ramp(noteLen - t, 0.12);
        buf[idx] += (Math.sin(w * i) + 0.25 * Math.sin(2 * w * i)) * ARP_LEVEL * velocity * env;
      }
    });
  }
}

/**
 * A soft accent where each chord begins: a low thump whose pitch falls from 150 to
 * 55 Hz in a few tens of milliseconds (which is what makes a sine read as a drum),
 * with a very short, dark noise brush on top so the hit has an edge a small
 * speaker can reproduce.
 *
 * The noise is re-seeded for every hit, so all hits are the same hit and the
 * result does not depend on how many came before it. A seeded LCG again, never
 * `Math.random`: a re-render has to produce the same bytes.
 */
export function addPercussion(buf: Float32Array, mood: MusicMood, durationSec: number): void {
  const HIT_SECONDS = 0.4;
  const F0 = 150;
  const F1 = 55;
  const GLIDE = 0.035;
  const brush = 1 - Math.exp((-2 * Math.PI * 3000) / SAMPLE_RATE);
  for (const { at } of chordSlots(mood, durationSec)) {
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(HIT_SECONDS * SAMPLE_RATE);
    const noise = seededNoise(11);
    let lp = 0;
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      if (idx >= buf.length) break;
      const t = i / SAMPLE_RATE;
      // The integral of a frequency that decays exponentially from F0 to F1.
      const phase = 2 * Math.PI * (F1 * t + (F0 - F1) * GLIDE * (1 - Math.exp(-t / GLIDE)));
      lp += brush * (noise() - lp);
      const hit = Math.sin(phase) * Math.exp(-t / 0.09) * THUMP_LEVEL + lp * Math.exp(-t / 0.02) * TICK_LEVEL;
      buf[idx] += hit * ramp(t, 0.004);
    }
  }
}

/** Where the loudest sample may land, as a fraction of full scale (-0.2 dBFS). */
const PEAK_CEILING = 0.98;

/**
 * Scale the buffer so its RMS lands exactly on `targetDb` dBFS, then apply the
 * global fades.
 *
 * ffmpeg's `volumedetect` reports `mean_volume` as RMS in dBFS, so computing
 * RMS here and scaling to the target is the same measurement the old two-pass
 * "render, measure the file, correct with a gain" dance was making — minus the
 * round trip, and exact rather than approximate.
 *
 * The fades are applied AFTER levelling for the same reason the filter version
 * put them after `loudnorm`: measuring a buffer that already fades to zero at
 * both ends would drag the average down and push the body of the bed too loud.
 *
 * The target is a MEAN level, and these buffers have a peak about three times
 * their RMS (the shipped pad's crest factor runs 2.4 to 3.3), so a target above
 * about -8 to -10 dB, depending on the mood, would push the loudest samples past
 * full scale, where `toWav` clamps them flat. Nothing could ask for that until
 * the level became a setting (it was a constant, -22, whose peak is a comfortable
 * -12 dBFS). So the gain is capped to land the peak at `PEAK_CEILING`: a bed set
 * louder than it can go cleanly comes out as loud as it can go cleanly, not
 * distorted. At the default the cap never engages, so the shipped bed is not
 * touched by it. The level SETTING stops at -13 (`settings/keys.ts`) so that the
 * cap is a safety net and not part of the control. Where it first engages was
 * measured over every mood, tier and end phase of a bed: from -9.5 dB down to
 * -12.2 dB (momentum, whose quick chords stack most often). -12 is not enough,
 * since momentum's upper tiers cross it by up to 0.2 dB; -13 is clear of every
 * case measured, and a test holds the gain at the top of the range to the plain
 * RMS gain, bit for bit.
 */
export function levelAndFade(buf: Float32Array, targetDb: number, durationSec: number): Float32Array {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, buf.length));

  // A silent buffer has no level to correct; scaling it would divide by zero.
  let gain = rms > 1e-9 ? Math.pow(10, targetDb / 20) / rms : 0;
  if (peak * gain > PEAK_CEILING) gain = PEAK_CEILING / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;

  const fadeOut = Math.max(1, Math.min(4, durationSec * 0.1));
  const inN = Math.round(2 * SAMPLE_RATE);
  const outN = Math.round(fadeOut * SAMPLE_RATE);
  for (let i = 0; i < Math.min(inN, buf.length); i++) buf[i] *= i / inN;
  for (let i = 0; i < Math.min(outN, buf.length); i++) {
    buf[buf.length - 1 - i] *= i / outN;
  }
  return buf;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function toWav(buf: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const bytes = buf.length * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + bytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);           // PCM chunk size
  out.writeUInt16LE(1, 20);            // format: PCM
  out.writeUInt16LE(1, 22);            // channels: mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32);            // block align
  out.writeUInt16LE(16, 34);           // bits per sample
  out.write("data", 36, "ascii");
  out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < buf.length; i++) {
    // Clamp before quantising: a sample past +/-1 wraps to the opposite
    // extreme in two's complement, which is heard as a loud click.
    const s = Math.max(-1, Math.min(1, buf[i]));
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return out;
}
