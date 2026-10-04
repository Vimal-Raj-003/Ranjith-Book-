/**
 * SERVER-ONLY. Do not import this from a `"use client"` component.
 *
 * It imports `media/pocket-tts.ts` for the voice catalogue, and that module
 * imports `node:child_process`, so the bundler would follow it into the browser
 * where `child_process` cannot resolve — the same trap `pipeline.ts` documents
 * above its `INGEST_STEPS` re-export. A client component that needs one of these
 * vocabularies imports the pure source directly (`media/moods.ts` for the music
 * moods) or reads the value from `GET /api/settings`.
 *
 * The mood list comes from `media/moods.ts`, never `media/ffmpeg.ts`, for the
 * same reason: ffmpeg.ts is node-bound and moods.ts is data.
 */
import { isThemeSetting, THEME_SETTING_AUTO } from "../video/composition/themes";
import { POCKET_VOICES, DEFAULT_POCKET_VOICE } from "../media/pocket-tts";
import { MOODS } from "../media/moods";

/**
 * The settings an operator may write through `PUT /api/settings`.
 *
 * An allow-list, not a schema: this route used to accept `theme` and nothing
 * else, and widening it to "whatever the body contains" would make every
 * `Setting` row writable from the browser — including `elevenLabsApiKey` and
 * `openaiApiKey`, which `tts.ts` reads. Those are deliberately absent here.
 */
export const SETTING_KEYS = [
  "theme", "voiceId", "voiceProvider",
  "musicMood", "musicIntensity", "musicLevel", "musicDuck",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === "string" && (SETTING_KEYS as readonly string[]).includes(key);
}

/** What each key resolves to when it has never been written. */
export const SETTING_FALLBACKS: Record<SettingKey, string> = {
  theme: THEME_SETTING_AUTO,
  voiceId: DEFAULT_POCKET_VOICE,
  voiceProvider: "pocket",
  // `auto` means "derived from the theme", which is exactly today's behaviour.
  musicMood: "auto",
  musicIntensity: "1",
  musicLevel: "-22", // BED_MEAN_DB in ffmpeg.ts — the level shipped today.
  musicDuck: "normal",
};

const VOICE_IDS = POCKET_VOICES.map((v) => v.id);
const PROVIDERS = ["pocket", "elevenlabs", "openai", "system"];
const DUCKS = ["off", "light", "normal", "strong"];

function intIn(value: unknown, lo: number, hi: number): string | null {
  // A string from a form and a number from JSON are both legitimate. Anything
  // fractional, NaN, or out of range is not.
  //
  // A blank string is refused explicitly: `Number("")` and `Number("  ")` are
  // both 0, so a cleared field would otherwise be stored as a deliberate zero
  // (for `musicIntensity`, "music off") instead of rejected.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return String(n);
}

function oneOf(value: unknown, allowed: string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/**
 * The value to store, or null when it is not one this build supports.
 *
 * Returning the normalised string rather than a boolean is the point: a
 * caller cannot accidentally store the raw input, because the only thing it
 * is handed back is the validated form.
 */
export function validateSetting(key: SettingKey, value: unknown): string | null {
  switch (key) {
    case "theme":
      return isThemeSetting(value) ? value : null;
    case "voiceId":
      return oneOf(value, VOICE_IDS);
    case "voiceProvider":
      return oneOf(value, PROVIDERS);
    case "musicMood":
      return oneOf(value, ["auto", ...Object.keys(MOODS)]);
    case "musicIntensity":
      return intIn(value, 0, 2);
    case "musicLevel":
      return intIn(value, -40, -6);
    case "musicDuck":
      return oneOf(value, DUCKS);
  }
}
