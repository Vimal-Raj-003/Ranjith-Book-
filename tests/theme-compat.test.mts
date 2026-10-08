import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BookTheme } from "../src/lib/video/composition/theme-contract";
import { BOOK_THEMES, BOOK_THEME_IDS, DEFAULT_BOOK_THEME_ID, bookThemeById } from "../src/lib/video/composition/themes";
import { themeMusicStyle } from "../src/lib/video/composition/themes/music";
import { themeFingerprint } from "../src/lib/video/composition/themes/fingerprint";
import { MOODS } from "../src/lib/media/moods";
import { contrast, thumbPalette } from "../src/lib/thumbnails/palette";

/* ===========================================================================
 * The widened theme contract did not move a pixel on anything already shipped
 *
 * `BookTheme` grew seven optional fields (`musicMood`, `typography`, `texture`,
 * `surface`, `marker`, `optics`, `meta`) and the registry grew from five themes
 * to eleven. The promise attached to that work was narrow and absolute:
 *
 *   re-rendering an existing episode on an existing theme produces the same
 *   video, byte for byte.
 *
 * An episode row stores a theme ID, so that promise has to survive for every
 * one of the original five forever — a video delivered to a channel in
 * Marginalia and re-rendered a year later must not come back in a different
 * yellow. A test that merely checked "marginalia still has a palette" would
 * pass while the look drifted, so this pins a SHA-256 of everything the theme
 * actually hands the compositor.
 *
 * WHEN THIS FAILS: a hash here changing is not a test to update. It means a
 * change to the theme contract, to `color.ts`, or to one of the five original
 * theme modules has altered what an already-delivered video looks like. The
 * fix is to make the change additive instead. The ONE legitimate reason to
 * re-pin is a deliberate, stated decision to re-skin an existing theme, which
 * has never been taken in this project.
 * ======================================================================== */

/** The five that shipped before the theme engine, with no optional field set. */
const ORIGINAL_IDS = ["marginalia", "terminal", "editorial", "spotlight", "blueprint"] as const;

/** The six compiled from a `ThemeSpec`. */
const ENGINE_IDS = ["academia", "atelier", "dossier", "quiet", "storybook", "neon"] as const;

/**
 * Recorded from the working tree at HEAD 9d60a66, BEFORE the contract was
 * widened — the hashes are of the code as it stood, not of code this change
 * produced, which is the only ordering under which they prove anything.
 */
const PINNED: Record<(typeof ORIGINAL_IDS)[number], string> = {
  marginalia: "632c6500251868d6dd7603c81804517f48659cd9cf33ee88c0af4b28c27860d7",
  terminal: "ec9b0be3897e2c5376d0aee0e11f38492e7f91560f792f73cd652c7b9bfa4dbc",
  editorial: "6b004e94014deddab6e9fb839ed4a529db94d7aeffeb164a23459602611485e9",
  spotlight: "2193e10f964ca01a1c22526bd3ea296ed4a8f3235eb87af776542407d6380893",
  blueprint: "5c5c1b2102fb9773c1b79f80f4031343b4fdff0c7cf1229b3c87d37f02195f83",
};

test("the five original themes render exactly what they rendered before the theme engine", () => {
  for (const id of ORIGINAL_IDS) {
    assert.equal(
      themeFingerprint(BOOK_THEMES[id]),
      PINNED[id],
      `${id} no longer paints what it painted at HEAD 9d60a66 — an episode already delivered in this theme would come back looking different. Make the change additive; do not re-pin this hash.`,
    );
  }
});

