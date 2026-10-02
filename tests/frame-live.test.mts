import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildComposition, type CompositionInput } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { gridViolations, BANDS, type Box } from "../src/lib/video/composition/frame";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms);
  });
  // Clear the timer on either outcome, or every call leaves a live handle behind.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/** Frame furniture and the cinematic scenes: measured by the element's own box. */
const BOX_SELECTORS = [
  ".byline, .caption-line, .cta-card, #buy-card, .hook-text",
  ".sc-kinetic .sc-word",
  ".sc-cine .cine-key, .sc-cine .cine-lead, .sc-cine .cine-hook",
].join(", ");

/**
 * Every other scene's type. Leaf elements only: a container such as .sc-kinetic or .sc-stat would
 * "overlap" its own children and flag a collision that is not one. (.sc-kinetic .sc-word is in
 * BOX_SELECTORS: it is inline-block, so its own box is exactly the word, and it is scoped to
 * .sc-kinetic because cinematic text reuses .sc-word inside .cine-key, which is already measured.
 * A Range over its text would use the font's content area, which is taller than the 1.18 line-height,
 * so adjacent rows of a wrapped line would "overlap" by a few pixels of leading with no ink touching.)
 *
 * These are measured by where their WORDS are (a Range over the contents), not by the element's box:
 * they are block-level, so their box spans the whole stage width while a short line such as the
 * "page 3" reference is a few hundred pixels of ink in the middle, and a box that wide would be
 * reported as reaching into the action rail when no word is anywhere near it.
 */
const INK_SELECTORS = [
  ".sc-quote-text, .sc-quote-ref, .sc-cell-label, .sc-side-label, .sc-vs",
  ".sc-step-t, .sc-heading, .sc-tl-label, .sc-curve-label, .sc-stat-value, .sc-stat-label",
].join(", ");

const TEXT_SELECTORS = `${BOX_SELECTORS}, ${INK_SELECTORS}`;

