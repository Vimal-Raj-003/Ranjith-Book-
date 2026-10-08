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
import { buildComposition, AUDIO_OFFSET, CARD_W } from "../src/lib/video/composition/build";
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

/* ===========================================================================
 * The theme engine (2026-10-05)
 *
 * Six themes were added, as `ThemeSpec` data compiled by `themes/compile.ts`
 * rather than as six more 180-line modules. Every assertion above still applies
 * to them — they are in `ALL` — and these are the extra ones the new shape
 * makes possible to state.
 * ======================================================================== */

/** The six compiled from a spec. The five above predate the compiler. */
const ENGINE_THEME_IDS = ["academia", "atelier", "dossier", "quiet", "storybook", "neon"] as const;

test("the engine themes take every colour from their own palette too", async () => {
  // Same rule as the §17 four, and for the same reason: a colour that does not
  // trace back to a palette role is a colour the thumbnail renderer cannot know
  // about. The palette literal itself sits above `export const` in each file,
  // which is the slice this reads from — exactly as editorial.ts arranges it.
  for (const id of ENGINE_THEME_IDS) {
    const code = await codeOf(id);
    const body = code.slice(code.indexOf("export const"));
    assert.ok(body.length > 0, `${id} must export its theme`);
    assert.deepEqual(body.match(/#[0-9a-f]{3,8}\b/gi) ?? [], [], `${id} paints a raw hex outside its palette`);
    assert.deepEqual(body.match(/\brgba?\(/g) ?? [], [], `${id} paints a raw rgb()/rgba() outside its palette`);
  }
});

test("no engine theme is a recolour of another", () => {
  // The bar the operator set: "different palette AND typography AND motion AND
  // grain, not recolours". Palette is covered by the ground/accent/marker test
  // above; this is the other three. Any two themes must differ on at least
  // THREE of these six axes — one or two is a variation, three is a different
  // treatment.
  const axes = (id: string) => {
    const t = BOOK_THEMES[id as keyof typeof BOOK_THEMES];
    return [
      t.typography?.display ?? "(system)",
      t.typography?.caption ?? "chip",
      t.texture?.grain ?? "none",
      t.marker?.shape ?? "highlighter",
      String(t.optics?.perspective ?? 1700),
      String(t.optics?.sweepAngle ?? -8) + "/" + String(t.optics?.sweepWidth ?? 42),
    ];
  };
  for (let i = 0; i < ENGINE_THEME_IDS.length; i++) {
    for (let j = i + 1; j < ENGINE_THEME_IDS.length; j++) {
      const a = axes(ENGINE_THEME_IDS[i]);
      const b = axes(ENGINE_THEME_IDS[j]);
      const differing = a.filter((v, k) => v !== b[k]).length;
      assert.ok(
        differing >= 3,
        `${ENGINE_THEME_IDS[i]} and ${ENGINE_THEME_IDS[j]} differ on only ${differing} of six treatment axes — that is a recolour`,
      );
    }
  }
});

test("every engine theme introduces itself, and the picker's copy has not drifted from it", () => {
  // `strings.ts` cannot import a theme (the inspector is "use client" and a
  // theme module reaches build.ts), so its two lines per theme are a hand-copy.
  // A copy is only safe if something notices when it drifts — this is that,
  // the same guard the voice catalogue already has.
  for (const id of ENGINE_THEME_IDS) {
    const meta = BOOK_THEMES[id as keyof typeof BOOK_THEMES].meta;
    assert.ok(meta, `${id} has no meta — the picker would show an id and nothing else`);
    assert.ok(meta!.name.length > 0 && meta!.description.length > 0 && meta!.bestFor.length > 0);

    const option = VIDEO_THEMES.find((t) => t.id === id);
    assert.ok(option, `${id} is in the registry but not in the picker`);
    assert.equal(option!.label, meta!.name, `${id}'s picker label has drifted from its meta.name`);
    assert.equal(option!.description, meta!.description, `${id}'s picker description has drifted from its meta`);
    assert.equal(option!.bestFor, meta!.bestFor, `${id}'s picker best-for line has drifted from its meta`);
  }

  // Every theme the picker offers says what it looks like and what it is for,
  // including the five with no `meta` of their own.
  for (const option of VIDEO_THEMES) {
    assert.ok(option.description && option.description.length > 0, `${option.id} has no preview description`);
    assert.ok(option.bestFor && option.bestFor.length > 0, `${option.id} has no best-for line`);
  }
});

/**
 * A caption long enough to need two rows and to trip `captionFontSize`'s
 * step-down (anything over 34 characters is emitted at an inline 52px rather
 * than 60px). This is the sentence the defect was found on: at the inline size
 * Atelier and Quiet overflowed the two-row clamp and lost their last word.
 */
const LONG_CAPTION = "Successful entrepreneurs embrace uncertainty";

/** The same fixture, with a caption that actually stresses the clamp. */
function longCaptionFixture(theme: BookTheme) {
  const base = fixture(theme);
  return {
    ...base,
    pkg: { ...base.pkg, beats: base.pkg.beats.map((b) => ({ ...b, voiceover: LONG_CAPTION })) },
    beats: base.beats.map((b) => ({ ...b, text: LONG_CAPTION })),
    captions: [{ text: LONG_CAPTION, start: 0.1, end: 1.9, beatIndex: 0, words: [] }],
  };
}

/** First family in a stack, unquoted — what a computed `font-family` resolves to. */
const firstFamily = (stack: string) => stack.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

test("every typography and optics field a theme declares actually lands in the browser", async () => {
  /* This test exists because of a measured hole. The previous browser check
   * only read `font-family`, and so it passed while `typography.captionSize`
   * did nothing at all: `captionMarkup` writes `style="font-size:52px"` INLINE
   * on every `.caption-line`, an inline style beats a stylesheet rule, and all
   * eleven themes computed to 52px regardless of what they declared. A field
   * that is declared, documented and ignored is exactly the "do not fake
   * features" failure, so every declared value is now read back from the
   * document rather than trusted.
   *
   * `.cine-bokeh`, `.bokeh-dot` and `.cine-vignette` only appear on a render
   * that has a scene plan, so they are injected here rather than building a
   * whole cinematic composition per theme. That is sound for exactly one
   * reason, asserted below before it is relied on: `build.ts` gives those
   * elements no inline style for the properties a theme sets. */
  const scened = buildComposition({ ...fixture(BOOK_THEMES.marginalia) });
  assert.doesNotMatch(
    scened,
    /class="cine-bokeh"[^>]*style=|class="cine-vignette"[^>]*style=/,
    "build.ts now writes an inline style on a cinematic layer a theme restyles — injecting it below would stop proving anything",
  );
  assert.doesNotMatch(
    buildComposition({ ...fixture(BOOK_THEMES.marginalia) }),
    /class="bokeh-dot"[^>]*style="[^"]*(filter|opacity)/,
    "a bokeh dot now carries an inline filter/opacity, which would beat the theme's rule",
  );

  const browser = await chromium.launch();
  try {
    for (const id of ENGINE_THEME_IDS) {
      const theme = BOOK_THEMES[id as keyof typeof BOOK_THEMES];
      const t = theme.typography!;
      const o = theme.optics ?? {};
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
      try {
        await page.setContent(buildComposition(longCaptionFixture(theme)), { waitUntil: "load" });
        await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));
        await page.evaluate(() => document.fonts.ready);

        // No named inner function anywhere in this callback: tsx compiles the
        // test with esbuild's keepNames, which wraps a named arrow in a `__name`
        // helper that does not exist inside the page — the evaluate then fails
        // with "__name is not defined" rather than with anything about themes.
        const seen = await page.evaluate(() => {
          const stage = document.querySelector(".stage")!;
          // Built node by node rather than from a markup string: there is no
          // untrusted input here, but a test that reaches for innerHTML is a
          // pattern that gets copied into code where there is.
          const bokeh = document.createElement("div");
          bokeh.className = "cine-bokeh";
          const dot = document.createElement("div");
          dot.className = "bokeh-dot";
          bokeh.appendChild(dot);
          const cineVignette = document.createElement("div");
          cineVignette.className = "cine-vignette";
          stage.appendChild(bokeh);
          stage.appendChild(cineVignette);

          const wanted: [string, string, string[]][] = [
            ["caption", ".caption-line", ["font-family", "font-size", "font-weight", "letter-spacing", "text-transform", "border-radius", "padding-top"]],
            ["hook", ".hook-text", ["font-family", "font-size", "font-weight", "letter-spacing"]],
            ["byline", "#byline", ["font-family", "font-size", "font-weight", "letter-spacing", "font-style"]],
            ["stage", ".card-stage", ["perspective", "perspective-origin"]],
            ["sweep", ".card-sweep", ["transform", "mix-blend-mode"]],
            ["band", ".card-sweep-band", ["width", "filter"]],
            ["bokeh", ".cine-bokeh", ["opacity"]],
            ["dot", ".bokeh-dot", ["filter"]],
            ["cineVignette", ".cine-vignette", ["background-image"]],
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
          // Does the two-row clamp actually hold the whole sentence?
          const cap = document.querySelector(".caption-line") as HTMLElement | null;
          return { styles: out, captionFits: cap ? cap.scrollHeight <= cap.clientHeight + 1 : null };
        });

        const px = (v: string) => Math.round(parseFloat(v));
        // Tracking is compared to 0.05px rather than rounded, so a declared
        // 0.2px cannot pass by rounding to the same 0 as no tracking at all.
        // `normal` IS zero: Storybook declares "0px" and the browser hands
        // back "normal", which is the same type on screen.
        const track = (v: string) => (v.trim() === "normal" ? 0 : parseFloat(v));

        // --- typography -----------------------------------------------------
        assert.equal(px(seen.styles.caption!["font-size"]), t.captionSize, `${id}: caption is not the size it declares`);
        assert.equal(px(seen.styles.hook!["font-size"]), t.hookSize, `${id}: hook is not the size it declares`);
        assert.equal(px(seen.styles.byline!["font-size"]), t.bylineSize ?? 28, `${id}: byline is not the size it declares`);
        assert.equal(seen.styles.caption!["font-weight"], String(t.captionWeight), `${id}: caption weight`);
        assert.equal(seen.styles.hook!["font-weight"], String(t.displayWeight), `${id}: hook weight`);
        assert.equal(seen.styles.byline!["font-weight"], String(t.bodyWeight ?? 600), `${id}: byline weight`);
        assert.ok(
          Math.abs(track(seen.styles.caption!["letter-spacing"]) - track(t.captionTracking!)) < 0.05,
          `${id}: caption tracking is ${seen.styles.caption!["letter-spacing"]}, not ${t.captionTracking!}`,
        );
        assert.ok(
          Math.abs(track(seen.styles.hook!["letter-spacing"]) - track(t.displayTracking!)) < 0.05,
          `${id}: hook tracking is ${seen.styles.hook!["letter-spacing"]}, not ${t.displayTracking!}`,
        );
        assert.ok(
          Math.abs(track(seen.styles.byline!["letter-spacing"]) - track(t.bylineTracking!)) < 0.05,
          `${id}: byline tracking is ${seen.styles.byline!["letter-spacing"]}, not ${t.bylineTracking!}`,
        );
        assert.equal(seen.styles.byline!["font-style"], t.bylineStyle ?? "normal", `${id}: byline style`);
        assert.equal(
          seen.styles.caption!["text-transform"],
          t.captionCase === "uppercase" ? "uppercase" : "none",
          `${id}: caption case`,
        );
        assert.equal(firstFamily(seen.styles.caption!["font-family"]), firstFamily(t.body!), `${id}: caption family`);
        assert.equal(firstFamily(seen.styles.hook!["font-family"]), firstFamily(t.display!), `${id}: hook family`);
        assert.equal(firstFamily(seen.styles.byline!["font-family"]), firstFamily(t.body!), `${id}: byline family`);
        // The caption plate's shape, which is what `caption: "plate"` means.
        assert.equal(
          px(seen.styles.caption!["border-radius"]),
          t.caption === "plate" ? 0 : t.caption === "rule" ? 3 : 20,
          `${id}: caption plate shape`,
        );

        // The whole point of the declared sizes: a real sentence has to fit the
        // two-row clamp. At the inline 52px, Atelier and Quiet did not.
        assert.ok(seen.captionFits, `${id}: "${LONG_CAPTION}" overflows the two-line clamp and would be visibly cut`);

        // --- optics ---------------------------------------------------------
        assert.equal(px(seen.styles.stage!.perspective), o.perspective ?? 1700, `${id}: card-stage perspective`);
        // Resolved to pixels by the browser, so compared as numbers: `50% 38%`
        // of the 1080x1920 stage comes back as "540px 729.594px", not a tidy
        // 729.6, and a string compare would fail on the rounding rather than on
        // anything about the theme.
        const originPct = (o.perspectiveOrigin ?? "50% 38%").split(/\s+/).map((v) => parseFloat(v) / 100);
        const originPx = (seen.styles.stage!["perspective-origin"].match(/-?[\d.]+/g) ?? []).map(Number);
        assert.ok(
          Math.abs(originPx[0] - originPct[0] * 1080) < 1 && Math.abs(originPx[1] - originPct[1] * 1920) < 1,
          `${id}: perspective origin is ${seen.styles.stage!["perspective-origin"]}, not ${o.perspectiveOrigin ?? "50% 38%"}`,
        );
        assert.equal(px(seen.styles.band!.width), Math.round((CARD_W * (o.sweepWidth ?? 42)) / 100), `${id}: sweep band width`);
        assert.equal(seen.styles.band!.filter, `blur(${o.sweepBlur ?? 24}px)`, `${id}: sweep band blur`);
        assert.equal(seen.styles.sweep!["mix-blend-mode"], o.sweepBlend ?? "screen", `${id}: sweep blend`);
        // rotate(a) scale(s) composes to [s·cos a, s·sin a, -s·sin a, s·cos a].
        const a = ((o.sweepAngle ?? -8) * Math.PI) / 180;
        const s = o.sweepScale ?? 1.25;
        const m = (seen.styles.sweep!.transform.match(/-?[\d.]+/g) ?? []).map(Number);
        assert.ok(Math.abs(m[0] - s * Math.cos(a)) < 0.01 && Math.abs(m[1] - s * Math.sin(a)) < 0.01,
          `${id}: sweep is not rotated ${o.sweepAngle ?? -8}deg at scale ${s} — got ${seen.styles.sweep!.transform}`);
        assert.equal(Number(seen.styles.bokeh!.opacity), o.bokeh ?? 1, `${id}: bokeh intensity`);
        assert.equal(seen.styles.dot!.filter, `blur(${o.bokehBlur ?? 8}px)`, `${id}: bokeh blur`);
        if (o.cineVignette !== undefined) {
          assert.match(seen.styles.cineVignette!["background-image"], /radial-gradient/, `${id}: cine vignette is not painted`);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
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
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
