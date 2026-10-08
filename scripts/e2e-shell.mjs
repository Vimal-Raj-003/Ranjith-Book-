// Workspace-shell harness: drives the real signed-in app in Chromium, saves a
// screenshot of every pane at every supported width, and measures the things a
// unit test cannot see — the height of the inspector column, horizontal
// overflow, clipped controls, console errors and failed requests.
//
// Why this exists rather than another assertion in `npm test`: the operator's
// complaint about the workspace ("there is no collapsible things", "reduce the
// width", "try to minimalize") is entirely about layout, and layout only exists
// once a browser has laid it out. The suite renders the inspector to a string
// and can tell you the markup is right while the column runs 200px off the
// bottom of a 1440x780 laptop.
//
// The session: the app is behind an emailed sign-in code, so a run inserts ONE
// `Session` row, records its id, and deletes it in a `finally` — then reads the
// row back to prove the delete landed. Earlier work in this project left rows
// behind twice; the verification is the point, not the delete.
//
//   node scripts/e2e-shell.mjs                 # against the running dev server
//   BASE=http://localhost:3013 OUT=.ov/after node scripts/e2e-shell.mjs
//   TAG=before node scripts/e2e-shell.mjs      # writes .ov/shell/before/*
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3013";
const TAG = process.env.TAG ?? "after";
const OUT = process.env.OUT ?? path.join(".ov", "shell", TAG);
// No default address in here. `SHOT_EMAIL` names the account to borrow a
// session from; without it the harness takes the oldest real user in the
// database, skipping the `@example.test` rows the test suites leave behind.
const EMAIL = process.env.SHOT_EMAIL ?? null;

