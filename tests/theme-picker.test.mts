import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as inspectorModule from "../src/components/Inspector";
import { VIDEO_THEMES, strings } from "../src/lib/strings";
import { BOOK_THEMES, BOOK_THEME_IDS } from "../src/lib/video/composition/themes";
import { themeFingerprint } from "../src/lib/video/composition/themes/fingerprint";

/* ===========================================================================
 * The picker has to SHOW a theme, not name it
 *
 * Five themes could be a row of chips: an operator who has seen one video knows
 * what Marginalia is. Eleven cannot — "Atelier" and "Dossier" are words, and
 * finding out what one looks like by choosing it costs a whole render (OCR, a
 * model call, text-to-speech, ffmpeg).
 *
 * So each theme has a still, rendered by `scripts/theme-previews.mjs` out of
 * the real compositor. The failure these tests exist to prevent is the quiet
 * one: a theme added to the registry, offered in the picker, and shipped with
 * no picture — which looks like a broken app rather than like a missing file.
 * ======================================================================== */

const PREVIEWS = fileURLToPath(new URL("../public/theme-previews/", import.meta.url));

// The component is a CJS/ESM default-export wrapper when loaded through tsx —
// the same unwrap `tests/client-ui.test.mts` does.
const Inspector = ((inspectorModule as { default: unknown }).default as { default?: unknown }).default ??
  (inspectorModule as { default: unknown }).default;

/**
 * The inspector's markup, with React's entity escaping undone.
 *
 * Several of the cards' lines carry an apostrophe ("an editor's vermillion
 * pencil"), which `renderToStaticMarkup` writes as `&#x27;`. Comparing the raw
 * markup to `strings.ts` would fail on exactly the lines with voice in them and
 * pass on the bland ones — `tests/client-ui.test.mts` unescapes for the same
 * reason before comparing a hint.
 */
function renderInspector(): string {
  const html = renderToStaticMarkup(
    React.createElement(Inspector as React.ComponentType<{ episode: unknown }>, { episode: null }),
  );
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

test("every theme in the registry has a preview still on disk", async () => {
  const files = new Set((await fs.readdir(PREVIEWS)).filter((f) => f.endsWith(".png")));
  for (const id of BOOK_THEME_IDS) {
    assert.ok(
      files.has(`${id}.png`),
      `${id} has no preview — re-run \`node --import tsx scripts/theme-previews.mjs\`, which renders one per registered theme`,
    );
  }
  // And nothing stale: a still left behind by a theme that has since been
  // renamed is a picture the picker will never show and nobody will ever
  // notice is wrong.
  for (const file of files) {
    const id = file.replace(/\.png$/, "");
    assert.ok(BOOK_THEME_IDS.includes(id as (typeof BOOK_THEME_IDS)[number]), `${file} belongs to no registered theme`);
  }
});

test("a preview still is a picture of the theme as it stands now", async () => {
  /* The failure this exists for is the quiet one. Existence, PNG header and
   * dimensions all stay true after a spec is edited, so without this every test
   * passes while the picker shows a picture of the theme as it USED to be — a
   * wrong picture, which is worse than a missing one because nothing looks
   * broken.
   *
   * `scripts/theme-previews.mjs` writes `manifest.json` mapping each id to the
   * `themeFingerprint` it rendered from. Comparing that to the live theme makes
   * a spec change fail until the stills are regenerated. The fingerprint
   * deliberately excludes `meta`, so fixing a typo in a card's description does
   * not demand an eleven-screenshot rerun. */
  const manifest: Record<string, string> = JSON.parse(await fs.readFile(path.join(PREVIEWS, "manifest.json"), "utf8"));

  for (const id of BOOK_THEME_IDS) {
    assert.ok(manifest[id], `${id} has no entry in the preview manifest`);
    assert.equal(
      manifest[id],
      themeFingerprint(BOOK_THEMES[id]),
      `${id} has changed since its preview was rendered — the card would show the old look. Re-run \`node --import tsx scripts/theme-previews.mjs\`.`,
    );
  }
  assert.deepEqual(
    Object.keys(manifest).sort(),
    [...BOOK_THEME_IDS].sort(),
    "the preview manifest and the registry have drifted apart",
  );
});

test("a preview still is a real PNG with pixels in it", async () => {
  for (const id of BOOK_THEME_IDS) {
    const buf = await fs.readFile(path.join(PREVIEWS, `${id}.png`));
    // Magic number, then the IHDR width/height the generator asked sharp for.
    // A zero-byte or truncated file is what a half-finished generator run
    // leaves behind, and an <img> renders that as nothing at all.
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${id}.png is not a PNG`);
    assert.equal(buf.readUInt32BE(16), 270, `${id}.png is not the width the picker lays out for`);
    assert.equal(buf.readUInt32BE(20), 480, `${id}.png is not 9:16`);
    assert.ok(buf.length > 2000, `${id}.png is ${buf.length} bytes — that is not a rendered frame`);
  }
});

test("the theme panel shows every theme as a card, with its picture and its two lines", () => {
  const html = renderInspector();

  for (const t of VIDEO_THEMES) {
    assert.ok(
      html.includes(`src="/theme-previews/${t.id}.png"`),
      `${t.id} is offered in the picker with no preview picture`,
    );
    assert.ok(html.includes(strings.themePanel.previewAlt(t.label)), `${t.id}'s picture has no alt text`);
    assert.ok(html.includes(t.description!), `${t.id}'s card does not say what it looks like`);
    assert.ok(html.includes(t.bestFor!), `${t.id}'s card does not say what it is for`);
  }

  // A card is a real button carrying aria-pressed, like the chips above it —
  // a bigger control, not a weaker one. None is pressed in a server render,
  // because the setting has not been read yet.
  const cards = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>\s*<img[^>]*src="\/theme-previews\//g)];
  assert.equal(cards.length, VIDEO_THEMES.length, "every preview card must be a button with aria-pressed");
  assert.ok(cards.every((c) => c[1] === "false"), "nothing may claim to be selected before the setting is read");
});

test("the panel says nothing about suggestions until an episode has been ranked", () => {
  // The suggestion badge comes from `GET /api/episodes/:id/themes`, which has
  // not been called in a server render — and with no episode never will be.
  // An empty list must show as NOTHING, not as "no suggestions": the chooser's
  // ranking is advisory and the picker works perfectly without it.
  const html = renderInspector();
  assert.ok(!html.includes(strings.themePanel.suggested), "a suggestion badge appeared with nothing ranked");
  assert.ok(!html.includes(strings.themePanel.suggestedBody), "the suggestion note appeared with nothing ranked");
  // The cards themselves are there regardless.
  assert.ok(html.includes(strings.themePanel.previewsSummary));
  assert.ok(html.includes(strings.themePanel.previewsBody));
});
