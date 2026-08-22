import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

function resolveBin(name: "ffmpeg" | "ffprobe"): string {
  const local = path.join(process.cwd(), "tools", "bin", name);
  if (fs.existsSync(local)) return local;
  const env = name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  return env || name;
}

export const FFMPEG = resolveBin("ffmpeg");
export const FFPROBE = resolveBin("ffprobe");

export async function ffmpeg(args: string[]) {
  return exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 1024 * 1024 * 32,
  });
}

export async function durationOf(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n)) throw new Error(`Could not read duration of ${path.basename(file)}`);
  return n;
}

/** Concatenate wav segments with a silent gap between each, writing a single wav. */
export async function concatWithGaps(segments: string[], gapSec: number, out: string) {
  const inputs: string[] = [];
  const filterParts: string[] = [];
  segments.forEach((s, i) => {
    inputs.push("-i", s);
    filterParts.push(`[${i}:a]`);
  });
  // Trailing silence source for gaps
  const silence = `anullsrc=channel_layout=mono:sample_rate=44100`;
  inputs.push("-f", "lavfi", "-t", String(gapSec), "-i", silence);
  const gapIdx = segments.length;

  const chain: string[] = [];
  segments.forEach((_, i) => {
    chain.push(`[${i}:a]`);
    if (i < segments.length - 1) chain.push(`[${gapIdx}:a]`);
  });
  const n = chain.length;
  const filter = `${chain.join("")}concat=n=${n}:v=0:a=1[out]`;

  await ffmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", "[out]",
    "-ar", "44100", "-ac", "1",
    out,
  ]);
  void filterParts;
}

/**
 * Broadcast-style voice master: remove rumble, cut boxiness, lift presence so
 * consonants cut through, tame sibilance, then even out and limit the level.
 * Targets -16 LUFS, which is what YouTube and Instagram normalize to.
 */
export async function masterVoice(input: string, out: string) {
  await ffmpeg([
    "-i", input,
    "-af",
    [
      "highpass=f=85",                                  // rumble and plosives
      "equalizer=f=250:t=q:w=1.0:g=-2",                 // boxiness
      "equalizer=f=3200:t=q:w=1.2:g=2.5",               // presence, consonant clarity
      "equalizer=f=6800:t=q:w=2.0:g=-2.5",              // de-ess
      "acompressor=threshold=-18dB:ratio=3:attack=8:release=180",
      "alimiter=limit=0.95",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
    ].join(","),
    "-ar", "44100", "-ac", "1",
    out,
  ]);
}

export async function toMp3(input: string, out: string) {
  await ffmpeg(["-i", input, "-codec:a", "libmp3lame", "-q:a", "2", out]);
}


// ---------------------------------------------------------------------------
// The music bed
// ---------------------------------------------------------------------------

/**
 * What the bed sounds like, chosen per video rather than fixed.
 *
 * The previous bed was three static sine partials with a slow tremolo — a
 * drone, not music. A drone has no phrase and no development, so after about
 * fifteen seconds the ear stops hearing it as background and starts hearing it
 * as a fault. These are short chord progressions instead: they move, they
 * resolve, and they get out of the way.
 *
 * Semitone offsets from the key's root, one entry per chord, three voices each.
 */
interface MusicMood {
  id: string;
  /** Chord voicings as semitone offsets from the root. */
  progression: number[][];
  /** Seconds per chord. Slower reads calmer. */
  chordSeconds: number;
  /** Root note in Hz. Kept low-mid so it never crowds the voice. */
  root: number;
}

const MOODS: Record<string, MusicMood> = {
  // Dark, developer-native. Minor, unhurried, no brightness.
  terminal: {
    id: "terminal",
    // i – VI – III – VII, the standard "calm technical" loop.
    progression: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],
    chordSeconds: 4,
    root: 130.81, // C3
  },
  // Punchy, made for Shorts. Same minor colour, faster harmonic rhythm.
  spotlight: {
    id: "spotlight",
    progression: [[0, 3, 7], [5, 8, 12], [10, 14, 17], [7, 10, 14]],
    chordSeconds: 3,
    root: 146.83, // D3
  },
  // Calm, technical, documentary. Suspended voicings, very little movement.
  blueprint: {
    id: "blueprint",
    progression: [[0, 5, 7], [2, 7, 9], [0, 5, 7], [-2, 3, 5]],
    chordSeconds: 5,
    root: 123.47, // B2
  },
  // Warm paper, magazine feature. Major, gentle, the friendliest of the four.
  editorial: {
    id: "editorial",
    // I – V – vi – IV.
    progression: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
    chordSeconds: 4.5,
    root: 138.59, // C#3
  },
};

const semitone = (root: number, n: number) => root * Math.pow(2, n / 12);

/**
 * Where the bed sits before it ducks, in LUFS.
 *
 * The narration is mastered to -16 LUFS, and music under speech conventionally
 * sits 15 to 20 loudness units beneath it. Measuring to a target rather than
 * applying a guessed dB trim is what makes the four moods land at the same
 * perceived level — trimmed by hand they differed by 9 dB, because a mood with
 * longer chords is quieter in RMS terms while peaking identically.
 */
const BED_MEAN_DB = -32;

/** Mean level of a file in dB, as ffmpeg measures it. */
export async function meanLevelDb(file: string): Promise<number> {
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 8 },
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(stderr ?? "")?.[1];
  const n = Number(mean);
  if (!Number.isFinite(n)) throw new Error(`Could not measure the level of ${path.basename(file)}`);
  return n;
}

