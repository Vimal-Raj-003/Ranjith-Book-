/**
 * Free Studio-Grade Neural TTS via Microsoft Edge-TTS CLI (`edge-tts`),
 * with automatic per-voice mapping from BookReel's catalog ids (`charles`,
 * `michael`, `alba`, etc.) and seamless offline fallback to Pocket TTS.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "./ffmpeg";
import { abortOpts } from "../cancel";

const exec = promisify(execFile);

/** Map BookReel's voice catalog IDs to rock-steady monolingual studio neural narrator voices (never MultilingualNeural, which shifts persona across short isolated beats). */
export const EDGE_VOICE_MAP: Readonly<Record<string, { voice: string; rate: string; pitch: string }>> = {
  // Flagship deep, warm, magnetic documentary storyteller — 100% consistent timbre across every sentence
  charles: { voice: "en-US-ChristopherNeural", rate: "+4%", pitch: "-2Hz" },
  michael: { voice: "en-US-EricNeural", rate: "+4%", pitch: "-2Hz" },
  george: { voice: "en-US-GuyNeural", rate: "+5%", pitch: "+0Hz" },
  paul: { voice: "en-US-RogerNeural", rate: "+4%", pitch: "-1Hz" },
  stuart_bell: { voice: "en-GB-RyanNeural", rate: "+4%", pitch: "-1Hz" },
  peter_yearsley: { voice: "en-US-SteffanNeural", rate: "+3%", pitch: "-2Hz" },
  alba: { voice: "en-US-AriaNeural", rate: "+4%", pitch: "+0Hz" },
  cosette: { voice: "en-GB-LibbyNeural", rate: "+5%", pitch: "+0Hz" },
  vera: { voice: "en-US-JennyNeural", rate: "+4%", pitch: "+0Hz" },
  jane: { voice: "en-US-MichelleNeural", rate: "+4%", pitch: "+0Hz" },
  eve: { voice: "en-GB-SoniaNeural", rate: "+4%", pitch: "+0Hz" },
  caro_davy: { voice: "en-AU-NatashaNeural", rate: "+5%", pitch: "+0Hz" },
};

let cachedBin: string | null | undefined;

export async function resolveEdgeTtsBin(): Promise<string | null> {
  if (process.env.BOOKREEL_DISABLE_EDGE_TTS === "1") return null;
  if (cachedBin !== undefined) return cachedBin;

  const candidates = [
    process.env.EDGE_TTS_BIN,
    "E:\\CAD\\conda\\Scripts\\edge-tts.exe",
    path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "edge-tts.exe" : "edge-tts"),
    path.join(os.homedir(), "anaconda3", "Scripts", "edge-tts.exe"),
    path.join(os.homedir(), "miniconda3", "Scripts", "edge-tts.exe"),
    process.platform === "win32" ? "edge-tts.exe" : "edge-tts",
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const bin of candidates) {
    try {
      if (bin.includes(path.sep) || bin.includes("/")) {
        if (fs.existsSync(bin)) {
          cachedBin = bin;
          return bin;
        }
        continue;
      }
      await exec(process.platform === "win32" ? "where" : "which", [bin], { windowsHide: true });
      cachedBin = bin;
      return bin;
    } catch {
      /* check next candidate */
    }
  }
  cachedBin = null;
  return null;
}

/**
 * Synthesize one beat using Studio Neural Edge-TTS into a 44.1 kHz mono WAV.
 * Retries transient WebSocket drops on the exact same neural voice before throwing,
 * so `tts.ts` can keep 100% single-speaker lock across the entire episode.
 */
export async function synthEdgeNeural(text: string, outWav: string, catalogVoiceId: string): Promise<void> {
  const bin = await resolveEdgeTtsBin();
  if (!bin) throw new Error("edge-tts binary not available");

  const preset =
    EDGE_VOICE_MAP[catalogVoiceId] ??
    (catalogVoiceId.includes("Neural") && !catalogVoiceId.includes("MultilingualNeural")
      ? { voice: catalogVoiceId, rate: "+4%", pitch: "+0Hz" }
      : EDGE_VOICE_MAP.charles);

  const mp3 = outWav.replace(/\.wav$/i, ".edge.mp3");
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 650 * attempt));
    }
    try {
      await exec(
        bin,
        [
          "--voice", preset.voice,
          `--rate=${preset.rate}`,
          `--pitch=${preset.pitch}`,
          "--text", text,
          "--write-media", mp3,
        ],
        {
          windowsHide: true,
          timeout: 45_000,
          ...abortOpts(),
        },
      );
      const stat = await fsp.stat(mp3);
      if (stat.size < 512) throw new Error("edge-tts produced empty output");
      await ffmpeg(["-i", mp3, "-ar", "44100", "-ac", "1", outWav]);
      await fsp.rm(mp3, { force: true }).catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      await fsp.rm(mp3, { force: true }).catch(() => {});
      if (abortOpts().signal?.aborted) throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("edge-tts synthesis failed after retries");
}