test("the five original themes set none of the new optional fields", async () => {
  // The hash above proves the OUTPUT is unchanged. This proves the mechanism:
  // every one of them is taking the documented default for every new axis, so
  // "absent" and "today's value" really are the same thing rather than two
  // paths that happen to agree on one fixture.
  for (const id of ORIGINAL_IDS) {
    const theme = BOOK_THEMES[id] as unknown as Record<string, unknown>;
    for (const field of ["musicMood", "typography", "texture", "surface", "marker", "optics", "meta"]) {
      assert.equal(theme[field], undefined, `${id} set ${field} — it was supposed to be left untouched`);
    }
  }

  // And that their MODULES were not edited at all: no import of the compiler,
  // no spec, nothing. A theme routed through `defineTheme` would still hash the
  // same only by luck.
  const dir = fileURLToPath(new URL("../src/lib/video/composition/themes/", import.meta.url));
  for (const id of ORIGINAL_IDS) {
    const src = await fs.readFile(path.join(dir, `${id}.ts`), "utf8");
    assert.doesNotMatch(src, /from\s+["']\.\/compile["']/, `${id}.ts was rewritten onto the compiler`);
  }
});

test("an episode row carrying any original theme id still resolves to that theme", () => {
  // The union grew from five members to eleven. `bookThemeById` takes a bare
  // string off a database column, so the five that rows actually carry today
  // are the ones that must keep resolving.
  for (const id of ORIGINAL_IDS) {
    assert.equal(bookThemeById(id).id, id, `${id} stopped resolving`);
  }
  assert.equal(DEFAULT_BOOK_THEME_ID, "marginalia", "the render-time repair for an old row moved");
  assert.equal(bookThemeById(null).id, "marginalia");
  assert.equal(bookThemeById("no-such-theme").id, "marginalia");
});

test("a theme with no musicMood gets exactly the bed MOOD_TO_STYLE always gave it", () => {
  // `themeMusicStyle` is the one place the four-value enum and the ten-mood
  // registry meet. The whole backward-compatibility argument is that an absent
  // `musicMood` is a passthrough, so this asserts the passthrough directly
  // rather than trusting the ?? in the implementation to stay that way.
  const fallback: Record<BookTheme["mood"], string> = {
    warm: "editorial",
    calm: "blueprint",
    driving: "spotlight",
    sparse: "terminal",
  };
  for (const id of ORIGINAL_IDS) {
    const theme = BOOK_THEMES[id];
    assert.equal(
      themeMusicStyle(theme, fallback[theme.mood]),
      fallback[theme.mood],
      `${id}'s bed changed — an old episode would come back scored in a different key`,
    );
  }
  // A blank or whitespace string is "not named", not "a mood called nothing":
  // the latter would reach `generateMusicBed` and silently produce no bed.
  const fake = { ...BOOK_THEMES.marginalia, musicMood: "   " } as BookTheme;
  assert.equal(themeMusicStyle(fake, "editorial"), "editorial");
  assert.equal(themeMusicStyle({ ...BOOK_THEMES.marginalia, musicMood: "nocturne" } as BookTheme, "editorial"), "nocturne");
});

test("every theme, old and new, yields a poster palette that is legible", () => {
  /* Poster/thumbnail styling hints were on the ask and were NOT built — see the
   * report. `thumbnails/palette.ts` and `thumbnails/render.ts` derive a poster
   * from `ThemePalette` alone, so the new themes' typography, grain and marker
   * shape do not reach a poster; `TEXTURES` and `MARK_RADIUS` there are keyed by
   * theme id with a documented "falls through to grain" default for ids added
   * later, which is exactly what the six new ones hit.
   *
   * What must hold regardless, and what this measures, is that a poster still
   * RENDERS and is readable for every id an episode row can carry — an
   * unreadable poster is a worse outcome than an unthemed one.
   *
   * The floor is 3:1 and the bar is "no worse than what already ships". That
   * pairing is deliberate. `pickInk` ASKS for 4.5 (or 7 for the slab) but does
   * not guarantee it — it falls back to the best candidate available, or to
   * plain black/white — so asserting 4.5 here would be inventing a contract the
   * code never made and failing shipped work on it: Marginalia's poster
   * `onAccent` is 4.15:1 today and has been in every poster this app has made.
   * What IS a real defect is a new theme being worse than the worst existing
   * one, so that is what the second loop measures.
   */
  const ROLES = ["ink", "inkSoft", "key", "onAccent", "paperInk", "onSlab"] as const;
  const surfaceOf = (t: ReturnType<typeof thumbPalette>, role: (typeof ROLES)[number]) =>
    role === "onAccent" ? t.accent : role === "paperInk" ? t.paper : role === "onSlab" ? t.slab : t.ground;

  for (const id of BOOK_THEME_IDS) {
    const t = thumbPalette(id);
    assert.equal(t.id, id, `${id} does not resolve to its own poster palette`);
    for (const role of ROLES) {
      const ratio = contrast(t[role], surfaceOf(t, role));
      // 3:1 is the large-text floor. Under it is not "low contrast", it is
      // invisible, and a poster nobody can read is worse than an unthemed one.
      assert.ok(ratio >= 3, `${id}: poster ${role} reads at ${ratio.toFixed(2)}:1 against its own surface`);
    }
    assert.ok(["grain", "grid", "weave", "halftone"].includes(t.texture), `${id}: poster texture is not one of the four`);
  }

  // No new theme may be worse than the worst theme already shipping — capped at
  // 7:1, which is WCAG's AAA bar for body text. Without the cap this compares
  // noise: Academia's poster `paperInk` is 14.59:1 where the shipped worst is
  // 14.83:1, and failing a theme over a quarter of a point at fifteen-to-one
  // would be a test that trains people to edit it. Below 7 the difference is
  // real, which is where the comparison earns its place: Quiet's keyword was
  // caught here at 4.57:1 against a shipped floor of 5.29:1.
  const COMFORTABLE = 7;
  for (const role of ROLES) {
    const floor = Math.min(
      COMFORTABLE,
      ...ORIGINAL_IDS.map((id) => {
        const t = thumbPalette(id);
        return contrast(t[role], surfaceOf(t, role));
      }),
    );
    for (const id of ENGINE_IDS) {
      const t = thumbPalette(id);
      const ratio = contrast(t[role], surfaceOf(t, role));
      assert.ok(
        ratio >= floor - 0.01,
        `${id}: poster ${role} reads at ${ratio.toFixed(2)}:1, below the ${floor.toFixed(2)}:1 the shipped themes already manage`,
      );
    }
  }

  // And the documented fallback is really what the six new ones take, so the
  // gap recorded in the report is the gap that exists.
  for (const id of ENGINE_IDS) {
    assert.equal(
      thumbPalette(id).texture,
      "grain",
      `${id} now has its own poster texture — if posters were wired to the theme, the report's declined list is stale`,
    );
  }
});

test("every musicMood a theme names is a bed that exists", () => {
  // A mood id that is not in the registry does not throw — `generateMusicBed`
  // falls through to no bed at all, so the video plays silent under the voice.
  for (const id of BOOK_THEME_IDS) {
    const named = BOOK_THEMES[id].musicMood;
    if (named === undefined) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(MOODS, named),
      `${id} asks for the bed "${named}", which src/lib/media/moods.ts does not have`,
    );
  }
});
