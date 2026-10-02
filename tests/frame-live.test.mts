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

/** One measured element: where it is, how visible it is, and whether the hook layer is drawn over it. */
interface Measured {
  name: string;
  opacity: number;
  behindHook: boolean;
  box: { x: number; y: number; w: number; h: number };
}

async function textBoxesAt(page: import("playwright-core").Page, t: number): Promise<Measured[]> {
  return within(
    page.evaluate(
      ({ time, sel, ink }) => {
        (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl.seek(time, false);
        const out: Measured[] = [];
        // The hook layer is a full-frame, pointer-events:none element, so elementFromPoint cannot see it
        // (it would report whatever is underneath as topmost). Decide "behind the hook" structurally instead.
        const hook = document.querySelector(".hook");
        let hookOpacity = 0;
        if (hook && getComputedStyle(hook).visibility !== "hidden") {
          hookOpacity = 1;
          for (let n: Element | null = hook; n; n = n.parentElement) hookOpacity *= Number(getComputedStyle(n).opacity);
        }
        const hookShowing = hookOpacity > 0.05;
        document.querySelectorAll(sel).forEach((el, i) => {
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
            behindHook: hookShowing && !(hook as Element).contains(el),
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        });
        return out;
      },
      { time: t, sel: TEXT_SELECTORS, ink: INK_SELECTORS },
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
function frameViolations(items: Measured[]): string[] {
  const out = new Set<string>();
  for (const item of items) for (const v of gridViolations([item])) out.add(v);
  // Occlusion, modelled: while the hook layer is showing, everything not inside it is behind its blur
  // scrim (14px backdrop-filter, build.ts .hook-scrim), which turns the opening scene's words into an
  // illegible smudge behind a crisp hook headline. HOOK_TEXT_LEAD exists so the hook's words finish
  // leaving before the scrim thins: the design says these are never legible together. A box and an opacity
  // cannot express a scrim, so without this the checker reports the intended look as a collision.
  // This is PAIRWISE-ONLY. A covered element is still held to the frame and the platform chrome above,
  // because where an element sits matters whether or not something is covering it right now. It is NOT a
  // way to silence a failure: once the hook is gone nothing is behind it, so scene text is compared again.
  const settled = items.filter((i) => i.opacity >= SETTLED_OPACITY && !i.behindHook);
  for (const v of gridViolations(settled)) out.add(v);
  return [...out];
}

/**
 * Scrub the whole timeline and judge every word on screen. Returns how many boxes
 * of each kind were actually measured, so a caller can prove the sweep saw the
 * element it claims to be guarding rather than passing over an empty page.
 */
async function sweep(page: import("playwright-core").Page): Promise<Map<string, number>> {
  const duration = await page.evaluate(() => (window as unknown as { __tl: { duration(): number } }).__tl.duration());
  // 24 even steps, plus the very start and the very end, which is where the hook
  // card and the CTA / purchase cards live.
  const instants = [0.1, ...Array.from({ length: 24 }, (_, i) => (duration * (i + 0.5)) / 24), duration - 0.2];
  const seen = new Map<string, number>();
  for (const t of instants) {
    const boxes = await textBoxesAt(page, t);
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

// The scene type measured in the plain (non-cinematic) fixture.
const SCENE_KINDS = ["sc-word", "sc-quote-text", "sc-cell-label", "sc-step-t", "sc-tl-label", "sc-stat-value", "sc-curve-label"];

test("the hook card, CTA card, purchase card and scene type clear the chrome too (live browser)", async () => {
  await withComposition(plainHtmlWithLink(), async (page) => {
    const seen = await sweep(page);
    assertSaw(seen, ["byline", "caption-line", "hook-text", "cta-card", "buy-card"]);
    // Scene type is most of the words on screen: prove it was measured, not skipped.
    assert.ok(
      SCENE_KINDS.some((k) => (seen.get(k) ?? 0) > 0),
      `the sweep measured some scene type (saw: ${[...seen.keys()].join(", ")})`,
    );
  });
});

test("while the hook holds, the scrimmed scene is not compared pairwise; once it is gone, scene text is (live browser)", async () => {
  await withComposition(plainHtmlWithLink(), async (page) => {
    // During the hold: the hook's own words are on screen, and the opening scene beneath them is behind
    // the scrim. No violation is reported, but only because that scene was recognised as covered.
    const during = await textBoxesAt(page, 1.67);
    assert.ok(during.some((m) => m.name.includes("hook-text") && !m.behindHook), "the hook's own text is on screen and is not itself treated as covered");
    const under = during.filter((m) => m.name.includes("sc-word"));
    assert.ok(under.length > 0, "the opening scene's words are on screen under the hook");
    assert.ok(under.every((m) => m.behindHook), "and every one of them is recognised as behind the hook");
    assert.ok(
      under.some((m) => m.opacity >= SETTLED_OPACITY),
      "at least one is fully opaque, so only the scrim exempts it from the pairwise check",
    );
    assert.deepEqual(frameViolations(during), [], "no violation while the scrim holds");
    // The scrimmed words are still held to the frame and the chrome: the exemption is pairwise-only.
    const moved = during.map((m) => (m.behindHook ? { ...m, box: { ...m.box, y: 1800 } } : m));
    assert.ok(frameViolations(moved).some((v) => v.includes("reaches into")), "a covered element is still checked against the platform chrome");

    // After the hook has gone: nothing is covered, so the exemption cannot be silencing the rest of the
    // video, and the scene text IS compared against everything again.
    let sceneTextAfter = 0;
    for (const t of [4.5, 6, 8, 10, 12, 14.5]) {
      const after = await textBoxesAt(page, t);
      assert.ok(after.every((m) => !m.behindHook), `nothing is behind the hook at t=${t}`);
      sceneTextAfter += after.filter((m) => /sc-(word|quote-text|cell-label|step-t|tl-label|stat-value|curve-label)/.test(m.name)).length;
      assert.deepEqual(frameViolations(after), [], `at t=${t}`);
      // Prove the guard is live here: a settled scene word with a second settled box stacked on it must be reported.
      const settledScene = after.filter((m) => m.name.includes("sc-") && m.opacity >= SETTLED_OPACITY);
      if (settledScene.length > 0) {
        const clash = [...after, { ...settledScene[0], name: "probe", box: settledScene[0].box }];
        assert.ok(frameViolations(clash).some((v) => v.includes("overlaps")), `a settled overlap is reported at t=${t}`);
      }
    }
    assert.ok(sceneTextAfter > 0, "scene text was measured after the hook");
  });
});

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
