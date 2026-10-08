/**
 * SERVER-ONLY, like `keys.ts`, which it imports: it is how the render reads the
 * four music settings the inspector writes.
 */
import { SETTING_FALLBACKS, validateSetting, type SettingKey } from "./keys";
import type { MusicDuck } from "../media/ffmpeg";

/** What `generateMusicBed` is told, with the numbers as numbers. */
export interface MusicSettings {
  /** A mood id, or `"auto"`: follow the video's theme. */
  mood: string;
  intensity: number;
  level: number;
  duck: MusicDuck;
}

/**
 * The four music settings as they stand, each independently checked.
 *
 * A stored value this build no longer accepts (a mood renamed, a range narrowed)
 * falls back for THAT key and leaves the others alone, which is what
 * `GET /api/settings` does too, so the inspector and the render cannot disagree
 * about what a stale row means. `get` is `getSetting`, passed in so this can be
 * exercised without a database.
 *
 * Nothing here can throw on a bad value, and the caller (the render's best-effort
 * music step) does not have to defend against one: validation is the point, and
 * the fallbacks are the values the bed had before it had settings.
 */
export async function readMusicSettings(get: (key: string) => Promise<string | null>): Promise<MusicSettings> {
  const read = async (key: SettingKey): Promise<string> => {
    const stored = await get(key);
    return (stored === null ? null : validateSetting(key, stored)) ?? SETTING_FALLBACKS[key];
  };
  const [mood, intensity, level, duck] = await Promise.all([
    read("musicMood"),
    read("musicIntensity"),
    read("musicLevel"),
    read("musicDuck"),
  ]);
  return { mood, intensity: Number(intensity), level: Number(level), duck: duck as MusicDuck };
}

/**
 * The mood id `generateMusicBed` is given. `auto` is not a mood: it means the one
 * the theme implies (`MOOD_TO_STYLE` in `pipeline.ts`), which is how the bed has
 * always been chosen, so that path is passed in untouched rather than reproduced.
 */
export function bedStyle(mood: string, themeStyle: string): string {
  return mood === "auto" ? themeStyle : mood;
}
