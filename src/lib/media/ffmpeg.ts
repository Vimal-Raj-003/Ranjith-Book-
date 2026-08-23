import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

import { renderPad, levelAndFade, toWav, type MusicMood } from "./music-synth";

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
 * Broadcast-style voice master: remove rumble, cut boxiness, add body and
 * presence so the read projects, tame sibilance, then even out and limit the
 * level. Targets -16 LUFS, which is what YouTube and Instagram normalize to —
 * raising that target only invites their normalizer to turn it back down and
 * costs us headroom for nothing.
 */
export async function masterVoice(input: string, out: string) {
  await ffmpeg([
    "-i", input,
    "-af",
    [
      "highpass=f=85",                                  // rumble and plosives
      "equalizer=f=250:t=q:w=1.0:g=-2",                 // boxiness
      "equalizer=f=1800:t=q:w=1.4:g=1.5",               // body/authority, a bolder read
      "equalizer=f=3200:t=q:w=1.2:g=3.5",               // presence, consonant clarity
      "equalizer=f=6800:t=q:w=2.0:g=-3",                // de-ess (bumped: bigger presence lift + denser compression bring sibilance back up)
      "acompressor=threshold=-20dB:ratio=3.5:attack=8:release=180",
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


/**
 * Where the bed sits before it ducks, in LUFS.
 *
 * The narration is mastered to -16 LUFS. At -32 the bed sat 16 dB under it —
 * effectively inaudible — which is exactly the operator's complaint: "the
 * music cannot be heard." -22 puts it about 6 dB under the voice, roughly half
 * its perceived loudness, which is what the operator asked for. Measuring to a
 * target rather than applying a guessed dB trim is what makes the four moods
 * land at the same perceived level — trimmed by hand they differed by 9 dB,
 * because a mood with longer chords is quieter in RMS terms while peaking
 * identically.
 */
const BED_MEAN_DB = -22;

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

  // Pass one: the pad itself, synthesized directly and levelled arithmetically.
  //
  // This used to be an ffmpeg filter graph: one `sine` input per chord voice,
  // each delayed with `adelay`, all mixed with `amix`. At a real video length
  // that is ~67 inputs, and it raced — the same command produced a correct bed
  // on one run and a bed that was loud for eight seconds and then digitally
  // silent for the remaining ninety on the next. See `music-synth.ts` for the
  // full account. Nothing about the sound has changed; only how it is built.
  const pad = levelAndFade(renderPad(d, mood), BED_MEAN_DB, d);
  const raw = `${out}.raw.wav`;
  await fs.promises.writeFile(raw, toWav(pad));

  // Pass two: duck the bed against the narration. This stays in ffmpeg because
  // sidechain compression genuinely is its job — and this graph has two inputs,
  // not sixty-seven.
  if (!opts.voicePath || !fs.existsSync(opts.voicePath)) {
    // Nothing to duck against: the levelled pad IS the bed.
    await fs.promises.rename(raw, out);
    return;
  }

  // The narration starts after the intro card, so the key has to be shifted
  // by the same offset or the bed ducks in the wrong places.
  const offsetMs = Math.round((opts.voiceOffsetSec ?? 0) * 1000);
  await ffmpeg([
    "-i", raw,
    "-i", opts.voicePath,
    "-filter_complex",
    // Padded with silence past the end of the narration, because
    // `sidechaincompress` ends when its *shortest* input ends. Without this the
    // bed is truncated to the length of the voice — so the outro tail, which is
    // exactly where the call-to-action card sits, played in silence.
    `[1]adelay=${offsetMs}|${offsetMs},apad[key];` +
      // Gentle and slow. A hard ratio with a fast release pumps audibly, which
      // is worse than no ducking at all. 500ms lets the bed return between
      // sentences, not between words. The ratio is 6 rather than the original
      // 4 because the bed now sits ~6 dB under the voice instead of ~16: at
      // the old level a gentler duck was enough, at this one it is not.
      `[0][key]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=500:makeup=1[ducked]`,
    "-map", "[ducked]",
    "-ar", "44100", "-ac", "1",
    "-t", String(d),
    out,
  ]);

  await fs.promises.rm(raw, { force: true });
}

/** The moods, for tests and for anything that wants to name them. */
export const MUSIC_MOODS = MOODS;
