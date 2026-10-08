/**
 * Everything a theme contributes to a frame, as one hash.
 *
 * Two separate jobs need exactly this value, which is why it is a module rather
 * than a helper inside one test:
 *
 *  - `tests/theme-compat.test.mts` pins it for the five themes that shipped
 *    first, so a change to the contract that moved a pixel on an
 *    already-delivered video fails before it ships.
 *  - `scripts/theme-previews.mjs` records it beside each rendered still, and
 *    `tests/theme-picker.test.mts` compares the recorded value to the live one.
 *    Without that, editing a spec leaves a preview card showing a picture of the
 *    theme as it used to be — a wrong picture, with every test still green,
 *    which is worse than a missing one.
 *
 * It must therefore cover everything that can change what is painted and
 * nothing that cannot: the stylesheet, all three markup surfaces, two strokes
 * (index 0 and a non-zero one, so an index interpolated into the wrong place
 * shows), the bed enum and the whole palette. `meta` is deliberately NOT in it
 * — the preview card's words are not in the picture, so a typo fix in a
 * description must not demand an eleven-screenshot regenerate.
 *
 * NUL-joined rather than newline-joined so a value moving from the end of one
 * part to the start of the next cannot hash the same.
 */
import { createHash } from "node:crypto";
import type { BookTheme } from "../theme-contract";

export function themeFingerprint(theme: BookTheme): string {
  const parts = [
    theme.css(),
    theme.backdrop(),
    theme.cardFace(),
    theme.overlay(),
    theme.strokeMarkup(0),
    theme.strokeMarkup(7),
    theme.mood,
    JSON.stringify(theme.palette),
  ];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}