/** Every width the shell claims to have a shape for, plus the two laptops. */
const VIEWPORTS = [
  { name: "1440x780", width: 1440, height: 780 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1024x768-tablet", width: 1024, height: 768 },
  { name: "390x844-mobile", width: 390, height: 844 },
];

/** The panes, by the sidebar button that opens each. */
// Located by `data-view` rather than by their label: a collapsed rail renames
// each button to "Go to Studio" so the glyph still has a sentence for a name,
// and a harness that matched on text would stop finding them exactly when the
// collapsed state is what is being tested.
const VIEWS = [
  { name: "studio", nav: "studio" },
  { name: "books", nav: "books" },
  { name: "library", nav: "library" },
  { name: "free-books", nav: "free-books" },
];

// `:visible` matters: both the folded strip and the full nav are in the DOM at
// all times now (the inactive one carries `hidden`, which is what keeps the
// collapse toggle from being unmounted), so there are always two buttons per
// view and only one of them can be clicked.
const navTo = (page, id) => page.locator(`[data-view="${id}"]:visible`).first();

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/**
 * Measure what the brief asks to be measured, from inside the page.
 *
 * `scrollWidth > clientWidth` on the documentElement is horizontal overflow of
 * the page; the per-pane check catches a pane that overflows inside its own
 * clamped box, which is the form this app can actually produce. "Clipped"
 * means a focusable control whose box falls outside its scroll container's box
 * in the cross axis — a button you cannot reach by any amount of scrolling.
 */
const PROBE = () => {
  const out = {};
  const doc = document.documentElement;
  out.pageOverflowX = doc.scrollWidth - doc.clientWidth;
  out.pageOverflowY = doc.scrollHeight - doc.clientHeight;

  const pane = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // The laid-out height of the pane's own content, which is the number that
    // says whether the column ends above the fold.
    let content = 0;
    for (const child of el.children) {
      const cr = child.getBoundingClientRect();
      content = Math.max(content, cr.bottom - r.top);
    }
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      contentHeight: Math.round(content),
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
    };
  };

  out.side = pane(".app-side");
  out.work = pane(".app-work");
  out.insp = pane(".app-insp");

  // The theme picker specifically: this is the control that grew from five
  // chips to eleven, and the only honest way to say what that cost is to read
  // the grid's own box.
  const stageEl = document.querySelector(".preview-stage");
  out.stage = stageEl
    ? { w: Math.round(stageEl.getBoundingClientRect().width), h: Math.round(stageEl.getBoundingClientRect().height) }
    : null;

  const grid = document.querySelector(".app-insp .chip-grid");
  out.themeGrid = grid ? Math.round(grid.getBoundingClientRect().height) : null;
  out.themeGridScroll = grid ? grid.scrollHeight : null;
  // And the resting height of every top-level group in the rail, so a column
  // that stops fitting can be blamed on something in particular.
  out.inspGroups = [...document.querySelectorAll(".app-insp .insp-groups > *")].map((el) => ({
    tag: el.tagName.toLowerCase(),
    open: el.hasAttribute("open"),
    label: (el.querySelector("summary")?.textContent ?? el.textContent ?? "").trim().slice(0, 34),
    h: Math.round(el.getBoundingClientRect().height),
  }));

  // Controls whose box has zero area, or which stick out of the box that is
  // drawn around them. The first version of this only tested against SCROLL
  // containers, which is why it reported "clipped: 0" while the rights select
  // was poking 5px through the right border of its card at 1440x780: a card
  // does not clip, it just has a border, and the control crossing it is the
  // whole defect. Both ancestors are checked now.
  const clipped = [];
  for (const el of document.querySelectorAll("button, a[href], select, input, summary, [role=button]")) {
    // `checkVisibility`, not `getComputedStyle(el).display`: the latter reports
    // the element's OWN display, so every control inside a closed <details>
    // reads as a visible zero-size button. That false positive is what the
    // first run of this harness produced.
    if (!el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      clipped.push({ why: "zero-size", tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40) });
      continue;
    }
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
    for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
      const bs = getComputedStyle(box);
      const scrolls = ["hidden", "auto", "scroll"].includes(bs.overflowX);
      // A painted left or right border means something is drawn around this
      // control, and a control crossing that line looks broken whether or not
      // the box clips.
      const framed = parseFloat(bs.borderLeftWidth) > 0 || parseFloat(bs.borderRightWidth) > 0;
      if (!scrolls && !framed) continue;
      const br = box.getBoundingClientRect();
      if (r.right > br.right + 1 || r.left < br.left - 1) {
        clipped.push({
          why: scrolls ? "outside-scrollbox-x" : "through-card-border",
          tag: el.tagName.toLowerCase(),
          label,
          by: Math.round(Math.max(r.right - br.right, br.left - r.left)),
          box: (typeof box.className === "string" ? box.className : "").slice(0, 40),
        });
      }
      break;
    }
  }
  out.clipped = clipped;

  // Titles that are being cut off. A `truncate` that is actually truncating is
  // invisible to every assertion in the suite and obvious to the operator.
  out.truncated = [...document.querySelectorAll(".truncate")]
    .filter((el) => el.checkVisibility() && el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({
      text: (el.textContent || "").trim().slice(0, 48),
      shown: el.clientWidth,
      needs: el.scrollWidth,
      inEpisodeCard: Boolean(el.closest(".episode-head")),
    }))
    .slice(0, 12);

  // Who is actually sticking out. A page-level `scrollWidth - clientWidth` of
  // 12 tells you there is a problem and nothing about where, which is how a
  // horizontal scrollbar survives a dozen "no overflow" checks.
  if (out.pageOverflowX > 0) {
    const limit = doc.clientWidth;
    out.overflowCulprits = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > limit + 0.5)
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
        right: Math.round(el.getBoundingClientRect().right),
        limit,
      }));
  }
  return out;
};

