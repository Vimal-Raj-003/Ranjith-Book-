import type { BookTheme } from "../theme-contract";
import { marginalia } from "./marginalia";
import { terminal } from "./terminal";
import { editorial } from "./editorial";
import { spotlight } from "./spotlight";
import { blueprint } from "./blueprint";

export { marginalia, terminal, editorial, spotlight, blueprint };

/**
 * Every theme id the picker may persist on an episode.
 *
 * It is a union rather than `string` so that a typo in the controller is a
 * compile error at the call site instead of a video that silently renders in
 * the wrong theme — the exact failure mode the third-pass addendum (§17) was
 * filed about, only inverted.
 */
export type BookThemeId = "marginalia" | "terminal" | "editorial" | "spotlight" | "blueprint";

/**
 * The registry. Keyed by the same ids `src/lib/strings.ts` offers in the
 * inspector, which is what makes the picker resolvable at all: the UI stores
 * an id, the controller hands that id to `bookThemeById`, and this is the one
 * place the two meet.
 */
export const BOOK_THEMES: Record<BookThemeId, BookTheme> = {
  marginalia,
  terminal,
  editorial,
  spotlight,
  blueprint,
};

/** Every id, in the order the picker offers them. */
export const BOOK_THEME_IDS = Object.keys(BOOK_THEMES) as BookThemeId[];

/**
 * What an episode with no stored theme renders as — and what an unrecognised
 * id degrades to.
 */
export const DEFAULT_BOOK_THEME_ID: BookThemeId = "marginalia";

export function isBookThemeId(id: unknown): id is BookThemeId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(BOOK_THEMES, id);
}

/**
 * Resolve a stored theme id to a theme. **This never throws and never returns
 * undefined.**
 *
 * The argument is typed `string | null | undefined` deliberately, not
 * `BookThemeId`: the value arrives from a database column written by an older
 * build of the app, so at this boundary it genuinely can be null (an episode
 * created before the picker existed), an id that has since been renamed, or —
 * because the column is a plain `String` — anything at all. Every one of those
 * must render a video in the default theme rather than fail a render that has
 * already paid for OCR, a model call and a full text-to-speech pass.
 *
 * `hasOwnProperty` rather than a bare `in`/index read: `bookThemeById("toString")`
 * would otherwise resolve to `Object.prototype.toString` and hand `buildComposition`
 * a function where a theme belongs.
 */
export function bookThemeById(id: string | null | undefined): BookTheme {
  return isBookThemeId(id) ? BOOK_THEMES[id] : BOOK_THEMES[DEFAULT_BOOK_THEME_ID];
}
