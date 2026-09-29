/**
 * When every word of the narration is actually spoken.
 *
 * Runs `align.py` (faster-whisper, word timestamps) over the MASTERED voice
 * track — the audio the viewer hears — one beat window at a time, then matches
 * what it heard to the approved script (`word-timing.ts`). Subtitles,
 * highlights and beat windows are all built from the result.
 *
 * The fallback is explicit. If faster-whisper is not installed, or fails, the
 * old estimate (letters per word inside each beat's measured window) is used,
 * `source` says "estimated", and a note says why. A beat the recogniser could
 * not match at all is estimated on its own and named in a note. Nothing
 * estimated is ever labelled as coming from the audio.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CACHE_ROOT } from "../paths";
import { buildCaptions, buildCaptionsFromWords, type CaptionLine } from "./captions";
import { timeBeat, speechSpan, snapToSound, fitToSound, soundBounds, type AsrWord, type Silence, type TimedWord } from "./word-timing";
import { detectSilences } from "./ffmpeg";
import type { BeatAudio, VoiceoverResult } from "./tts";
import { abortOpts, wasCancelled, CancelledError } from "../cancel";

/** The speech model. `BOOKREEL_ALIGN_MODEL` overrides it (e.g. "small.en"); read per call, not at import. */
export function alignModel(): string {
  return process.env.BOOKREEL_ALIGN_MODEL?.trim() || "base.en";
}
const ALIGN_TIMEOUT_MS = 10 * 60_000;
const SCRIPT = path.join(process.cwd(), "src", "lib", "media", "align.py");
/** Below this share of a beat's words matched, the beat's timing is noted as weak. */
const WEAK_MATCH = 0.6;

export type NarrationTimingSource = "audio" | "mixed" | "estimated";

export interface BeatTimingSummary {
  index: number;
  matched: number;
  total: number;
  source: "audio" | "estimated";
}

export interface NarrationTiming {
  /** "audio": every beat timed from the recording. "mixed": some beats estimated. "estimated": none from audio. */
  source: NarrationTimingSource;
  model: string | null;
  words: TimedWord[];
  captions: CaptionLine[];
  /** The input beats, with speechStart/speechEnd moved to the first and last spoken word where the audio gave them. */
  beats: BeatAudio[];
  perBeat: BeatTimingSummary[];
  notes: string[];
}

/** The alignment environment's Python, or null when it has not been set up. */
export function alignPython(): string | null {
  const override = process.env.BOOKREEL_ALIGN_PYTHON?.trim();
  if (override) return override;
  const venv = path.join(CACHE_ROOT, "py", "align");
  const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  return existsSync(py) ? py : null;
}

interface AlignOutput {
  model: string;
  duration: number;
  windows: { start: number; end: number; words: AsrWord[] }[];
}