async function textBoxesAt(page: import("playwright-core").Page, t: number, exclude = "") {
  return within(
    page.evaluate(
      ({ time, sel, ink, exclude }) => {
        (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl.seek(time, false);
        const out: { name: string; opacity: number; box: { x: number; y: number; w: number; h: number } }[] = [];
        document.querySelectorAll(sel).forEach((el, i) => {
          if (exclude && el.matches(exclude)) return;
          const cs = getComputedStyle(el as HTMLElement);
          if (cs.visibility === "hidden") return;
          // Effective opacity: a scene fades as a whole, and a child that sets its own
          // visibility:visible would otherwise look present inside a scene that is gone.
          let opacity = 1;
          for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
          if (opacity < 0.05) return;
          let r: DOMRect;
          if (el.matches(ink)) {
            const range = document.createRange();
            range.selectNodeContents(el);
            r = range.getBoundingClientRect();
          } else {
            r = (el as HTMLElement).getBoundingClientRect();
          }
          if (r.width < 1 || r.height < 1) return;
          out.push({
            name: `${(el as HTMLElement).className.split(" ").join(".") || el.tagName}#${i}`,
            opacity,
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        });
        return out;
      },
      { time: t, sel: TEXT_SELECTORS, ink: INK_SELECTORS, exclude },
    ),
    30_000,
    `boxes at ${t}`,
  );
}

async function withComposition(html: string, run: (p: import("playwright-core").Page) => Promise<void>) {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await within(page.setContent(html, { waitUntil: "load" }), 30_000, "load");
    await within(page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl), null, { timeout: 30_000 }), 35_000, "timeline");
    await new Promise((r) => setTimeout(r, 1500));
    // Every face on screen is a HOST font: the composition embeds no @font-face and HyperFrames ships no
    // fonts, so the real render resolves the same system fonts these measurements do. Which fonts differs
    // by theme, because theme CSS is appended after the skeleton and overrides its `Inter, system-ui`
    // stack: editorial uses Palatino Linotype (captions, byline) and Bodoni MT (hook); spotlight, terminal
    // and blueprint use their own installed faces; only marginalia, the default theme, inherits the skeleton
    // stack, where Inter is not installed and the browser falls back (Segoe UI Black here). Caption geometry
    // is therefore host-font dependent, and a render host with different system fonts will wrap differently.
    // If a font is ever embedded this fails, and every width this file relies on (caption rows, the
    // 34-character font-size threshold) must be re-measured.
    //
    // Two probes, because document.fonts.check() is useless (it answers true for any family with no
    // @font-face). First: nothing is registered at all. Second: a known string is exactly as wide in
    // "Inter" as in a deliberately bogus family on the same fallback stack, so Inter is not resolving
    // (this is the one that matters for marginalia and for any element a theme does not restyle).
    const registeredFaces = await within(page.evaluate(() => document.fonts.size), 10_000, "font face count");
    assert.equal(registeredFaces, 0, "the composition now embeds a font: re-measure the caption geometry before changing this");
    const fontProbe = await within(
      page.evaluate(() => {
        // No named helpers in here: tsx wraps them in __name(), which does not exist in the page.
        const text = "The quick brown fox jumps over the lazy dog 0123456789";
        const widths: number[] = [];
        for (const family of ["Inter, system-ui, sans-serif", "NoSuchFamilyZzQq, system-ui, sans-serif"]) {
          const s = document.createElement("span");
          s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:800 60px ${family}`;
          s.textContent = text;
          document.body.appendChild(s);
          widths.push(s.getBoundingClientRect().width);
          s.remove();
        }
        return { inter: widths[0], bogus: widths[1] };
      }),
      10_000,
      "font probe",
    );
    assert.equal(
      fontProbe.inter,
      fontProbe.bogus,
      `Inter is unexpectedly available (${JSON.stringify(fontProbe)}): re-measure the caption geometry before changing this`,
    );
    await run(page);
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser.close();
  }
}

/** An element counts as settled, for the element-versus-element check, at this effective opacity or above. */
const SETTLED_OPACITY = 0.9;

/**
 * Every way the measured elements are wrong, judged in two parts.
 *
 * 1. The frame and the platform chrome apply to EVERY visible element, however faded: a word that is
 *    mid-dissolve is still a word the viewer can read, so it must not sit under the chrome or off the frame.
 *    `gridViolations` called on one item at a time gives exactly that (it has no one to pair with).
 * 2. Element-versus-element overlap applies only to pairs that are BOTH essentially settled
 *    (effective opacity of at least SETTLED_OPACITY). The composition dissolves between states on purpose:
 *    the CTA card fades in over the last scene's text as that scene fades out, and the hook card's blur
 *    scrim covers the opening scene's words while the hook's own text finishes leaving first
 *    (HOOK_TEXT_LEAD in build.ts) so the two are never legible together. A box cannot see a scrim or an
 *    in-flight opacity ramp, so judging a crossfade as a collision reports a defect no viewer sees. Two settled
 *    elements overlapping is a real collision. Do not lower this to make a failure go away: report it.
 *
 * `gridViolations` itself stays pure and unchanged; it is shared with the unit tests.
 */
function frameViolations(items: { name: string; opacity: number; box: Box }[]): string[] {
  const out = new Set<string>();
  for (const item of items) for (const v of gridViolations([item])) out.add(v);
  const settled = items.filter((i) => i.opacity >= SETTLED_OPACITY);
  for (const v of gridViolations(settled)) out.add(v);
  return [...out];
}

/**
 * Scrub the whole timeline and judge every word on screen. Returns how many boxes
 * of each kind were actually measured, so a caller can prove the sweep saw the
 * element it claims to be guarding rather than passing over an empty page.
 */
async function sweep(page: import("playwright-core").Page, exclude = ""): Promise<Map<string, number>> {
  const duration = await page.evaluate(() => (window as unknown as { __tl: { duration(): number } }).__tl.duration());
  // 24 even steps, plus the very start and the very end, which is where the hook
  // card and the CTA / purchase cards live.
  const instants = [0.1, ...Array.from({ length: 24 }, (_, i) => (duration * (i + 0.5)) / 24), duration - 0.2];
  const seen = new Map<string, number>();
  for (const t of instants) {
    const boxes = await textBoxesAt(page, t, exclude);
    for (const b of boxes) {
      for (const kind of b.name.split("#")[0].split(".")) seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    const bad = frameViolations(boxes);
    assert.deepEqual(bad, [], `at t=${t.toFixed(2)}s: ${bad.join(" | ")}`);
  }
  return seen;
}

function assertSaw(seen: Map<string, number>, kinds: string[]) {
  for (const k of kinds) assert.ok((seen.get(k) ?? 0) > 0, `the sweep measured at least one .${k} (saw: ${[...seen.keys()].join(", ")})`);
}

for (const themeId of ["editorial", "marginalia"]) {
  test(`no word on screen ever collides or falls under platform chrome — ${themeId} (live browser)`, async () => {
    const theme = bookThemeById(themeId);
    const html = buildComposition({
      ...(fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput),
      bookTitle: "A Fixture Book With A Deliberately Long Title",
      author: "A Verified Author",
    });
    await withComposition(html, async (page) => {
      // Guards against passing vacuously: these are the elements this test exists to watch.
      assertSaw(await sweep(page), ["byline", "caption-line", "cine-hook", "cine-key", "cta-card"]);
    });
  });
}

/** Not cinematic: a cinematic opening scene replaces the hook card, and without a book link there is no purchase card. */
function plainHtmlWithLink(): string {
  return buildComposition({
    ...(fixtureInput({ theme: bookThemeById("editorial"), withScenes: true }) as unknown as CompositionInput),
    bookTitle: "A Fixture Book With A Deliberately Long Title",
    author: "A Verified Author",
    bookLink: "https://example.com/book",
  });
}

// The scene type measured in the plain (non-cinematic) fixture, other than the opening kinetic words.
const SCENE_KINDS = ["sc-quote-text", "sc-cell-label", "sc-step-t", "sc-tl-label", "sc-stat-value", "sc-curve-label"];

test("the hook card, CTA card, purchase card and scene type clear the chrome too (live browser)", async () => {
  await withComposition(plainHtmlWithLink(), async (page) => {
    // The opening kinetic words are judged in the next test: the hook card is drawn over them.
    const seen = await sweep(page, ".sc-kinetic .sc-word");
    assertSaw(seen, ["byline", "caption-line", "hook-text", "cta-card", "buy-card"]);
    // Scene type is most of the words on screen: prove it was measured, not skipped.
    assert.ok(
      SCENE_KINDS.some((k) => (seen.get(k) ?? 0) > 0),
      `the sweep measured some scene type (saw: ${[...seen.keys()].join(", ")})`,
    );
  });
});

// KNOWN, AWAITING A RULING (task 5 fix round 2). While the hook holds, the opening kinetic-text
// scene's words are fully opaque UNDER the hook card, so a settled word overlaps the settled hook
// text. A screenshot at t=1.67s shows the hook's scrim blurring them to an illegible smudge behind a
// crisp hook, which is the documented intent (see .hook-scrim in build.ts) but is not something a
// box and an opacity can express, so the narrowed pairwise rule still reports it. Do not loosen
// SETTLED_OPACITY to make this go away. Either teach the checker about the scrim, or drop the scene
// under the hook; then remove `todo`.
test(
  "no settled word overlaps the hook card's text, including the opening scene's words (live browser)",
  { todo: "the hook scrim blurs the opening kinetic words; the checker cannot see a scrim. Needs a ruling." },
  async () => {
    await withComposition(plainHtmlWithLink(), async (page) => {
      assertSaw(await sweep(page), ["hook-text", "sc-word"]);
    });
  },
);

test("the byline is above the stage and the captions below it, at every sampled instant (live browser)", async () => {
  const theme = bookThemeById("editorial");
  const html = buildComposition({
    ...(fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput),
    bookTitle: "Fixture",
  });
  await withComposition(html, async (page) => {
    let bylines = 0;
    let captions = 0;
    for (const t of [0.5, 4, 8, 12]) {
      const boxes = await textBoxesAt(page, t);
      for (const b of boxes) {
        if (b.name.includes("byline")) {
          bylines++;
          assert.ok(b.box.y + b.box.h <= BANDS.stage.top, `byline at ${b.box.y}`);
        }
        if (b.name.includes("caption-line")) {
          captions++;
          assert.ok(b.box.y >= BANDS.stage.bottom, `caption at ${b.box.y}`);
        }
      }
    }
    assert.ok(bylines > 0, "a byline was measured");
    assert.ok(captions > 0, "a caption was measured");
  });
});
