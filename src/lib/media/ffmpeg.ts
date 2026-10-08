import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

import { renderPad, levelAndFade, toWav } from "./music-synth";
import { MOODS } from "./moods";
import { abortOpts } from "../cancel";

const execRaw = promisify(execFile);
/** Every ffmpeg/ffprobe call in this file goes through here, so honouring an
 *  episode cancellation is one change instead of one at each call site. */
function exec(
  bin: string,
  args: string[],
  opts: { maxBuffer?: number; windowsHide?: boolean; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execRaw(bin, args, { ...opts, ...abortOpts() });
}

function resolveBin(name: "ffmpeg" | "ffprobe"): string {
  // Windows binaries carry the .exe suffix; checking the bare name only would
  // walk straight past a perfectly good tools/bin download and spawn ENOENT.
  const suffixes = process.platform === "win32" ? [".exe", ""] : [""];
  for (const suffix of suffixes) {
    const local = path.join(process.cwd(), "tools", "bin", name + suffix);
    if (fs.existsSync(local)) return local;
  }
  const env = name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  return env || name;
}

export const FFMPEG = resolveBin("ffmpeg");
export const FFPROBE = resolveBin("ffprobe");

export async function ffmpeg(args: string[]) {
  return exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 1024 * 1024 * 32,
    // Console windows on Windows, one per invocation — see `hf()` in video/render.ts.
    windowsHide: true,
  });
}

/**
 * Measured silences in an audio file: stretches of at least `minDur` seconds
 * below `noiseDb`. Evidence of where speech is NOT, used to correct word
 * timing at the edges of speech (see `snapToSound` in word-timing.ts).
 */
export async function detectSilences(
  file: string,
  noiseDb = -35,
  minDur = 0.15,
): Promise<{ start: number; end: number }[]> {
  // silencedetect reports on stderr at info level, so this does not go
  // through `ffmpeg()`, which runs at -loglevel error.
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 32, windowsHide: true },
  );
  const out: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Math.max(0, parseFloat(s[1]));
    if (e && start !== null) {
      out.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  // silencedetect reports one pause as two back-to-back silences where the
  // narration's clips were joined (e.g. 41.502–42.455 then 42.456–43.371).
  // It is one pause: treated as two, a word pinned inside it was moved only
  // to the join, still a second before the voice.
  const merged: { start: number; end: number }[] = [];
  for (const q of out) {
    const last = merged[merged.length - 1];
    if (last && q.start - last.end < 0.03) last.end = Math.max(last.end, q.end);
    else merged.push({ ...q });
  }
  return merged;
}

export async function durationOf(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ], { windowsHide: true });
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

// The mood registry (`MOODS`) lives in `./moods`, as pure data, so a client
// component can name the moods without importing this file and with it
// `node:child_process`. It is re-exported as `MUSIC_MOODS` at the bottom.


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

/**
 * How hard the bed steps back under the narration. `normal` is the compressor the
 * bed has always had, so a render that does not choose is unchanged; `off` skips
 * the second ffmpeg pass altogether (see `generateMusicBed`).
 *
 * What the other two are for: against a speech-like key at about -17 dBFS RMS,
 * measured, light takes the bed down about 5 dB under a phrase, normal about 10
 * and strong about 15. (Real narration differs in the particulars; the order and
 * the spacing are what the profiles are for, and a test holds the order.) Attack
 * and release are the same for all of them (see the comment on the filter below):
 * a hard ratio with a fast release pumps, and a strong duck is not a licence to.
 */
export const DUCK_PROFILES = {
  light: { threshold: 0.08, ratio: 3 },
  normal: { threshold: 0.05, ratio: 6 },
  strong: { threshold: 0.03, ratio: 10 },
} as const;

export type MusicDuck = "off" | keyof typeof DUCK_PROFILES;