/** Probe the page and file it under one key. */
async function record(page, findings, key) {
  const probe = await page.evaluate(PROBE);
  findings.measurements[key] = {
    side: probe.side, work: probe.work, insp: probe.insp,
    stage: probe.stage,
    themeGrid: probe.themeGrid, themeGridScroll: probe.themeGridScroll, inspGroups: probe.inspGroups,
    pageOverflowX: probe.pageOverflowX, pageOverflowY: probe.pageOverflowY,
    overflowCulprits: probe.overflowCulprits,
  };
  if (probe.clipped.length) findings.clipped[key] = probe.clipped;
  if (probe.truncated.length) findings.truncated[key] = probe.truncated;
  return probe;
}

/**
 * Open a finished episode in the Studio, via the Library, exactly as an
 * operator would.
 *
 * Everything this harness measured on its first run was the EMPTY state: no
 * episode selected, so no thumbnails grid, no publish copy, no run cards, no
 * download. That is the state least likely to overflow anything, and measuring
 * only it is how a column that is fine empty and 200px too tall loaded gets
 * reported as fine.
 */
async function openFinishedEpisode(page) {
  await navTo(page, "library").click();
  await page.waitForSelector('[data-pane="library"]', { timeout: 30_000 });
  // The grid shows skeleton tiles (also `.library-card`) until the fetch
  // lands; `[aria-label]` is only on the real ones, and without waiting the
  // harness decides there are no episodes and measures the empty state again.
  const card = page.locator(".library-card[aria-label]").first();
  try {
    await card.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await navTo(page, "studio").click();
    await page.waitForSelector('[data-pane="studio"]', { timeout: 30_000 });
    return false;
  }
  await card.click();
  await page.waitForSelector('[data-pane="studio"]', { timeout: 30_000 });
  // The episode poll is on a 1.5s tick and the panels fill from it.
  await page.waitForTimeout(3000);
  return true;
}

