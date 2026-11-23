import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg, durationOf, concatWithGaps, masterVoice } from "./ffmpeg";
import { synthPocket, DEFAULT_POCKET_VOICE } from "./pocket-tts";
import { synthEdgeNeural, resolveEdgeTtsBin } from "./edge-tts";
import { getSetting } from "../db";
import { abortOpts, currentSignal, throwIfCancelled } from "../cancel";

const exec = promisify(execFile);

export type VoiceProvider = "pocket" | "system" | "elevenlabs" | "openai";

export interface BeatAudio {
  index: number;
  text: string;
  file: string;
  /** Clip window inside the finished track, including silence padding. */
  start: number;
  end: number;
  /** Window in which speech is actually audible — what caption timing uses. */
  speechStart: number;
  speechEnd: number;
}

export interface VoiceoverResult {
  audioPath: string;
  beats: BeatAudio[];
  totalDuration: number;
  /**
   * The voice and engine this recording was made with, as resolved when it
   * started -- what the episode row records, rather than what the setting says
   * by the time anyone reads it. Empty `voiceId` means the provider chose its
   * own default (see `resolveVoice`).
   */
  voiceId: string;
  provider: VoiceProvider;
}

const GAP = 0.18; // crisp breath between beats — tight enough to hold Shorts retention
const LEAD = 0.06; // silence before speech, so no word onset is clipped
const TAIL = 0.14; // silence after speech, so nothing is cut short

async function synthSystem(text: string, out: string, voice: string) {
  // macOS `say`: free, offline, no key required. There is no Linux equivalent,
  // so a server install has to use Pocket TTS rather than silently fall back.
  if (process.platform !== "darwin") {
    throw new Error(
      "The system voice needs macOS. Install Pocket TTS (npm run setup:voice) and pick it under Settings → Voice.",
    );
  }
  const raw = out.replace(/\.wav$/, ".raw.wav");
  await exec(
    "say",
    ["-v", voice || "Samantha", "-r", "172", "-o", raw, "--file-format=WAVE", "--data-format=LEI16@22050", text],
    abortOpts(),
  );
  await ffmpeg(["-i", raw, "-ar", "44100", "-ac", "1", out]);
  await fs.rm(raw, { force: true });
}

async function synthElevenLabs(text: string, out: string, apiKey: string, voiceId: string) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || "21m00Tcm4TlvDq8ikWAM"}`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
      }),
      signal: currentSignal(),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const mp3 = out.replace(/\.wav$/, ".mp3");
  await fs.writeFile(mp3, Buffer.from(await res.arrayBuffer()));
  await ffmpeg(["-i", mp3, "-ar", "44100", "-ac", "1", out]);
  await fs.rm(mp3, { force: true });
}

async function synthOpenAI(text: string, out: string, apiKey: string, voice: string) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: voice || "onyx", input: text, response_format: "wav" }),
    signal: currentSignal(),
  });
  if (!res.ok) throw new Error(`OpenAI TTS error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = out.replace(/\.wav$/, ".raw.wav");
  await fs.writeFile(raw, Buffer.from(await res.arrayBuffer()));
  await ffmpeg(["-i", raw, "-ar", "44100", "-ac", "1", out]);
  await fs.rm(raw, { force: true });
}

/**
 * Pad each beat cleanly at 44.1 kHz mono without per-beat dynamic `loudnorm`
 * (which switches to short-window gain riding on <3s beats and alters vocal
 * timbre between short and long sentences). Unified loudness & EQ mastering
 * runs once across the full joined track in `masterVoice`.
 */
async function conditionBeat(input: string, out: string) {
  await ffmpeg([
    "-i", input,
    "-af",
    [
      `adelay=${Math.round(LEAD * 1000)}`,
      `apad=pad_dur=${TAIL}`,
    ].join(","),
    "-ar", "44100", "-ac", "1",
    out,
  ]);
}

/**
 * Which engine and which voice this render will use.
 *
 * Extracted from `synthesizeVoiceover` so the answer can be recorded on the
 * episode and asserted in a test without synthesizing audio. The fallback
 * chain is unchanged: an explicit override, then the stored setting, then
 * the engine's own default.
 *
 * Pocket's default is only a fallback for Pocket. Another provider with no
 * stored voice gets `""`, which its synth function turns into that provider's
 * own default -- handing it "charles" would ask ElevenLabs for a voice it does
 * not have. Callers that persist the id must treat `""` as "not recorded".
 */
