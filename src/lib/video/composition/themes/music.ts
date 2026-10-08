/**
 * Which music bed a theme asks for.
 *
 * `BookTheme.mood` is a four-value enum — "calm" | "warm" | "driving" |
 * "sparse" — that predates the mood registry. `src/lib/media/moods.ts` now
 * holds TEN beds, so six of them were unreachable from a theme: the only route
 * was `MOOD_TO_STYLE`, which maps the four onto the four beds that shipped with
 * them. A theme that wanted `nocturne` had to settle for `blueprint`.
 *
 * `musicMood` is the direct route, and this is the one place the two are
 * reconciled. The order matters and is the whole backward-compatibility
 * argument: a theme with no `musicMood` — which is every theme that shipped
 * before this file — resolves to EXACTLY `MOOD_TO_STYLE[mood]`, the same string
 * `pipeline.ts` has always computed. Re-rendering an old episode cannot change
 * key, tempo or progression.
 *
 * `fallback` is passed in rather than imported so this module stays free of
 * `pipeline.ts` (which reaches ffmpeg, Prisma and the CLI spawner) and can be
 * read from a test, from the preview generator, or from anywhere else, without
 * dragging a server-only graph behind it.
 */
import type { BookTheme } from "../theme-contract";

export function themeMusicStyle(theme: BookTheme, fallback: string): string {
  const named = typeof theme.musicMood === "string" ? theme.musicMood.trim() : "";
  return named.length > 0 ? named : fallback;
}