/**
 * A quiet musical bed, synthesized rather than sourced so there is no licence
 * to clear and no asset to ship.
 *
 * Two things make it sit properly under narration:
 *
 * 1. **It is music, not a tone.** Each chord is three voices with a slow swell
 *    and release, overlapping into the next, so the bed has phrases.
 * 2. **It ducks.** When `voicePath` is given the bed is sidechain-compressed
 *    against the narration, which is how every broadcast mix does this: the
 *    music steps back under each spoken phrase and returns in the gaps, instead
 *    of sitting at one level and fighting the words.
 *
 * Deterministic for a given mood and duration, so a re-render is identical.
 */
export async function generateMusicBed(
  durationSec: number,
  out: string,
  opts: { style?: string; voicePath?: string; voiceOffsetSec?: number } = {},
) {
  const d = Math.max(1, +durationSec.toFixed(3));
  const mood = MOODS[opts.style ?? "terminal"] ?? MOODS.terminal;
  const fadeOut = Math.max(1, Math.min(4, d * 0.1));

  const inputs: string[] = [];
  const parts: string[] = [];
  const voices: string[] = [];
  let idx = 0;

  // Chords are laid out end to end and each one overlaps its neighbour, so the
  // bed never lands on a silent seam between them.
  const overlap = 1.2;
  const slots = Math.ceil(d / mood.chordSeconds);

  for (let slot = 0; slot < slots; slot++) {
    const at = slot * mood.chordSeconds;
    const chord = mood.progression[slot % mood.progression.length];
    // A little longer than its slot, so it is still sounding as the next enters.
    const len = Math.min(mood.chordSeconds + overlap, d - at);
    if (len <= 0.3) break;

    chord.forEach((step, voice) => {
      const hz = semitone(mood.root, step);
      inputs.push("-f", "lavfi", "-i", `sine=frequency=${hz.toFixed(3)}:duration=${len.toFixed(3)}`);
      // The top voice is quietest: a pad is felt through its root, not its top.
      const level = [0.5, 0.32, 0.2][voice] ?? 0.2;
      const rise = Math.min(1.4, len * 0.45);
      const fall = Math.min(1.6, len * 0.5);
      parts.push(
        `[${idx}]volume=${level},` +
          `afade=t=in:st=0:d=${rise.toFixed(3)},` +
          `afade=t=out:st=${(len - fall).toFixed(3)}:d=${fall.toFixed(3)},` +
          `adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[v${idx}]`,
      );
      voices.push(`[v${idx}]`);
      idx++;
    });
  }

  // A breath of filtered noise so the pad has air around it rather than
  // sounding like a synthesizer alone in a dry room.
  inputs.push("-f", "lavfi", "-i", `anoisesrc=d=${d}:c=pink:a=0.04:seed=7`);
  parts.push(`[${idx}]lowpass=f=620,volume=0.30[air]`);
  voices.push("[air]");
  idx++;

  // Everything above 1.1 kHz belongs to the consonants that carry speech
  // intelligibility, so the bed is not allowed up there at all.
  parts.push(
    `${voices.join("")}amix=inputs=${voices.length}:normalize=0[mix]`,
    // Filter first, measure second: loudnorm should judge what will actually be
    // heard, not the low end that is about to be removed. The fades come after
    // the measurement so the normaliser cannot undo them.
    `[mix]lowpass=f=1100,highpass=f=55,` +
      `afade=t=in:st=0:d=2,` +
      `afade=t=out:st=${(d - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[bed]`,
  );

  // Pass one: the pad itself, at whatever level the synthesis happened to land
  // on. Written to a scratch file rather than piped, because the level has to
  // be measured off a complete file before the gain can be known.
  const raw = `${out}.raw.wav`;
  await ffmpeg([
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[bed]",
    "-ar", "44100", "-ac", "1",
    "-t", String(d),
    raw,
  ]);

  // Pass two: correct the level to the target, then duck.
  //
  // `loudnorm` would be the obvious tool and is the wrong one here: its
  // lookahead buffer swallows the last seconds of the stream, which on a
  // thirty-second bed cost two and a half seconds of music at the end of the
  // video. Measuring the finished file and applying a plain gain is exact,
  // deterministic, and cannot shorten anything.
  const gainDb = +(BED_MEAN_DB - (await meanLevelDb(raw))).toFixed(2);

  const second: string[] = ["-i", raw];
  const chain: string[] = [`[0]volume=${gainDb}dB[lvl]`];
  let last = "[lvl]";

  if (opts.voicePath && fs.existsSync(opts.voicePath)) {
    // The narration starts after the intro card, so the key has to be shifted
    // by the same offset or the bed ducks in the wrong places.
    const offsetMs = Math.round((opts.voiceOffsetSec ?? 0) * 1000);
    second.push("-i", opts.voicePath);
    // Padded with silence past the end of the narration, because
    // `sidechaincompress` ends when its *shortest* input ends. Without this the
    // bed is truncated to the length of the voice — so the outro tail, which is
    // exactly where the call-to-action card sits, played in silence.
    chain.push(`[1]adelay=${offsetMs}|${offsetMs},apad[key]`);
    // Gentle and slow. A hard ratio with a fast release pumps audibly, which is
    // worse than no ducking at all — and once the bed is already 16 dB under
    // the voice, it only needs to step back a few more to vanish behind a
    // sentence. 500ms lets it return between sentences, not between words.
    chain.push(
      `${last}[key]sidechaincompress=threshold=0.08:ratio=4:attack=20:release=500:makeup=1[ducked]`,
    );
    last = "[ducked]";
  }

  await ffmpeg([
    ...second,
    "-filter_complex", chain.join(";"),
    "-map", last,
    "-ar", "44100", "-ac", "1",
    "-t", String(d),
    out,
  ]);

  await fs.promises.rm(raw, { force: true });
}

/** The moods, for tests and for anything that wants to name them. */
export const MUSIC_MOODS = MOODS;