export async function resolveVoice(
  voiceOverride?: string | null,
): Promise<{ provider: VoiceProvider; voiceId: string }> {
  const provider = ((await getSetting("voiceProvider")) ?? "pocket") as VoiceProvider;
  const stored = voiceOverride || (await getSetting("voiceId")) || "";
  const voiceId = stored || (provider === "pocket" ? DEFAULT_POCKET_VOICE : "");
  return { provider, voiceId };
}

export async function synthesizeVoiceover(
  beatTexts: string[],
  workDir: string,
  voiceOverride?: string | null,
): Promise<VoiceoverResult> {
  await fs.mkdir(workDir, { recursive: true });

  // Pocket TTS is the default: a neural voice that runs locally with no key.
  const { provider, voiceId } = await resolveVoice(voiceOverride);
  const elevenKey = (await getSetting("elevenLabsApiKey")) ?? process.env.ELEVENLABS_API_KEY ?? "";
  const openaiKey = (await getSetting("openaiApiKey")) ?? process.env.OPENAI_API_KEY ?? "";

  const useStudioEdge =
    provider === "pocket" &&
    process.env.BOOKREEL_AUDIO_TESTS !== "1" &&
    Boolean(await resolveEdgeTtsBin());

  /**
   * Episode-wide Single-Voice Lock:
   * Synthesize EVERY beat of the episode with ONE exact engine + voiceId.
   * Never fall back per beat inside the loop (which previously mixed an
   * American Edge-TTS voice and a British Pocket-TTS voice mid-video).
   * If Studio Edge-TTS fails on any beat even after retries, all partial
   * clips are discarded and the ENTIRE episode is synthesized cleanly with
   * Pocket TTS from beat 0 to beat N-1.
   */
  const synthAllBeatsWith = async (
    runBeat: (text: string, outWav: string, index: number) => Promise<void>,
  ): Promise<string[]> => {
    const outFiles: string[] = [];
    for (let i = 0; i < beatTexts.length; i++) {
      throwIfCancelled();
      const n = String(i).padStart(2, "0");
      const spoken = path.join(workDir, `beat-${n}-raw.wav`);
      const ready = path.join(workDir, `beat-${n}.wav`);
      await fs.rm(spoken, { force: true }).catch(() => {});
      await fs.rm(ready, { force: true }).catch(() => {});

      await runBeat(beatTexts[i], spoken, i);
      await conditionBeat(spoken, ready);
      await fs.rm(spoken, { force: true });
      outFiles.push(ready);
    }
    return outFiles;
  };

  let files: string[];
  if (useStudioEdge) {
    try {
      files = await synthAllBeatsWith(async (text, spoken, idx) => {
        if (idx > 0) {
          await new Promise((r) => setTimeout(r, 160));
        }
        await synthEdgeNeural(text, spoken, voiceId);
      });
    } catch (edgeErr) {
      throwIfCancelled();
      void edgeErr;
      files = await synthAllBeatsWith((text, spoken) => synthPocket(text, spoken, voiceId));
    }
  } else if (provider === "pocket") {
    files = await synthAllBeatsWith((text, spoken) => synthPocket(text, spoken, voiceId));
  } else if (provider === "elevenlabs" && elevenKey) {
    files = await synthAllBeatsWith((text, spoken) => synthElevenLabs(text, spoken, elevenKey, voiceId));
  } else if (provider === "openai" && openaiKey) {
    files = await synthAllBeatsWith((text, spoken) => synthOpenAI(text, spoken, openaiKey, voiceId));
  } else {
    files = await synthAllBeatsWith((text, spoken) => synthSystem(text, spoken, voiceId));
  }

  const joined = path.join(workDir, "voice-raw.wav");
  if (files.length === 1) await ffmpeg(["-i", files[0], "-ar", "44100", "-ac", "1", joined]);
  else await concatWithGaps(files, GAP, joined);

  const mastered = path.join(workDir, "voice.wav");
  await masterVoice(joined, mastered);

  const beats: BeatAudio[] = [];
  let cursor = 0;
  for (let i = 0; i < files.length; i++) {
    const d = await durationOf(files[i]);
    beats.push({
      index: i,
      text: beatTexts[i],
      file: files[i],
      start: cursor,
      end: cursor + d,
      speechStart: cursor + LEAD,
      speechEnd: Math.max(cursor + LEAD + 0.2, cursor + d - TAIL),
    });
    cursor += d + (i < files.length - 1 ? GAP : 0);
  }

  return { audioPath: mastered, beats, totalDuration: await durationOf(mastered), voiceId, provider };
}