/**
 * The compressor for one duck setting, as ffmpeg spells it. A function of its own
 * so a test can hold `normal` to the exact string the bed has always used: the
 * ducked pass is the one part of the bed that cannot be compared byte for byte
 * between runs, or between builds. The same graph on the same inputs sometimes
 * comes out a fraction of a second SHORT -- the tail is cut at a variable whole
 * number of ffmpeg frames, a flush race at end of stream (measured: of 24 runs,
 * 21 were the full length and 3 were up to about 0.2 s short). It is the tail and
 * not the start: the first samples were silent in every run, and the loss falls
 * inside the closing fade-out, where the bed is a few percent of its level.
 * So the graph's inputs are what is pinned instead. (`duck: "off"` writes the
 * synthesized pad directly and has no such variance.)
 */
export function duckFilter(duck: Exclude<MusicDuck, "off">): string {
  const { threshold, ratio } = DUCK_PROFILES[duck];
  return `sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=20:release=500:makeup=1`;
}

/** Mean level of a file in dB, as ffmpeg measures it. */
export async function meanLevelDb(file: string): Promise<number> {
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 8, windowsHide: true },
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
 * Deterministic for a given mood, duration and settings, so a re-render is
 * identical -- bar the length of the ducked pass's tail, which ffmpeg itself cuts
 * a little short on some runs, inside the closing fade (see `duckFilter`).
 *
 * The three controls are the operator's, and each defaults to what the bed was
 * before it had controls: `intensity` 1 (the pad plus a bass; 0 is the pad alone,
 * which is the old sound to the byte), `level` -22 dB, `duck` normal.
 */
export async function generateMusicBed(
  durationSec: number,
  out: string,
  opts: {
    style?: string;
    voicePath?: string;
    voiceOffsetSec?: number;
    intensity?: number;
    level?: number;
    duck?: MusicDuck;
  } = {},
) {
  const d = Math.max(1, +durationSec.toFixed(3));
  const mood = MOODS[opts.style ?? "terminal"] ?? MOODS.terminal;
  const level = Number.isFinite(opts.level) ? (opts.level as number) : BED_MEAN_DB;
  // An id this build does not have is the usual duck rather than none: a bed with
  // no ducking at all is the more surprising of the two mistakes. (`hasOwn`, not
  // `in`: "constructor" is `in` every object.)
  const duck: MusicDuck =
    opts.duck === "off" || (opts.duck !== undefined && Object.hasOwn(DUCK_PROFILES, opts.duck))
      ? (opts.duck as MusicDuck)
      : "normal";

  // Pass one: the pad itself, synthesized directly and levelled arithmetically.
  //
  // This used to be an ffmpeg filter graph: one `sine` input per chord voice,
  // each delayed with `adelay`, all mixed with `amix`. At a real video length
  // that is ~67 inputs, and it raced — the same command produced a correct bed
  // on one run and a bed that was loud for eight seconds and then digitally
  // silent for the remaining ninety on the next. See `music-synth.ts` for the
  // full account. Nothing about the sound has changed; only how it is built.
  const pad = levelAndFade(renderPad(d, mood, opts.intensity), level, d);
  const raw = `${out}.raw.wav`;
  await fs.promises.writeFile(raw, toWav(pad));

  // Pass two: duck the bed against the narration. This stays in ffmpeg because
  // sidechain compression genuinely is its job — and this graph has two inputs,
  // not sixty-seven.
  if (duck === "off" || !opts.voicePath || !fs.existsSync(opts.voicePath)) {
    // Nothing to duck against, or the operator turned ducking off: the levelled
    // pad IS the bed.
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
      // (That is `normal`. `light` and `strong` move the threshold and the ratio
      // and nothing else; see `DUCK_PROFILES`.)
      `[0][key]${duckFilter(duck)}[ducked]`,
    "-map", "[ducked]",
    "-ar", "44100", "-ac", "1",
    "-t", String(d),
    out,
  ]);

  await fs.promises.rm(raw, { force: true });
}

/** The moods, for tests and for anything that wants to name them. */
export const MUSIC_MOODS = MOODS;
