import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import type { BookTheme, ThemePalette } from "../src/lib/video/composition/theme-contract";
import {
  BOOK_THEMES,
  BOOK_THEME_IDS,
  DEFAULT_BOOK_THEME_ID,
  bookThemeById,
  isBookThemeId,
} from "../src/lib/video/composition/themes";
import { mix } from "../src/lib/video/composition/themes/color";
import { buildComposition, AUDIO_OFFSET } from "../src/lib/video/composition/build";
import { VIDEO_THEMES } from "../src/lib/strings";

/* ===========================================================================
 * The picker's promise
 *
 * The operator's complaint (spec 2026-08-23 §17) was that four of the five
 * themes the inspector names show COMING SOON and cannot be chosen. These
 * tests are what stop that from happening again in the other direction: a
 * theme that exists but is half-built — a palette role left blank, a surface
 * never dressed, a marker that quietly breaks a seek — is a worse failure than
 * one that was honestly unavailable, because it ships.
 * ======================================================================== */

const THEME_DIR = fileURLToPath(new URL("../src/lib/video/composition/themes/", import.meta.url));

/** The four built for §17. Marginalia predates them and is checked separately
 *  wherever a rule was introduced with this work rather than before it. */
const NEW_THEME_IDS = ["terminal", "editorial", "spotlight", "blueprint"] as const;

const ALL = Object.entries(BOOK_THEMES) as [string, BookTheme][];

/** Every role the contract declares, taken from the reference implementation.
 *  `tsc` already forces each theme to supply all of them; this is what catches
 *  a role supplied as an empty string, which compiles and renders nothing. */
const PALETTE_ROLES = Object.keys(BOOK_THEMES.marginalia.palette) as (keyof ThemePalette)[];

const fixture = (theme: BookTheme) => ({
  pkg: {
    title: "T",
    hook: "One page can change everything.",
    hookKeywords: ["change"],
    ideaKey: "k",
    cta: "Follow for more.",
    description: "",
    hashtags: [],
    takeaway: [],
    beats: [
      { id: "hook", voiceover: "A hook.", onScreen: "Hook", emoji: "🔥", sourcePage: 0, startWord: 0, endWord: 2 },
      { id: "cta", voiceover: "Follow.", onScreen: "Follow", sourcePage: 0, startWord: 3, endWord: 5 },
    ],
  },
  beats: [
    { index: 0, text: "A hook.", file: "b0.wav", start: 0, end: 2, speechStart: 0.1, speechEnd: 1.9 },
    { index: 1, text: "Follow.", file: "b1.wav", start: 2, end: 4, speechStart: 2.1, speechEnd: 3.9 },
  ],
  captions: [{ text: "A hook.", start: 0.1, end: 1.9, beatIndex: 0, words: [] }],
  pages: [{ src: "assets/page-00.jpg", width: 1000, height: 1400 }],
  sweeps: [
    [{ box: { x0: 0, y0: 0, x1: 500, y1: 40 }, start: 0.1, end: 1.9 }],
    [{ box: { x0: 0, y0: 60, x1: 500, y1: 100 }, start: 2.1, end: 3.9 }],
  ],
  camera: [{ t: 0, y: 0 }, { t: 4, y: 100 }],
  theme,
  totalDuration: 4,
  bookTitle: "Meditations",
  author: "Marcus Aurelius",
  bookLink: "https://example.com/book",
});

/** Source with comments removed — the prose in a theme file talks about
 *  "near-black" and about `rgba` scrims, and a lint that read the prose would
 *  be a lint nobody could keep passing. */
