import type { BookTheme } from "../theme-contract";
import { marginalia } from "./marginalia";
import { terminal } from "./terminal";
import { editorial } from "./editorial";
import { spotlight } from "./spotlight";
import { blueprint } from "./blueprint";
// The data-driven half of the registry (2026-10-05). Each of these is a
// ~40-line `ThemeSpec` compiled by `./compile`, not another 180-line module —
// see that file's header for why the five above were left exactly as they are.
import { academia } from "./academia";
import { atelier } from "./atelier";
import { dossier } from "./dossier";
import { quiet } from "./quiet";
import { storybook } from "./storybook";
import { neon } from "./neon";

export { marginalia, terminal, editorial, spotlight, blueprint };
export { academia, atelier, dossier, quiet, storybook, neon };

/**
 * Every theme id the picker may persist on an episode.
 *
 * It is a union rather than `string` so that a typo in the controller is a
 * compile error at the call site instead of a video that silently renders in
 * the wrong theme — the exact failure mode the third-pass addendum (§17) was
 * filed about, only inverted.
 */
export type BookThemeId =
  | "marginalia"
  | "terminal"
  | "editorial"
  | "spotlight"
  | "blueprint"
  | "academia"
  | "atelier"
  | "dossier"
  | "quiet"
  | "storybook"
  | "neon";

/**
 * The registry. Keyed by the same ids `src/lib/strings.ts` offers in the
 * inspector, which is what makes the picker resolvable at all: the UI stores
 * an id, the controller hands that id to `bookThemeById`, and this is the one
 * place the two meet.
 */
export const BOOK_THEMES: Record<BookThemeId, BookTheme> = {
  // The five that shipped first, in the order they shipped. Their position here
  // is load-bearing beyond presentation: `BOOK_THEME_IDS` is this object's key
  // order, and `choose.ts` breaks a scoring tie by it, so moving one of these
  // would re-aim the chooser for texts that tie. New themes go after them.
  marginalia,
  terminal,
  editorial,
  spotlight,
  blueprint,
  academia,
  atelier,
  dossier,
  quiet,
  storybook,
  neon,
};

/** Every id, in the order the picker offers them. */
export const BOOK_THEME_IDS = Object.keys(BOOK_THEMES) as BookThemeId[];

/**
 * What an episode with no stored theme renders as — and what an unrecognised
 * id degrades to.
 *
 * This is a RENDER-TIME repair for a row that is already in the database, and
 * that is the only thing it is. It is not the operator setting's default (that
 * is `THEME_SETTING_AUTO`) and it is not what a new episode gets (that is
 * derived from the episode's own content — see `themes/choose.ts`). Pointing
 * either of those at this constant is what produced the all-marginalia feed the
 * chooser was written to fix. Keeping it here keeps an already-stamped episode
 * non-retroactive: a row written by an older build still renders, and renders
 * the same way it did before.
 */
export const DEFAULT_BOOK_THEME_ID: BookThemeId = "marginalia";

export function isBookThemeId(id: unknown): id is BookThemeId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(BOOK_THEMES, id);
}

/**
 * The stored setting value meaning "derive the theme from what the video is
 * about" — see `themes/choose.ts` for the derivation and for the measured
 * defect it fixes.
 *
 * This is deliberately NOT a member of `BookThemeId`. That union is the set of
 * things that can be RENDERED: `bookThemeById` has to resolve every one of them
 * to a real `BookTheme`, and the ids are also what an episode row carries. There
 * is no "auto" theme to render and no episode is ever stamped "auto" — by the
 * time a row exists the choice has already been made and frozen. Keeping it out
 * of the union is what makes that a compile error rather than a video that
 * renders in the default because a string fell through.
 */
export const THEME_SETTING_AUTO = "auto" as const;

/**
 * What the operator's theme setting may hold: one specific theme, or "auto".
 *
 * "auto" is the default, and absent/unrecognised is read as "auto" too — a fresh
 * install derives the theme instead of giving every book the same one. Note that
 * this says nothing about `DEFAULT_BOOK_THEME_ID`, which is a different
 * question with a different answer: see there.
 */
export type ThemeSetting = BookThemeId | typeof THEME_SETTING_AUTO;

export function isThemeSetting(v: unknown): v is ThemeSetting {
  return v === THEME_SETTING_AUTO || isBookThemeId(v);
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
