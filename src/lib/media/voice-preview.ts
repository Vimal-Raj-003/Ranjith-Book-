import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "../paths";
import { POCKET_VOICES, synthPocket } from "./pocket-tts";
import { resolveEdgeTtsBin, synthEdgeNeural } from "./edge-tts";
import { isGeminiStudioVoice, resolveGeminiTtsApiKey, synthGeminiStudioVoice } from "./gemini-tts";
import { masterVoice } from "./ffmpeg";

/**
 * A ~15-second viral narration sample, identical across all 12 voices so two
 * previews differ only by the voice being auditioned — long enough to judge
 * opening hook punch, contrast cadence, natural pauses, and closing warmth.
 *
 * Clips are cached by voice id alone, so editing this line means clearing (or
 * re-synthesising) the `voice-preview` directory under the work root.
 */
export const PREVIEW_LINE =
  "Most people stay busy all day and still feel behind. Focus is not working longer hours. It is choosing one meaningful task and guarding your attention until it is done. Here is the shift: do less, finish deeper, and save this reminder for tomorrow morning.";

const PREVIEW_DIR = path.join(WORK_ROOT, "voice-preview");

/** Under this a file is a stub or a truncation, not audio; `synthPocket` refuses it the same way. A WAV header is also checked: see `isCachedClip`. */
const MIN_CLIP_BYTES = 1024;

export function previewPath(voiceId: string): string {
  return path.join(PREVIEW_DIR, `${voiceId}.wav`);
}

export type PreviewFailure = {
  ok: false;
  code: "bad_voice" | "voice_unavailable";
  error: string;
};
export type PreviewResult = { ok: true; path: string } | PreviewFailure;

/** `synthPocket`'s shape, so a test can hand in a stand-in that never touches the TTS server. */
type Synth = (text: string, out: string, voice: string) => Promise<void>;

/**
 * One synthesis per voice at a time. The Pocket TTS server is shared with
 * whatever render is running, so two requests for the same clip (a retry after
 * the browser gave up waiting on a cold start, a second tab) must join the one
 * already under way rather than queue a second copy of the same work behind it.
 * It also keeps a single writer per file, which the rename below relies on.
 */
const inflight = new Map<string, Promise<PreviewResult>>();

/**
 * Synthesize (or reuse) the preview clip for one voice.
 *
 * Deliberately knows nothing about episodes. It creates no rows, touches no
 * pipeline, and cannot start a render — previewing a voice must cost one
 * short synthesis and nothing else.
 *
 * The clip is cached by voice id: the line is fixed, so the same voice always
 * produces the same audio, and auditioning twelve voices twice costs twelve
 * syntheses rather than twenty-four.
 */
/**
 * Default preview synthesizer: uses the exact same Studio Neural Edge-TTS +
 * broadcast `-16 LUFS` mastering chain (`masterVoice`) that finished videos use
 * in `tts.ts`, with automatic offline fallback to Pocket TTS.
 */
async function defaultPreviewSynth(text: string, out: string, voice: string): Promise<void> {
  if (process.env.BOOKREEL_AUDIO_TESTS !== "1" && isGeminiStudioVoice(voice)) {
    const geminiKey = await resolveGeminiTtsApiKey();
    if (geminiKey) {
      const raw = `${out}.gemini.raw.wav`;
      const mastered = `${out}.gemini.master.wav`;
      try {
        await synthGeminiStudioVoice(text, raw, voice, geminiKey);
        await masterVoice(raw, mastered);
        await fs.rename(mastered, out);
        return;
      } catch {
        /* fall through to Edge-TTS / Pocket TTS */
      } finally {
        await fs.rm(raw, { force: true }).catch(() => {});
        await fs.rm(mastered, { force: true }).catch(() => {});
      }
    }
  }
  if (process.env.BOOKREEL_AUDIO_TESTS !== "1" && (await resolveEdgeTtsBin())) {
    const raw = `${out}.raw.wav`;
    const mastered = `${out}.master.wav`;
    try {
      await synthEdgeNeural(text, raw, voice);
      await masterVoice(raw, mastered);
      await fs.rename(mastered, out);
      return;
    } catch {
      /* fall through to offline Pocket TTS */
    } finally {
      await fs.rm(raw, { force: true }).catch(() => {});
      await fs.rm(mastered, { force: true }).catch(() => {});
    }
  }
  await synthPocket(text, out, voice);
}

export async function previewVoice(
  voiceId: unknown,
  synth: Synth = defaultPreviewSynth,
): Promise<PreviewResult> {
  // Checked against the catalogue before anything else: the id is joined into a
  // path below, and a voice this build does not have must never reach the TTS
  // server as a request for a speaker (or a sample URL, which Pocket accepts).
  if (typeof voiceId !== "string" || !POCKET_VOICES.some((v) => v.id === voiceId)) {
    return { ok: false, code: "bad_voice", error: "That is not a voice this build has." };
  }

  const running = inflight.get(voiceId);
  if (running) return running;
  const work = clipFor(voiceId, synth).finally(() => inflight.delete(voiceId));
  inflight.set(voiceId, work);
  return work;
}

/**
 * Is the file already at `file` a clip worth serving?
 *
 * Size alone is not enough. The cache never re-synthesises a hit, so whatever
 * passes this is what every later preview plays: a 4 KiB file of anything but
 * audio was served as `audio/wav` forever, and the browser refused it. A WAV
 * starts `RIFF....WAVE`, so those twelve bytes are read too. Any failure to
 * look -- missing, unreadable, short -- is "no", never an error: a bad cache
 * entry degrades to making the clip again.
 */
async function isCachedClip(file: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    if ((await fs.stat(file)).size < MIN_CLIP_BYTES) return false;
    handle = await fs.open(file, "r");
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return (
      bytesRead === head.length &&
      head.toString("latin1", 0, 4) === "RIFF" &&
      head.toString("latin1", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function clipFor(voiceId: string, synth: Synth): Promise<PreviewResult> {
  const out = previewPath(voiceId);
  if (await isCachedClip(out)) return { ok: true, path: out };

  // Written beside the clip and renamed into place. The cache check above is
  // all that stands between a half-written file and the listener, and a
  // process killed mid-write would otherwise leave a truncated clip that
  // passes it (a header and enough bytes are all it looks for) and plays
  // clipped for every later preview of that voice.
  const scratch = `${out}.part`;
  try {
    await fs.mkdir(PREVIEW_DIR, { recursive: true });
    await synth(PREVIEW_LINE, scratch, voiceId);
    await fs.rename(scratch, out);
    return { ok: true, path: out };
  } catch (err) {
    await fs.rm(scratch, { force: true }).catch(() => {});
    // A missing install, a server that will not boot, a synthesis that fails:
    // all of these are "you cannot hear this right now", which is a toast, not
    // a broken inspector.
    return {
      ok: false,
      code: "voice_unavailable",
      error: err instanceof Error && err.message ? err.message : "The voice engine is unavailable.",
    };
  }
}
