import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildComposition, type CompositionInput } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { gridViolations, BANDS, type Box } from "../src/lib/video/composition/frame";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

/** Every element on the frame that carries words, and where it actually is. */
const TEXT_SELECTORS = ".byline, .caption-line, .cta-card, #buy-card, .hook-text, .sc-cine .cine-key, .sc-cine .cine-lead, .sc-cine .cine-hook";

async function textBoxesAt(page: import("playwright-core").Page, t: number) {
  return within(
    page.evaluate(
      ({ time, sel }) => {
        (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl.seek(time, false);
        const out: { name: string; box: { x: number; y: number; w: number; h: number } }[] = [];
        document.querySelectorAll(sel).forEach((el, i) => {
          const cs = getComputedStyle(el as HTMLElement);
          if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          out.push({
            name: `${(el as HTMLElement).className || el.tagName}#${i}`,
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        });
        return out;
      },
      { time: t, sel: TEXT_SELECTORS },
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
    await run(page);
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser.close();
  }
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
      const kind = b.name.split("#")[0].split(" ").pop() as string;
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    const bad = gridViolations(boxes as { name: string; box: Box }[]);
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

test("the hook card, CTA card and purchase card clear the chrome too (live browser)", async () => {
  // Not cinematic: a cinematic opening scene replaces the hook card, and without a
  // book link there is no purchase card, so the run above never sees either.
  const html = buildComposition({
    ...(fixtureInput({ theme: bookThemeById("editorial"), withScenes: true }) as unknown as CompositionInput),
    bookTitle: "A Fixture Book With A Deliberately Long Title",
    author: "A Verified Author",
    bookLink: "https://example.com/book",
  });
  await withComposition(html, async (page) => {
    assertSaw(await sweep(page), ["byline", "caption-line", "hook-text", "cta-card", "buy-card"]);
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
