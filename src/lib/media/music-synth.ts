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
 */
export function renderPad(durationSec: number, mood: MusicMood): Float32Array {
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

  return buf;
}

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
 */
export function levelAndFade(buf: Float32Array, targetDb: number, durationSec: number): Float32Array {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / Math.max(1, buf.length));

  // A silent buffer has no level to correct; scaling it would divide by zero.
  const gain = rms > 1e-9 ? Math.pow(10, targetDb / 20) / rms : 0;
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
