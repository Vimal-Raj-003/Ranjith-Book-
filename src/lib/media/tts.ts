import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg, durationOf, concatWithGaps, masterVoice } from "./ffmpeg";
import { synthPocket, DEFAULT_POCKET_VOICE } from "./pocket-tts";
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
}

const GAP = 0.34; // pause between beats
const LEAD = 0.09; // silence before speech, so no word onset is clipped
const TAIL = 0.22; // silence after speech, so nothing is cut short

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
 * Pad each beat and even out its level. Padding protects the first and last
 * syllables; per-beat loudness keeps one loud sentence from burying a quiet one
 * before the final master runs.
 */
async function conditionBeat(input: string, out: string) {
  await ffmpeg([
    "-i", input,
    "-af",
    [
      `adelay=${Math.round(LEAD * 1000)}`,
      `apad=pad_dur=${TAIL}`,
      "loudnorm=I=-18:TP=-2.0:LRA=11",
    ].join(","),
    "-ar", "44100", "-ac", "1",
    out,
  ]);
}

export async function synthesizeVoiceover(
  beatTexts: string[],
  workDir: string,
  voiceOverride?: string | null,
): Promise<VoiceoverResult> {
  await fs.mkdir(workDir, { recursive: true });

  // Pocket TTS is the default: a neural voice that runs locally with no key.
  const provider = ((await getSetting("voiceProvider")) ?? "pocket") as VoiceProvider;
  const elevenKey = (await getSetting("elevenLabsApiKey")) ?? process.env.ELEVENLABS_API_KEY ?? "";
  const openaiKey = (await getSetting("openaiApiKey")) ?? process.env.OPENAI_API_KEY ?? "";
  const voiceId = voiceOverride || (await getSetting("voiceId")) || "";

  const files: string[] = [];
  for (let i = 0; i < beatTexts.length; i++) {
    // A long episode is many beats, each its own TTS call; checked here too
    // so a cancellation between two calls is not left waiting for whichever
    // one happens to be in flight when the operator clicked cancel.
    throwIfCancelled();
    const n = String(i).padStart(2, "0");
    const spoken = path.join(workDir, `beat-${n}-raw.wav`);
    const ready = path.join(workDir, `beat-${n}.wav`);
    const text = beatTexts[i];

    if (provider === "pocket") await synthPocket(text, spoken, voiceId || DEFAULT_POCKET_VOICE);
    else if (provider === "elevenlabs" && elevenKey) await synthElevenLabs(text, spoken, elevenKey, voiceId);
    else if (provider === "openai" && openaiKey) await synthOpenAI(text, spoken, openaiKey, voiceId);
    else await synthSystem(text, spoken, voiceId);

    await conditionBeat(spoken, ready);
    await fs.rm(spoken, { force: true });
    files.push(ready);
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

  return { audioPath: mastered, beats, totalDuration: await durationOf(mastered) };
}