async function codeOf(id: string): Promise<string> {
  const raw = await fs.readFile(path.join(THEME_DIR, `${id}.ts`), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// --- The contract itself ----------------------------------------------------

test("every registered theme fills the whole contract", () => {
  assert.ok(ALL.length >= 5, "the picker offers five themes; the registry must hold five");

  for (const [id, theme] of ALL) {
    assert.equal(theme.id, id, `${id} is registered under a key that is not its own id`);
    assert.ok(
      ["calm", "warm", "driving", "sparse"].includes(theme.mood),
      // pipeline.ts maps `mood` to a music style. An unmapped value does not
      // throw — it silently falls through to the wrong bed, so the video plays
      // under music written for a different theme.
      `${id}.mood is "${theme.mood}", which pipeline.ts's MOOD_TO_STYLE cannot map`,
    );

    for (const surface of ["css", "backdrop", "cardFace", "overlay"] as const) {
      const out = theme[surface]();
      assert.equal(typeof out, "string", `${id}.${surface}() must return a string`);
      assert.ok(out.trim().length > 0, `${id}.${surface}() is empty — that surface is undressed`);
    }
  }
});

test("no palette role is left blank, on any theme", () => {
  for (const [id, theme] of ALL) {
    assert.deepEqual(
      Object.keys(theme.palette).sort(),
      [...PALETTE_ROLES].sort(),
      `${id}'s palette does not have exactly the contract's roles`,
    );
    for (const role of PALETTE_ROLES) {
      const value = theme.palette[role];
      assert.equal(typeof value, "string", `${id}.palette.${role} must be a string`);
      assert.ok(
        value.trim().length > 0,
        // An empty string is not a slightly-off colour: it is interpolated into
        // a CSS declaration the browser then drops silently, and no test that
        // only reads markup would ever notice.
        `${id}.palette.${role} is empty — the declaration it feeds will be dropped silently`,
      );
      assert.ok(
        /^(#[0-9a-f]{3,8}|rgba?\()/i.test(value.trim()),
        `${id}.palette.${role} ("${value}") is not a colour the composition can paint`,
      );
    }
  }
});

test("a stroke is one element carrying one scaleX, on every theme", () => {
  for (const [id, theme] of ALL) {
    const markup = theme.strokeMarkup(3).trim();

    assert.equal(
      (markup.match(/</g) ?? []).length,
      2,
      // Exactly one opening tag and one closing tag. A second element inside
      // the stroke is a second thing to animate, and the marker must stay a
      // single element driven by a single scaleX tween: two tweens on one
      // property are order-dependent, and order does not survive a seek.
      `${id}.strokeMarkup must be ONE element, got: ${markup}`,
    );
    assert.match(markup, /data-stroke="3"/, `${id}'s stroke must carry its index for the timeline to find it`);
    assert.match(markup, /class="[^"]*\bstroke\b/, `${id}'s stroke must carry the shared .stroke class`);
    assert.match(
      markup,
      /transform:\s*scaleX\(0\)/,
      `${id}'s stroke must rest at scaleX(0) — the timeline grows it from there`,
    );
    assert.ok(!/<script/i.test(markup), `${id}'s stroke markup must never carry script`);
  }
});

// --- Rules this composition has been burned by ------------------------------

test("no theme reintroduces a CSS animation, a transition, or a bottom offset", () => {
  for (const [id, theme] of ALL) {
    const css = theme.css();
    // Seeking cannot reproduce a CSS animation's state: the renderer never
    // plays forward, it jumps to a timestamp and screenshots.
    assert.doesNotMatch(css, /@keyframes/, `${id} declares @keyframes`);
    assert.doesNotMatch(css, /(^|[;{\s])animation\s*:/, `${id} declares a CSS animation`);
    assert.doesNotMatch(css, /(^|[;{\s])transition\s*:/, `${id} declares a CSS transition`);
    // `bottom:` on an absolutely positioned element never painted at all in the
    // real renderer — see build.ts's CAPTION_BASELINE doc comment.
    assert.doesNotMatch(css, /(^|[;{\s])bottom\s*:/, `${id} positions something with bottom instead of top`);
    // Nothing may be fetched: the composition renders offline, and a font or
    // image URL renders as a silent fallback rather than as an error.
    assert.doesNotMatch(css, /url\(\s*['"]?(https?:)?\/\//i, `${id} loads an external asset`);
    assert.doesNotMatch(css, /@import/, `${id} imports a stylesheet`);
    assert.doesNotMatch(css, /Math\.random/, `${id} is not deterministic`);
  }
});

test("no theme writes a transform onto an element GSAP already drives", () => {
  const forbidden = ["card-drift", "card-sweep-band", "scaler", "column", "progress-fill"];
  for (const [id, theme] of ALL) {
    const css = theme.css();
    for (const cls of forbidden) {
      // GSAP writes the WHOLE transform property when it tweens any component
      // of it, so a theme's transform here does not compose — it is either
      // erased on the first tween (a jump) or erases the tween's own work.
      // `[;{\s]` before the property name so `text-transform:` — which several
      // themes do set — is not mistaken for `transform:`.
      const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*[;{\\s]transform\\s*:`);
      assert.doesNotMatch(css, rule, `${id} declares a transform on .${cls}, which the timeline drives`);
    }
  }
});

test("a theme that re-tilts the cue keeps the translate that centres it, and never puts it on .annot", () => {
  for (const [id, theme] of ALL) {
    const css = theme.css();

    // `.annot` and `.cue` have equal specificity and theme CSS is appended
    // last, so a transform on `.annot` silently drops `.cue`'s translateX(-50%)
    // and the cue card slides half its own width off centre.
    // `[;{\s]` before the property name: `text-transform:` is a different
    // property and several themes legitimately set it here.
    assert.doesNotMatch(
      css,
      /\.annot\s*\{[^}]*[;{\s]transform\s*:/,
      `${id} declares a transform on .annot — it will drop the translateX that centres the cue`,
    );

    const cueRule = css.match(/\.cue\s*\{([^}]*)\}/);
    if (cueRule && /[;{\s]transform\s*:/.test(cueRule[1])) {
      assert.match(
        cueRule[1],
        /translateX\(-50%\)/,
        `${id} restates .cue's transform without translateX(-50%) — the cue will not be centred`,
      );
    }
  }
});

test("the four new themes take every colour from their own palette", async () => {
  // The rule exists because a hex literal buried in `css()` is what let
  // Marginalia's hook keyword drift out of sync with the thumbnail renderer.
  // Marginalia itself is exempt here rather than rewritten: changing its CSS to
  // satisfy a test would move the pixels of the one theme that has already
  // shipped video.
  for (const id of NEW_THEME_IDS) {
    const code = await codeOf(id);
    const body = code.slice(code.indexOf("export const"));
    assert.ok(body.length > 0, `${id} must export its theme`);

    const hex = body.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    assert.deepEqual(hex, [], `${id} paints a raw hex outside its palette: ${hex.join(", ")}`);
    const fn = body.match(/\brgba?\(/g) ?? [];
    assert.deepEqual(fn, [], `${id} paints a raw rgb()/rgba() outside its palette`);
    for (const named of ["white", "black", "silver", "yellow", "orange"]) {
      assert.ok(
        !new RegExp(`:\\s*${named}\\b`).test(body),
        `${id} paints the named colour "${named}" instead of a palette role`,
      );
    }
  }
});

// --- Genuinely different themes, not four recolours -------------------------

test("no two themes share a ground, an accent, a marker or a caption", () => {
  for (const role of ["backdropDeep", "accent", "marker", "captionBg", "cardFace"] as const) {
    const seen = new Map<string, string>();
    for (const [id, theme] of ALL) {
      const value = theme.palette[role].toLowerCase();
      const clash = seen.get(value);
      assert.equal(clash, undefined, `${id} and ${clash} share the same ${role} (${value})`);
      seen.set(value, id);
    }
  }
});

test("each theme dresses its surfaces differently, and the four new ones set their own type", async () => {
  const bodies = ALL.map(([id, t]) => [id, t.css()] as const);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      assert.notEqual(bodies[i][1], bodies[j][1], `${bodies[i][0]} and ${bodies[j][0]} emit identical CSS`);
    }
  }

  // Every theme must actually restyle the surfaces §17 lists, not inherit the
  // skeleton's palette-derived defaults for them.
  for (const [id, theme] of ALL) {
    const css = theme.css();
    for (const selector of [
      ".backdrop",
      ".card ",
      ".card-face",
      ".stroke",
      ".annot",
      ".caption-line",
      ".hook-text",
      ".cta-card",
      ".buy-card",
      ".byline",
      ".progress-fill",
    ]) {
      assert.ok(css.includes(selector), `${id} never dresses ${selector.trim()}`);
    }
  }

  // A theme with no font-family of its own reads as Marginalia in another
  // colour, which is exactly what §17 asked not to be built.
  for (const id of NEW_THEME_IDS) {
    const css = BOOK_THEMES[id].css();
    assert.ok(
      (css.match(/font-family/g) ?? []).length >= 4,
      `${id} barely sets any type of its own`,
    );
  }
});

test("the four new themes take the four different music beds between them", () => {
  // `mood` is the only thing a theme says about sound. Two themes may share one
  // (Editorial and Marginalia are both warm on purpose), but the four built for
  // §17 were each written against a different bed's brief, and a mood copied
  // from another theme means a video scored for the wrong picture.
  const moods = NEW_THEME_IDS.map((id) => BOOK_THEMES[id].mood);
  assert.deepEqual([...new Set(moods)].sort(), ["calm", "driving", "sparse", "warm"]);
  assert.equal(BOOK_THEMES.terminal.mood, "sparse", "Terminal is minor, unhurried, no brightness");
  assert.equal(BOOK_THEMES.editorial.mood, "warm", "Editorial is the friendliest of the four");
  assert.equal(BOOK_THEMES.spotlight.mood, "driving", "Spotlight is the punchiest of the set");
  assert.equal(BOOK_THEMES.blueprint.mood, "calm", "Blueprint is the calm, documentary one");
});

// --- The registry the controller resolves through ---------------------------

test("every theme the inspector names resolves to a real theme", () => {
  for (const option of VIDEO_THEMES) {
    assert.ok(
      isBookThemeId(option.id),
      `the UI offers "${option.id}" but the registry cannot resolve it — that is the COMING SOON bug`,
    );
    assert.equal(bookThemeById(option.id).id, option.id);
  }
  assert.deepEqual(
    BOOK_THEME_IDS.slice().sort(),
    VIDEO_THEMES.map((t) => t.id).sort(),
    "the registry and the picker have drifted apart",
  );
});

test("an unstored, unknown or hostile theme id renders the default rather than failing a paid-for render", () => {
  for (const bad of [null, undefined, "", "   ", "Terminal", "marginália", 7, {}, [], "toString", "__proto__", "constructor"]) {
    const theme = bookThemeById(bad as string | null | undefined);
    assert.equal(
      theme.id,
      DEFAULT_BOOK_THEME_ID,
      `bookThemeById(${JSON.stringify(bad)}) must fall back to ${DEFAULT_BOOK_THEME_ID}`,
    );
    // Not a prototype method dressed as a theme: the column is a plain String,
    // so "toString" genuinely can arrive here.
    assert.equal(typeof theme.css, "function");
    assert.ok(theme.palette.accent.length > 0);
  }

  for (const id of BOOK_THEME_IDS) {
    assert.equal(bookThemeById(id).id, id);
  }
});

// --- The whole composition, per theme ---------------------------------------

test("every theme builds a composition that keeps the shared skeleton's guarantees", () => {
  for (const [id, theme] of ALL) {
    const html = buildComposition(fixture(theme));

    assert.equal((html.match(/<script[\s>]/g) ?? []).length, 3, `${id}: gsap + data island + timeline`);
    assert.doesNotMatch(html, /@keyframes|animation\s*:/, `${id} put a CSS animation into the document`);
    assert.doesNotMatch(html, /Math\.random/, `${id} made a render non-deterministic`);
    assert.match(html, /paused:\s*true/, `${id}: the timeline must still start paused`);

    // Every element §17 says a theme must dress is present and styled.
    for (const marker of [
      'class="card"',
      'class="stroke"',
      'class="cue annot"',
      'class="caption-line"',
      'class="hook-text"',
      'class="cta-card"',
      'id="buy-card"',
      'id="byline"',
      'id="progress"',
    ]) {
      assert.ok(html.includes(marker), `${id}'s composition is missing ${marker}`);
    }

    // The theme's own CSS is appended after the shared rules, so it wins ties.
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    assert.ok(styles.endsWith(theme.css()), `${id}'s css() must be the last thing in the stylesheet`);

    const fromTos = html.match(/fromTo\(/g) ?? [];
    const guarded = html.match(/immediateRender:\s*false/g) ?? [];
    assert.ok(guarded.length >= fromTos.length, `${id}: every non-zero fromTo must be guarded`);
  }
});

test("every theme actually paints, in a real browser", async () => {
  const browser = await chromium.launch();
  try {
    for (const [id, theme] of ALL) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
      try {
        await page.setContent(buildComposition(fixture(theme)), { waitUntil: "load" });
        await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

        // Mid-first-beat: the marker is drawing, the caption is up, the hook is
        // still holding the frame.
        // No named inner function inside this callback: tsx compiles the test
        // with esbuild's keepNames, which wraps a named arrow in a `__name`
        // helper that does not exist inside the page — the evaluate then fails
        // with "__name is not defined" rather than with anything about themes.
        const seen = await page.evaluate((t) => {
          (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(t);
          const wanted: [string, string, string[]][] = [
            ["stroke", '[data-stroke="0"]', ["background-color", "background-image", "mix-blend-mode", "transform"]],
            ["caption", ".caption-line", ["background-color", "color", "font-family"]],
            ["cue", ".cue", ["font-family", "transform"]],
            ["hookKey", ".hook-key", ["color"]],
            ["byline", "#byline", ["color", "font-family", "visibility"]],
            ["card", ".card", ["background-color", "box-shadow"]],
            ["backdrop", ".backdrop", ["background-image"]],
            ["progress", "#progress", ["background-color", "background-image"]],
          ];
          const out: Record<string, Record<string, string> | null> = {};
          for (const [name, sel, props] of wanted) {
            const el = document.querySelector(sel);
            if (!el) {
              out[name] = null;
              continue;
            }
            const cs = getComputedStyle(el);
            const values: Record<string, string> = {};
            for (const prop of props) values[prop] = cs.getPropertyValue(prop);
            out[name] = values;
          }
          return out;
        }, AUDIO_OFFSET + 1);

        for (const [name, value] of Object.entries(seen)) {
          assert.ok(value, `${id}: ${name} is not in the document at all`);
        }

        // A stroke with no paint is an invisible highlight — the product.
        const strokePaint =
          seen.stroke!["background-image"] !== "none" || seen.stroke!["background-color"] !== "rgba(0, 0, 0, 0)";
        assert.ok(strokePaint, `${id}: the marker has no paint`);
        // The marker must sit UNDER the words, not over them.
        assert.equal(seen.stroke!["mix-blend-mode"], "multiply", `${id}: the marker must multiply over the print`);

        // The hook keyword is the one colour the thumbnails also have to know.
        assert.equal(
          seen.hookKey!.color,
          mix(theme.palette.hookKey, theme.palette.hookKey, 0),
          `${id}: .hook-key is not painted in palette.hookKey`,
        );

        assert.notEqual(seen.caption!["background-color"], "rgba(0, 0, 0, 0)", `${id}: the caption has no plate`);
        assert.equal(seen.byline!.visibility, "visible", `${id}: the byline must be on screen at every instant`);
        assert.notEqual(seen.backdrop!["background-image"], "none", `${id}: the backdrop is flat`);
        assert.ok(
          seen.progress!["background-image"] !== "none" || seen.progress!["background-color"] !== "rgba(0, 0, 0, 0)",
          `${id}: the progress bar has no fill`,
        );

        // Whatever tilt a theme chose, the cue is still centred.
        assert.ok(
          seen.cue!.transform === "none" || /matrix/.test(seen.cue!.transform),
          `${id}: unexpected cue transform ${seen.cue!.transform}`,
        );
        const cueBox = await page.evaluate(() => {
          const el = document.querySelector(".cue");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { centre: r.left + r.width / 2, width: r.width };
        });
        assert.ok(cueBox, `${id}: the cue must exist`);
        assert.ok(
          Math.abs(cueBox!.centre - 540) < 40,
          `${id}: the cue card is off centre (${cueBox!.centre.toFixed(0)}px) — a transform on .annot drops translateX(-50%)`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
