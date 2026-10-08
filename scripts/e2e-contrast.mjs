// Is scene text actually legible against what sits behind it?
//
// Found by inspecting a real render: the `steps` template painted its numbered
// chips but its step TEXT was invisible — the words were present in the markup
// ("Lost dignity", "Look foolish", ...) and simply could not be seen. The rule
// in this repo is that a colour claim must be measured in a browser and never
// read off the CSS, so this resolves the computed colours and reports the WCAG
// contrast ratio of every text element inside a scene against its own backdrop.
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

// Body text at these sizes needs 4.5:1 to be comfortable; 3:1 is the large-text
// floor. Anything under 2 is not "low contrast", it is invisible.
const FLOOR = 3.0;

const PROBE = () => {
  const lum = (c) => {
    const [r, g, b] = c;
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => {
    const m = (s || "").match(/-?[\d.]+/g);
    if (!m) return null;
    return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]];
  };
  // Composite a colour over whatever is behind it, walking up until something
  // opaque is found — "transparent" text on a dark card is still dark.
  const behind = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0.55) return bg;
      n = n.parentElement;
    }
    return [0, 0, 0, 1];
  };

  const out = [];
  for (const el of document.querySelectorAll(".sc [class*='sc-'], .sc [class*='cine-']")) {
    const text = (el.textContent || "").trim();
    if (!text || el.children.length > 0) continue; // leaf text nodes only
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = behind(el);
    const L1 = lum(fg);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    out.push({
      cls: el.className,
      text: text.slice(0, 28),
      size: Math.round(parseFloat(cs.fontSize)),
      fg: cs.color,
      bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
      ratio: +ratio.toFixed(2),
    });
  }
  return out;
};

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
let bad = 0;
let checked = 0;
try {
  for (const [id, theme] of Object.entries(BOOK_THEMES)) {
    const html = buildComposition(fixtureInput({ theme, withScenes: true }));
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    try {
      await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__tl), { timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready);
      const rows = await page.evaluate(PROBE);
      const seen = new Set();
      for (const r of rows) {
        const key = `${id}|${r.cls}`;
        if (seen.has(key)) continue; // one report per class per theme
        seen.add(key);
        checked++;
        if (r.ratio < FLOOR) {
          bad++;
          console.error(
            `[${id}] .${r.cls} "${r.text}" ${r.size}px  ${r.fg} on ${r.bg}  contrast ${r.ratio}:1` +
              (r.ratio < 1.6 ? "   <-- EFFECTIVELY INVISIBLE" : ""),
          );
        }
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${checked} text element(s) measured across ${Object.keys(BOOK_THEMES).length} themes; ${bad} below ${FLOOR}:1.`);
process.exit(bad ? 1 : 0);
