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
import { getSetting } from "../db";

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
const DUCKS = ["off", "light", "normal", "strong"];

/**
 * What this machine can actually narrate with.
 *
 * `voiceProvider` used to accept all four providers that `tts.ts` has code for,
 * and that was a one-way door. `resolveVoice` reads the setting verbatim while
 * `voiceId` stays a Pocket id, so:
 *   - `system` on anything but macOS makes `synthSystem` THROW, which fails the
 *     narration step of every render from then on;
 *   - `elevenlabs`/`openai` with no key fall through to the same throw;
 *   - with a key, they would be handed a Pocket voice id ("charles"), which is
 *     not a voice either of them has.
 * And ruling R2 ships no provider selector, so there is no way back in the app:
 * one `PUT {"voiceProvider":"system"}` would brick narration until somebody
 * edited the database by hand.
 *
 * So the allow-list is now the providers this install can honour, which is
 * derived rather than declared. Pocket always can — it runs locally and needs
 * no key. The others need the thing they need, and are refused with the normal
 * `bad_value` 400 when they do not have it.
 */
export interface VoiceProviderCaps {
  /** `Setting("elevenLabsApiKey")` or `ELEVENLABS_API_KEY`, the way `tts.ts` resolves it. */
  elevenLabsKey: string;
  /** `Setting("openaiApiKey")` or `OPENAI_API_KEY`. */
  openaiKey: string;
  /** `process.platform`. `system` is macOS `say`, and there is no Linux or Windows equivalent. */
  platform: string;
}

/**
 * What a caller that cannot read the keys must assume: Pocket, and nothing else.
 *
 * `validateSetting`'s default, so forgetting to pass capabilities can only ever
 * refuse a provider — never accept one the machine cannot run.
 */
export const POCKET_ONLY_CAPS: VoiceProviderCaps = { elevenLabsKey: "", openaiKey: "", platform: "" };

/** The providers `caps` can honour, Pocket first. */
export function voiceProviders(caps: VoiceProviderCaps): string[] {
  const providers = ["pocket"];
  if (caps.elevenLabsKey.trim() !== "") providers.push("elevenlabs");
  if (caps.openaiKey.trim() !== "") providers.push("openai");
  // No key: macOS `say` is free and offline. The platform is the whole gate.
  if (caps.platform === "darwin") providers.push("system");
  return providers;
}

/**
 * The real capabilities of this process, read the same way `tts.ts` reads them
 * — the stored setting first, then the environment variable — so the answer
 * here and the answer at render time cannot disagree.
 */
export async function readVoiceProviderCaps(): Promise<VoiceProviderCaps> {
  return {
    elevenLabsKey: (await getSetting("elevenLabsApiKey")) ?? process.env.ELEVENLABS_API_KEY ?? "",
    openaiKey: (await getSetting("openaiApiKey")) ?? process.env.OPENAI_API_KEY ?? "",
    platform: process.platform,
  };
}

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
 *
 * `caps` is only consulted for `voiceProvider`, and defaults to Pocket-only, so
 * a caller that does not have them (or does not care) gets the safe answer
 * rather than the wrong one. `GET`/`PUT /api/settings` pass the real ones from
 * `readVoiceProviderCaps`, which means GET also re-validates on the way out: a
 * provider whose key has since been removed reads back as the fallback instead
 * of as a selection the next render would fail on.
 */
export function validateSetting(
  key: SettingKey,
  value: unknown,
  caps: VoiceProviderCaps = POCKET_ONLY_CAPS,
): string | null {
  switch (key) {
    case "theme":
      return isThemeSetting(value) ? value : null;
    case "voiceId":
      return oneOf(value, VOICE_IDS);
    case "voiceProvider":
      return oneOf(value, voiceProviders(caps));
    case "musicMood":
      return oneOf(value, ["auto", ...Object.keys(MOODS)]);
    case "musicIntensity":
      return intIn(value, 0, 2);
    case "musicLevel":
      // The top is -13, not the -6 this first allowed. The level is a MEAN (RMS)
      // target and these beds peak about three to four times their RMS, so above
      // roughly -10 dB `levelAndFade`'s peak ceiling holds the bed back and what is
      // delivered is quieter than the number on the slider, by a different amount
      // for each mood. Measured over every mood, tier and end phase of a bed, the
      // ceiling first engages between -9.5 dB and -12.2 dB (momentum, which has the
      // briskest chords and so the highest peaks): -13 is the highest whole dB at
      // which it never does, so the number on the slider is the bed's mean level.
      // (-12 was tried first and is not enough: momentum's upper tiers cross it.)
      // Must equal `MUSIC_LEVEL_RANGE` in `strings.ts`.
      return intIn(value, -40, -13);
    case "musicDuck":
      return oneOf(value, DUCKS);
  }
}
