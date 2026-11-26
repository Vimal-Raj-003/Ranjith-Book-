/**
 * Studio-Grade Expressive Neural TTS via Google Gemini 3.8 TTS
 * (`gemini-3.8-flash-tts` with instant zero-wait quota failover to
 * `gemini-3.8-flash-lite-tts`, which shares the exact same voice IDs & schema).
 */
import fs from "node:fs/promises";
import { ffmpeg } from "./ffmpeg";
import { getSetting } from "../db";
import { currentSignal } from "../cancel";

export interface GeminiStudioVoiceSpec {
  /** Catalog ID stored in BookReel settings / Episode.voiceId. */
  id: string;
  /** Upstream Gemini 3.8 TTS prebuilt / extended library voice identifier. */
  geminiVoice: string;
  /** Sustained turn-level delivery guidance passed in `speech_metadata.style`. */
  style: string;
}

export const GEMINI_STUDIO_VOICES: Readonly<Record<string, GeminiStudioVoiceSpec>> = {
  // 10 Male Gemini 3.8 Studio Voices (M01 – M10)
  algenib: {
    id: "algenib",
    geminiVoice: "algenib",
    style: "deep, magnetic, grounded cinematic storyteller with crisp authority",
  },
  puck: {
    id: "puck",
    geminiVoice: "puck",
    style: "charismatic, upbeat, natural modern podcast creator speaking to one listener",
  },
  fenrir: {
    id: "fenrir",
    geminiVoice: "fenrir",
    style: "passionate, punchy, high-energy motivational Reels narrator",
  },
  enceladus: {
    id: "enceladus",
    geminiVoice: "enceladus",
    style: "warm, intimate, close-mic late-night storyteller with calm resonance",
  },
  charon: {
    id: "charon",
    geminiVoice: "charon",
    style: "confident, clear, authoritative documentary narrator",
  },
  sadachbia: {
    id: "sadachbia",
    geminiVoice: "sadachbia",
    style: "lively, animated, engaging short-form video creator",
  },
  algieba: {
    id: "algieba",
    geminiVoice: "algieba",
    style: "smooth, velvety, polished mentor sharing practical wisdom",
  },
  achird: {
    id: "achird",
    geminiVoice: "achird",
    style: "warm, friendly, relatable creator talking across a table",
  },
  arthur_uk: {
    id: "arthur_uk",
    geminiVoice: "en-gb-storyteller-4",
    style: "deep, captivating British documentary narrator with rich presence",
  },
  vikram_in: {
    id: "vikram_in",
    geminiVoice: "en-in-storyteller-11",
    style: "confident, crisp, modern Indian-English podcast storyteller",
  },

  // 10 Female Gemini 3.8 Studio Voices (F01 – F10)
  kore: {
    id: "kore",
    geminiVoice: "kore",
    style: "sharp, confident, magnetic viral creator delivering a bold insight",
  },
  sulafat: {
    id: "sulafat",
    geminiVoice: "sulafat",
    style: "warm, rich, velvety storyteller with emotional depth",
  },
  aoede: {
    id: "aoede",
    geminiVoice: "aoede",
    style: "natural, breezy, effortless modern video host",
  },
  zephyr: {
    id: "zephyr",
    geminiVoice: "zephyr",
    style: "bright, crisp, forward-leaning short-form video narrator",
  },
  despina: {
    id: "despina",
    geminiVoice: "despina",
    style: "smooth, mellow, polished studio editorial voiceover",
  },
  laomedeia: {
    id: "laomedeia",
    geminiVoice: "laomedeia",
    style: "upbeat, vibrant, enthusiastic social media storyteller",
  },
  leda: {
    id: "leda",
    geminiVoice: "leda",
    style: "youthful, crisp, energetic creator sharing a sharp book lesson",
  },
  achernar: {
    id: "achernar",
    geminiVoice: "achernar",
    style: "soft, calm, intimate personal storyteller",
  },
  clara_uk: {
    id: "clara_uk",
    geminiVoice: "en-gb-podcaster-2",
    style: "warm, polished, engaging British radio and podcast host",
  },
  ananya_in: {
    id: "ananya_in",
    geminiVoice: "en-in-storyteller-10",
    style: "deep, velvety, expressive Indian-English storyteller",
  },
};