async function shot(page, dir, name) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function main() {
  // `file:./dev.db` in `.env.local` is resolved by Prisma relative to the
  // schema directory, not the cwd — the file is `prisma/dev.db`, and a client
  // constructed from the cwd would silently open an empty one instead.
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.SHOT_DATABASE_URL ?? `file:${path.resolve("prisma/dev.db")}` } },
  });

  const user = EMAIL
    ? await prisma.user.findFirst({ where: { email: EMAIL } })
    : await prisma.user.findFirst({
        where: { NOT: { email: { endsWith: "@example.test" } } },
        orderBy: { createdAt: "asc" },
      });
  if (!user) {
    throw new Error(
      EMAIL
        ? `No user ${EMAIL} in the database — sign in once in the browser first.`
        : "No real user in the database — sign in once in the browser, or set SHOT_EMAIL.",
    );
  }

  const token = crypto.randomBytes(32).toString("base64url");
  // Short-lived on purpose: 30 minutes is longer than this harness takes and
  // shorter than anything that could be mistaken for a real login.
  const session = await prisma.session.create({
    data: { tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 30 * 60_000) },
  });
  console.log(`session ${session.id} created for ${user.email}`);

  let browser;
  const findings = { consoleErrors: [], failedRequests: [], measurements: {}, clipped: {}, truncated: {}, shots: [] };

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORTS[0] });
    await context.addCookies([
      { name: "bookreel_session", value: token, url: BASE, httpOnly: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();

    page.on("console", (m) => {
      if (m.type() === "error") findings.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("requestfailed", (r) => {
      findings.failedRequests.push(`${r.method()} ${r.url().replace(BASE, "")} — ${r.failure()?.errorText}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400) findings.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`);
    });

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector(".app-shell", { timeout: 120_000 });
      await page.waitForTimeout(600);
      // Both rails expanded is the state the app starts in, but localStorage
      // survives inside one context — clear it so each width is measured from
      // the shipped default rather than from whatever the last width left.
      await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k.startsWith("bookreel.")) localStorage.removeItem(k);
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector(".app-shell", { timeout: 120_000 });
      await page.waitForTimeout(600);

      const dir = path.join(OUT, vp.name);

      for (const v of VIEWS) {
        const nav = navTo(page, v.nav);
        if (await nav.count()) {
          await nav.click();
          // Wait for the pane itself, not for a stopwatch: a probe that runs
          // while the previous view is still painted measures the old tree.
          await page.waitForSelector(`[data-pane="${v.name}"]`, { timeout: 30_000 });
          // The Book-PDF pane loads its book, then its episodes, then a
          // preview panel. Measuring before that lands measures an empty pane
          // and misses the layout that actually overflowed.
          if (v.name === "books") await page.waitForSelector(".preview-stage", { timeout: 20_000 }).catch(() => {});
          await page.waitForTimeout(1200);
        }
        findings.shots.push(await shot(page, dir, `${v.name}-rails-expanded`));
        await record(page, findings, `${vp.name}/${v.name}/expanded`);
      }

      // Back to the studio, then collapse both rails if the controls exist.
      const studio = navTo(page, "studio");
      if (await studio.count()) { await studio.click(); await page.waitForSelector('[data-pane="studio"]'); await page.waitForTimeout(400); }

      const sideToggle = page.locator("[data-rail-toggle=side]").first();
      const inspToggle = page.locator("[data-rail-toggle=insp]").first();
      if ((await sideToggle.count()) && (await inspToggle.count())) {
        await sideToggle.click();
        await inspToggle.click();
        await page.waitForTimeout(400);
        findings.shots.push(await shot(page, dir, "studio-rails-collapsed"));
        await record(page, findings, `${vp.name}/studio/collapsed`);

        // Persistence: a reload must come back collapsed.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.waitForSelector(".app-shell", { timeout: 120_000 });
      await page.waitForTimeout(600);
        await page.waitForTimeout(300);
        const stillCollapsed = await page.evaluate(() => {
          const s = document.querySelector(".app-shell");
          return { side: s?.getAttribute("data-side"), insp: s?.getAttribute("data-insp") };
        });
        findings.measurements[`${vp.name}/persisted-after-reload`] = stillCollapsed;

        await navTo(page, "books").click();
        await page.waitForSelector('[data-pane="books"]', { timeout: 30_000 });
        await page.waitForTimeout(400);
        findings.shots.push(await shot(page, dir, "books-rails-collapsed"));

        // Put them back for the next part.
        await navTo(page, "studio").click();
        await page.locator("[data-rail-toggle=side]").first().click();
        await page.locator("[data-rail-toggle=insp]").first().click();
        await page.waitForTimeout(400);

        // Keyboard focus must survive a fold. The toggle is meant to be the
        // same element in both states; if a rail re-renders a new one, focus
        // lands on <body> and a screen reader never hears aria-expanded flip.
        const sideBtn = page.locator("[data-rail-toggle=side]").first();
        await sideBtn.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(350);
        findings.measurements[`${vp.name}/focus-after-collapse`] = await page.evaluate(() => {
          const a = document.activeElement;
          return {
            kept: a?.getAttribute?.("data-rail-toggle") ?? null,
            expanded: a?.getAttribute?.("aria-expanded") ?? null,
          };
        });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(350);
      } else {
        findings.measurements[`${vp.name}/studio/collapsed`] = "no rail toggles in this build";
      }

      // --- the loaded state, which is the one that can actually overflow ---
      if (vp.name === "1440x780" || vp.name === "1920x1080") {
        if (await openFinishedEpisode(page)) {
          findings.shots.push(await shot(page, dir, "studio-episode-rails-expanded"));
          await record(page, findings, `${vp.name}/studio-episode/expanded`);

          // Every settings group open at once: the tallest the rail can be,
          // and the case the "+114px overflow" claim is really about.
          await page.evaluate(() => {
            for (const d of document.querySelectorAll(".insp-groups > details")) {
              d.dataset.wasOpen = d.open ? "1" : "0";
              d.open = true;
            }
          });
          await page.waitForTimeout(600);
          findings.shots.push(await shot(page, dir, "studio-episode-all-groups-open"));
          await record(page, findings, `${vp.name}/studio-episode/all-groups-open`);
          await page.evaluate(() => {
            for (const d of document.querySelectorAll(".insp-groups > details")) {
              d.open = d.dataset.wasOpen === "1";
              delete d.dataset.wasOpen;
            }
          });
          await page.waitForTimeout(300);

          await page.locator("[data-rail-toggle=side]").first().click();
          await page.locator("[data-rail-toggle=insp]").first().click();
          await page.waitForTimeout(500);
          findings.shots.push(await shot(page, dir, "studio-episode-rails-collapsed"));
          await record(page, findings, `${vp.name}/studio-episode/collapsed`);
          await page.locator("[data-rail-toggle=side]").first().click();
          await page.locator("[data-rail-toggle=insp]").first().click();
          await page.waitForTimeout(400);
        } else {
          findings.measurements[`${vp.name}/studio-episode`] = "no episode in the library to open";
        }
      }

      // --- the other theme -------------------------------------------------
      if (vp.name === "1440x780") {
        await navTo(page, "studio").click();
        await page.waitForSelector('[data-pane="studio"]', { timeout: 30_000 });
        await page.evaluate(() => {
          document.documentElement.setAttribute("data-theme", "dark");
          try { localStorage.setItem("bookreel-theme", "dark"); } catch {}
        });
        await page.waitForTimeout(500);
        findings.shots.push(await shot(page, dir, "studio-dark"));
        await record(page, findings, `${vp.name}/studio/dark`);
        await navTo(page, "books").click();
        await page.waitForSelector('[data-pane="books"]', { timeout: 30_000 });
        await page.waitForTimeout(1200);
        findings.shots.push(await shot(page, dir, "books-dark"));
        await record(page, findings, `${vp.name}/books/dark`);
        await page.evaluate(() => {
          document.documentElement.setAttribute("data-theme", "light");
          try { localStorage.setItem("bookreel-theme", "light"); } catch {}
        });
        await navTo(page, "studio").click();
        await page.waitForTimeout(300);
      }
    }

    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));

    console.log(`\n${findings.shots.length} screenshots under ${OUT}`);
    console.log(`console errors: ${findings.consoleErrors.length}`);
    for (const e of [...new Set(findings.consoleErrors)].slice(0, 10)) console.log(`  ! ${e}`);
    console.log(`failed requests: ${findings.failedRequests.length}`);
    for (const e of [...new Set(findings.failedRequests)].slice(0, 10)) console.log(`  ! ${e}`);
    for (const [k, v] of Object.entries(findings.clipped)) console.log(`  CLIPPED ${k}: ${JSON.stringify(v).slice(0, 400)}`);
    for (const [k, v] of Object.entries(findings.truncated)) console.log(`  truncated ${k}: ${JSON.stringify(v).slice(0, 400)}`);
    for (const [k, v] of Object.entries(findings.measurements)) {
      if (typeof v === "string" || !v.insp) { console.log(`  ${k}: ${JSON.stringify(v)}`); continue; }
      console.log(
        `  ${k}: side ${v.side?.width}px · work ${v.work?.width}px · insp ${v.insp.width}px ` +
          `content ${v.insp.contentHeight}px in ${v.insp.clientHeight}px (overflowY ${v.insp.overflowY}) ` +
          `· stage ${v.stage ? `${v.stage.w}x${v.stage.h}` : "-"} · themeGrid ${v.themeGrid ?? "-"}/${v.themeGridScroll ?? "-"}px ` +
          `· pageOverflowX ${v.pageOverflowX}`,
      );
      if (v.overflowCulprits?.length) console.log(`      overflow by: ${JSON.stringify(v.overflowCulprits).slice(0, 400)}`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    const left = await prisma.session.findUnique({ where: { id: session.id } }).catch(() => null);
    console.log(left ? `!! SESSION ${session.id} STILL PRESENT` : `session ${session.id} deleted and verified gone`);
    await prisma.$disconnect();
  }
}

await main();
