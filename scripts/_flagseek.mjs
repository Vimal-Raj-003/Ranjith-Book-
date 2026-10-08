// Is the reworked summit flag seek-safe, and does it actually move?
//
// The renderer seeks to timestamps in a non-linear order across parallel
// workers, so an effect whose state depends on HOW a timestamp was reached
// paints two different frames for the same instant. The flag's cloth is driven
// by an update that rewrites every vertex, which is exactly the shape that gets
// this wrong: if it nudged vertices from wherever they ended up last frame, the
// flag would depend on render order.
//
// This drives the hero's own `update(t, p)` directly through window.CINE and
// compares the VERTEX BUFFER. That is better evidence than a screenshot — it
// tests the geometry the effect actually computes, with no GPU rasterisation
// noise to explain away — and far cheaper, which matters because the
// screenshot version of this check hung Playwright.
//
// It also asserts the cloth MOVES between timestamps, so a flag frozen flat
// cannot pass this by being trivially identical everywhere.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

const runtime = await import("node:fs/promises").then((fs) =>
  fs.readFile("src/lib/video/scenes/cine-runtime.js", "utf8"),
);

await page.setContent("<!doctype html><body></body>");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js" });
await page.addScriptTag({ content: runtime });
await page.waitForFunction(() => Boolean(window.CINE && window.THREE), { timeout: 20_000 });

const out = await page.evaluate(() => {
  const cine = window.CINE.create({ THREE: window.THREE, width: 540, height: 960, light: false });
  const hero = cine.ensure("mountain");

  // The cloth is the only geometry in the mountain with 15x8 = 120 vertices
  // (from its 14x7 segments) — found by shape rather than by a handle the
  // runtime would have to expose purely for this test.
  let flag = null;
  const scan = (o) => {
    const g = o.geometry;
    if (g && g.attributes && g.attributes.position && g.attributes.position.count === 120) flag = g;
    (o.children || []).forEach(scan);
  };
  scan(hero.group);
  if (!flag) return { error: "flag geometry not found" };

  const snap = (t) => {
    hero.update(t, 0.5);
    return Array.from(flag.attributes.position.array).map((n) => Math.round(n * 1e5) / 1e5);
  };

  const rows = [];
  for (const t of [5.5, 6.0, 6.5, 7.0]) {
    const a = snap(t);
    snap(t + 1.7); // seek forward past it
    snap(Math.max(0, t - 1.7)); // and back behind it
    const b = snap(t);
    // z-range across the cloth: 0 would mean a flat board, not a flag.
    const zs = a.filter((_, i) => i % 3 === 2);
    rows.push({
      t,
      same: JSON.stringify(a) === JSON.stringify(b),
      zRange: Math.max(...zs) - Math.min(...zs),
      // The hoist edge (first column of vertices) must stay pinned at x = -W/2.
      hoistX: a[0],
      sig: a.slice(-9).join(","),
    });
  }
  return { rows };
});

if (out.error) {
  console.error(out.error);
  process.exit(1);
}

let bad = 0;
for (const r of out.rows) {
  if (!r.same) bad++;
  console.log(
    `t=${r.t}  ${r.same ? "same after seeking away and back" : "DIFFERENT"}` +
      `  cloth z-range ${r.zRange.toFixed(3)}  hoist x ${r.hoistX.toFixed(3)}`,
  );
}
const moved = new Set(out.rows.map((r) => r.sig)).size;
console.log(`\ndistinct cloth shapes across ${out.rows.length} timestamps: ${moved}`);
if (bad) console.error(`${bad} timestamp(s) NOT seek-safe`);
else if (moved < out.rows.length) console.error("the cloth is not moving between timestamps");
else console.log("flag is seek-safe AND animating at every sampled timestamp");
await browser.close();
process.exit(bad || moved < out.rows.length ? 1 : 0);