export function isGeminiStudioVoice(voiceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(GEMINI_STUDIO_VOICES, voiceId);
}

export async function resolveGeminiTtsApiKey(): Promise<string> {
  if (process.env.BOOKREEL_AUDIO_TESTS === "1") return "";
  const stored = await getSetting("geminiApiKey").catch(() => null);
  return (stored || process.env.GEMINI_API_KEY || "").trim();
}

let flashCooldownUntil = 0;

/**
 * Synthesize one beat or preview clip into a 44.1 kHz mono WAV using Gemini 3.8 TTS.
 * Automatically switches from `gemini-3.8-flash-tts` to `gemini-3.8-flash-lite-tts`
 * (same voice identity and schema) whenever `flash-tts` hits RPM/RPD quota so multi-beat
 * episodes render rapidly without rate-limit stalls.
 */
export async function synthGeminiStudioVoice(
  text: string,
  outWav: string,
  catalogVoiceId: string,
  explicitApiKey?: string,
): Promise<void> {
  const spec = GEMINI_STUDIO_VOICES[catalogVoiceId];
  if (!spec) throw new Error(`Unknown Gemini Studio voice: ${catalogVoiceId}`);

  const apiKey = explicitApiKey ?? (await resolveGeminiTtsApiKey());
  if (!apiKey) throw new Error("Gemini API key is not configured for Gemini Studio voices.");

  const raw24k = `${outWav}.gemini24k.wav`;
  const ambient = currentSignal();

  try {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const preferLite = Date.now() < flashCooldownUntil || attempt > 0;
      const model = preferLite ? "gemini-3.8-flash-lite-tts" : "gemini-3.8-flash-tts";

      if (attempt >= 2) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }

      const timeoutSig = AbortSignal.timeout(60_000);
      const signal = ambient ? AbortSignal.any([ambient, timeoutSig]) : timeoutSig;

      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          input: [
            {
              type: "user_input",
              content: [
                {
                  type: "text",
                  text,
                  annotations: [
                    {
                      type: "speech_metadata",
                      style: spec.style,
                    },
                  ],
                },
              ],
            },
          ],
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{ voice: spec.geminiVoice }],
          },
        }),
        signal,
      });

      if (res.ok) {
        const body = (await res.json()) as {
          steps?: { content?: { type?: string; data?: string }[] }[];
        };
        const audioPart = body.steps?.flatMap((s) => s.content ?? []).find((c) => c.type === "audio" && c.data);
        if (!audioPart?.data) {
          lastErr = new Error(`Gemini TTS (${model}) returned no audio payload`);
          continue;
        }
        const wavBuf = Buffer.from(audioPart.data, "base64");
        if (wavBuf.length < 1024) {
          lastErr = new Error(`Gemini TTS (${model}) returned truncated audio`);
          continue;
        }
        await fs.writeFile(raw24k, wavBuf);
        await ffmpeg(["-i", raw24k, "-ar", "44100", "-ac", "1", outWav]);
        return;
      }

      const errText = await res.text().catch(() => "");
      if (res.status === 429 && model === "gemini-3.8-flash-tts") {
        // Cool down flash-tts for 90s and retry immediately on flash-lite-tts with zero sleep.
        flashCooldownUntil = Date.now() + 90_000;
        lastErr = new Error(`Gemini flash-tts rate-limited (429)`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini TTS (${model}) ${res.status}: ${errText.slice(0, 180)}`);
        continue;
      }
      throw new Error(`Gemini TTS (${model}) failed (${res.status}): ${errText.slice(0, 200)}`);
    }

    throw lastErr instanceof Error ? lastErr : new Error("Gemini Studio TTS synthesis failed after retries.");
  } finally {
    await fs.rm(raw24k, { force: true }).catch(() => {});
  }
}