async function runAlign(python: string, job: object, workDir: string): Promise<AlignOutput> {
  const jobFile = path.join(workDir, "align-job.json");
  const outFile = path.join(workDir, "align-out.json");
  await fs.writeFile(jobFile, JSON.stringify(job));
  const cancel = abortOpts();
  if (cancel.signal?.aborted) throw new CancelledError();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [SCRIPT, jobFile, outFile], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...cancel,
    });
    let failure: string | null = null;
    let stderr = "";
    let buf = "";
    const timer = setTimeout(() => {
      failure = `timed out after ${ALIGN_TIMEOUT_MS / 60_000} minutes`;
      child.kill("SIGKILL");
    }, ALIGN_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { type: string; message?: string };
          if (msg.type === "error") failure = msg.message ?? "failed";
        } catch {
          /* not a protocol line */
        }
      }
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-1500)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(wasCancelled() ? new CancelledError() : new Error(`could not start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (wasCancelled()) reject(new CancelledError());
      else if (failure) reject(new Error(failure));
      else if (code !== 0) reject(new Error(`exited ${code}: ${stderr.trim().split("\n").slice(-1)[0] ?? ""}`));
      else resolve();
    });
  });
  return JSON.parse(await fs.readFile(outFile, "utf8")) as AlignOutput;
}

/** The old estimate, labelled as such. */
function estimated(voice: VoiceoverResult, notes: string[]): NarrationTiming {
  const captions = buildCaptions(voice.beats);
  const words: TimedWord[] = [];
  for (const line of captions) {
    for (const w of line.words) {
      const index = words.filter((x) => x.beatIndex === line.beatIndex).length;
      words.push({ word: w.word, start: w.start, end: w.end, beatIndex: line.beatIndex, index, source: "estimated" });
    }
  }
  return {
    source: "estimated",
    model: null,
    words,
    captions,
    beats: voice.beats,
    perBeat: voice.beats.map((b) => ({ index: b.index, matched: 0, total: words.filter((w) => w.beatIndex === b.index).length, source: "estimated" })),
    notes,
  };
}

export async function timeNarration(voice: VoiceoverResult, workDir: string): Promise<NarrationTiming> {
  const python = alignPython();
  if (!python) {
    return estimated(voice, [
      "Subtitle and highlight timing is ESTIMATED, not taken from the audio: word timing (faster-whisper) is not set up on this machine. Run `npm run setup:align`.",
    ]);
  }

  let out: AlignOutput;
  try {
    out = await runAlign(
      python,
      {
        audio: voice.audioPath,
        model: alignModel(),
        modelDir: path.join(CACHE_ROOT, "models", "whisper"),
        windows: voice.beats.map((b) => ({ start: b.start, end: b.end, prompt: b.text })),
      },
      workDir,
    );
  } catch (err) {
    // A cancellation is not "word timing failed, fall back to an estimate" —
    // it is the operator stopping the run, and must keep propagating so the
    // pipeline does not spend the render step on a video nobody asked to
    // keep waiting for.
    if (err instanceof CancelledError) throw err;
    return estimated(voice, [
      `Subtitle and highlight timing is ESTIMATED, not taken from the audio: word timing failed (${err instanceof Error ? err.message : String(err)}).`,
    ]);
  }

  const notes: string[] = [];
  const words: TimedWord[] = [];
  const perBeat: BeatTimingSummary[] = [];
  // Measured silences in the same recording, to pull word edges out of
  // pauses where the recogniser's timestamps are loosest (see snapToSound).
  // Best-effort: without them the recogniser's own times stand.
  const quiet = await detectSilences(voice.audioPath).catch(() => [] as Silence[]);
  const beats: BeatAudio[] = voice.beats.map((b, i) => {
    const heard = out.windows[i]?.words ?? [];
    const timing = timeBeat(b.index, b.text, heard, { start: b.start, end: Math.min(b.end, voice.totalDuration) });
    // Put the beat's first and last word edges on its measured sound (the
    // recogniser is loosest there), then pull any other word edge out of a
    // measured pause. Both use the same recording's silences; the words'
    // own times are otherwise kept. See fitToSound for the measurements.
    if (timing.matched > 0) {
      const bounds = soundBounds({ start: b.start, end: Math.min(b.end, voice.totalDuration) }, quiet);
      timing.words = snapToSound(fitToSound(timing.words, bounds), quiet);
    }
    words.push(...timing.words);
    const fromAudio = timing.matched > 0;
    perBeat.push({ index: b.index, matched: timing.matched, total: timing.total, source: fromAudio ? "audio" : "estimated" });
    if (!fromAudio) {
      notes.push(`Beat ${i + 1}: none of its words could be matched in the audio, so its subtitle and highlight timing is ESTIMATED.`);
      return b;
    }
    if (timing.matched / timing.total < WEAK_MATCH) {
      notes.push(`Beat ${i + 1}: only ${timing.matched} of ${timing.total} words were recognised; the rest are placed between them.`);
    }
    const span = speechSpan(timing.words)!;
    return { ...b, speechStart: span.start, speechEnd: span.end };
  });

  const estimatedBeats = perBeat.filter((p) => p.source === "estimated").length;
  return {
    source: estimatedBeats === 0 ? "audio" : estimatedBeats === perBeat.length ? "estimated" : "mixed",
    model: out.model,
    words,
    captions: buildCaptionsFromWords(words),
    beats,
    perBeat,
    notes,
  };
}

/** What is stored on the Episode: compact, and explicit about where each time came from. */
export function serializeTiming(t: NarrationTiming): string {
  return JSON.stringify({
    source: t.source,
    model: t.model,
    perBeat: t.perBeat,
    words: t.words.map((w) => ({ w: w.word, s: +w.start.toFixed(3), e: +w.end.toFixed(3), b: w.beatIndex, i: w.index, src: w.source })),
  });
}
