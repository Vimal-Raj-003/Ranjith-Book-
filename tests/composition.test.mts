import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  buildComposition,
  columnScale,
  cardViewportHeight,
  AUDIO_OFFSET,
  OUTRO_TAIL,
  FRAME,
  CARD_X,
  CARD_Y,
  CARD_W,
  CARD_H,
  CAPTION_BASELINE,
  BYLINE_Y,
  bylineText,
} from "../src/lib/video/composition/build";
import { cameraTrack } from "../src/lib/video/sweep";
import { marginalia } from "../src/lib/video/composition/themes/marginalia";
import { buildCaptions } from "../src/lib/media/captions";
import type { CaptionWord } from "../src/lib/media/captions";

const input = () => ({
  pkg: {
    title: "T", hook: "A hook.", ideaKey: "k", cta: "Follow.", description: "", hashtags: [], takeaway: [],
    beats: [
      { id: "hook", voiceover: "A hook.", onScreen: "Hook", sourcePage: 0, startWord: 0, endWord: 2 },
      { id: "cta", voiceover: "Follow.", onScreen: "Follow", sourcePage: 0, startWord: 3, endWord: 5 },
    ],
  },
  beats: [
    { index: 0, text: "A hook.", file: "b0.wav", start: 0, end: 2, speechStart: 0.1, speechEnd: 1.9 },
    { index: 1, text: "Follow.", file: "b1.wav", start: 2, end: 4, speechStart: 2.1, speechEnd: 3.9 },
  ],
  captions: [{ text: "A hook.", start: 0.1, end: 1.9, beatIndex: 0, words: [] as CaptionWord[] }],
  pages: [{ src: "assets/page-00.jpg", width: 1000, height: 1400 }],
  sweeps: [
    [{ box: { x0: 0, y0: 0, x1: 500, y1: 40 }, start: 0.1, end: 1.9 }],
    [{ box: { x0: 0, y0: 60, x1: 500, y1: 100 }, start: 2.1, end: 3.9 }],
  ],
  camera: [{ t: 0, y: 0 }, { t: 4, y: 100 }],
  theme: marginalia,
  totalDuration: 4,
  bookTitle: "T",
});

test("the composition is one self-contained file with a paused timeline", () => {
  const html = buildComposition(input());

  assert.ok(html.includes("<style"), "CSS is inline");
  assert.ok(!html.includes("<link rel=\"stylesheet\""), "nothing is fetched at render time");
  assert.match(html, /\.pause\(\)|paused:\s*true/, "the timeline must start paused — the renderer seeks it");
});

test("no CSS animation survives into the output", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /@keyframes|animation\s*:/, "seeking cannot reproduce a CSS animation's state");
});

test("nothing is random at render time", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /Math\.random/, "two renders of one frame must be identical");
});

test("every fromTo away from zero disables immediate render", () => {
  const html = buildComposition(input());
  const fromTos = html.match(/fromTo\(/g) ?? [];
  const guarded = html.match(/immediateRender:\s*false/g) ?? [];
  assert.ok(
    guarded.length >= fromTos.length,
    `${fromTos.length} fromTo calls but only ${guarded.length} immediateRender guards — a chain of them parks elements at the wrong offset`,
  );
});

test("a closing script tag in page text cannot end the embedded JSON early", () => {
  const evil = input();
  evil.pkg.beats[0].onScreen = "</script><b>gotcha";

  const html = buildComposition(evil);
  const payload = html.split("id=\"composition-data\"")[1] ?? "";
  assert.ok(!payload.slice(0, 4000).includes("</script><b>"), "'<' must be escaped inside embedded JSON");
});

test("the timeline runs at least as long as the audio", () => {
  const html = buildComposition(input());
  const match = html.match(/data-duration="([\d.]+)"/);
  assert.ok(match, "the duration is declared for the renderer");
  assert.ok(Number(match![1]) >= 4, "a composition shorter than its audio truncates the CTA");
});

// --- Beyond the brief's six -------------------------------------------------

test("escaping holds everywhere embedded data is written, not just in the JSON payload", () => {
  const evil = input();
  const nasty = `</script><tag>&"'`;
  evil.pkg.beats[0].onScreen = nasty;
  evil.captions[0].text = nasty;

  const html = buildComposition(evil);

  // If any of these characters closed a tag early, the document would not
  // have exactly the real <script> tags this composition actually declares
  // (gsap from the CDN, the JSON data island, the timeline script).
  const opens = html.match(/<script[\s>]/g) ?? [];
  const closes = html.match(/<\/script>/g) ?? [];
  assert.equal(opens.length, 3, "gsap cdn + composition-data + timeline js");
  assert.equal(closes.length, 3);

  // Both the on-screen cue label AND the caption line are written directly
  // as markup — captions are no longer populated later via .textContent
  // (see captionMarkup's own doc comment: a real hyperframes render left an
  // empty-at-load .caption-line stuck at its rest state forever, while a cue
  // — text present in the DOM from the start — animated correctly). A raw
  // "<tag>" appearing verbatim in either site means that site's escaping is
  // missing even though the JSON payload (checked below) is fine.
  assert.ok(!html.includes("<tag>"), "onScreen/caption text must be HTML-escaped where it is written as literal markup");
  assert.ok(html.includes("data-cue=\"0\""), "the cue card for beat 0 must still exist");
  assert.ok(html.includes("data-caption=\"0\""), "the caption line for beat 0 must still exist");

  // The SAME nasty text also travels through the JSON payload (read back by
  // the runtime script to time the fade, though no longer to set the text
  // itself). This asserts that site's escaping independently of the markup
  // site above — the two are separate injection surfaces and one being safe
  // says nothing about the other.
  const payload = html.split("id=\"composition-data\"")[1] ?? "";
  assert.ok(!payload.slice(0, 4000).includes("</script><tag>"), "caption text must be escaped inside the JSON payload too");
});

test("zero sweep steps still produces a valid composition (alignment failure is non-fatal)", () => {
  const degraded = input();
  degraded.sweeps = degraded.beats.map(() => []); // every beat's alignment failed

  const html = buildComposition(degraded);

  assert.ok(html.includes("<style"));
  assert.match(html, /paused:\s*true/);
  assert.ok(!html.includes("<div class=\"stroke\""), "no geometry means no stroke elements, not broken ones");
  assert.match(html, /class="page"/, "the page itself must still render");
  assert.match(html, /id="captions"/, "captions must still render with no highlight");
});

test("the declared duration covers the audio's own lead-in, not just its length plus the outro", () => {
  const html = buildComposition(input());
  const match = html.match(/data-duration="([\d.]+)"/);
  assert.ok(match);
  // totalDuration (4) + AUDIO_OFFSET (the audio element itself starts late,
  // per data-start on <audio>) + OUTRO_TAIL — a duration that only accounted
  // for totalDuration + OUTRO_TAIL would truncate the last AUDIO_OFFSET
  // seconds of the CTA hold.
  const expected = 4 + AUDIO_OFFSET + OUTRO_TAIL;
  assert.ok(Math.abs(Number(match![1]) - expected) < 1e-6, `expected ${expected}, got ${match![1]}`);
});

test("two strokes adjacent in time do not overlap", () => {
  const html = buildComposition(input());
  const match = html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, "the JSON data island must exist");
  const data = JSON.parse(match![1]) as { strokes: { start: number; end: number }[] };

  assert.ok(data.strokes.length >= 2, "the fixture has strokes from two different beats");
  for (let i = 1; i < data.strokes.length; i++) {
    assert.ok(
      data.strokes[i].start >= data.strokes[i - 1].end - 1e-9,
      `stroke ${i} starts (${data.strokes[i].start}) before stroke ${i - 1} ends (${data.strokes[i - 1].end})`,
    );
  }
});

// --- Review findings: the CTA must hold through the outro tail -------------

test("the last beat's cue is marked to hold, not to fade out at its own beat's end", () => {
  const html = buildComposition(input());
  const match = html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const data = JSON.parse(match![1]) as {
    cues: { start: number; end: number; hold: boolean }[];
    duration: number;
  };

  const lastCue = data.cues[data.cues.length - 1];
  assert.equal(lastCue.hold, true, "the CTA's cue must be flagged to hold rather than fade out");

  // The runtime only skips the fade-out `.to()` when `hold` is set — assert
  // that guard actually exists in the emitted script, not just that the data
  // says so. A `hold: true` the runtime script ignores would be exactly as
  // broken as no flag at all.
  const guard = html.match(/if \(!cue\.hold\)/);
  assert.ok(guard, "the runtime script must actually check cue.hold before fading a cue out");

  // The fade-IN completes well before the tail begins, so by the time the
  // held cue reaches `duration - 0.1` it has long since settled at full
  // opacity — there is no later event that could ever turn it off again.
  assert.ok(lastCue.start + 0.2 < data.duration - 0.1, "the fade-in must finish before the last tenth of a second");
});

test("tl.duration() and data-duration agree, and the CTA cue is genuinely visible through the tail (live browser)", async () => {
  const html = buildComposition(input());
  const declaredMatch = html.match(/data-duration="([\d.]+)"/);
  assert.ok(declaredMatch);
  const declaredDuration = Number(declaredMatch![1]);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    const tlDuration = await page.evaluate(
      () => (window as unknown as { __tl: { duration(): number } }).__tl.duration(),
    );
    assert.ok(
      Math.abs(tlDuration - declaredDuration) < 0.05,
      `tl.duration() (${tlDuration}) must match data-duration (${declaredDuration})`,
    );

    const styleAt = async (t: number) =>
      page.evaluate((time) => {
        (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
        const el = document.querySelector('[data-cue="1"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, visibility: cs.visibility };
      }, t);

    const nearEnd = await styleAt(declaredDuration - 0.1);
    assert.ok(nearEnd, "the CTA cue element must exist in the DOM");
    assert.equal(nearEnd!.visibility, "visible", "the CTA cue must still be visible just before the video ends");
    assert.ok(
      Number(nearEnd!.opacity) > 0.95,
      `the CTA cue's opacity at duration-0.1 was ${nearEnd!.opacity} — it should be holding near 1, not fading out`,
    );
  } finally {
    await browser.close();
  }
});

// --- Review round 3: a multi-word CTA splits into more than one caption line -

/**
 * The single-line CTA in `input()` above is exactly what let round 2's bug
 * through: with only one caption line for the last beat, "hold the last
 * beat's caption lines" and "hold the last CAPTION line" are indistinguishable.
 * A real multi-word call to action does not stay one line — `buildCaptions`
 * splits it every `wordsPerLine` (default 4) words — so this fixture drives
 * captions through the real `buildCaptions`, not a hand-rolled single line,
 * to make that split genuine rather than assumed.
 */
const multiLineInput = () => {
  const base = input();
  const beats = [
    { index: 0, text: "A hook.", file: "b0.wav", start: 0, end: 2, speechStart: 0.1, speechEnd: 1.9 },
    {
      index: 1,
      text: "Follow along for more book breakdowns.",
      file: "b1.wav",
      start: 2,
      end: 6,
      speechStart: 2.1,
      speechEnd: 5.9,
    },
  ];
  base.beats = beats;
  base.pkg.beats[1].voiceover = "Follow along for more book breakdowns.";
  base.captions = buildCaptions(beats); // 6 words, wordsPerLine=4 -> two lines, both beatIndex 1
  base.totalDuration = 6;
  return base;
};

test("only the truly final caption line holds — not every line belonging to the last beat", () => {
  const fixture = multiLineInput();
  const html = buildComposition(fixture);

  const match = html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const data = JSON.parse(match![1]) as { captions: { hold: boolean }[] };

  // The real split: the CTA's own narration produced more than one caption
  // line, both naming the last beat.
  assert.ok(
    data.captions.filter((_, i) => fixture.captions[i]?.beatIndex === 1).length >= 2,
    "the fixture must actually exercise a multi-line CTA, or this test proves nothing",
  );

  const holdFlags = data.captions.map((c) => c.hold);
  const lastIndex = holdFlags.length - 1;
  holdFlags.forEach((hold, i) => {
    if (i === lastIndex) {
      assert.equal(hold, true, "the truly final caption line must hold");
    } else {
      assert.equal(hold, false, `caption line ${i} belongs to the last beat but is not its final line — it must fade out normally`);
    }
  });
});

test("a multi-line CTA never stacks two caption lines, and only the final line survives into the tail (live browser)", async () => {
  const fixture = multiLineInput();
  const html = buildComposition(fixture);
  const durationMatch = html.match(/data-duration="([\d.]+)"/);
  assert.ok(durationMatch);
  const duration = Number(durationMatch![1]);

  const linesMeta = fixture.captions.map((c) => ({
    start: AUDIO_OFFSET + c.start,
    end: AUDIO_OFFSET + c.end,
  }));
  assert.ok(linesMeta.length >= 3, "hook line + two CTA lines expected");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    const visibleCountAt = async (t: number) =>
      page.evaluate((time) => {
        (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
        return Array.from(document.querySelectorAll(".caption-line")).filter(
          (el) => Number(getComputedStyle(el).opacity) > 0.5,
        ).length;
      }, t);

    // Sample the midpoint of each CTA caption line's own window: never more
    // than one line visible at a time — the exact stacking failure the
    // reviewer's fixture caught.
    const [ctaLineA, ctaLineB] = linesMeta.slice(1);
    for (const t of [
      (ctaLineA.start + ctaLineA.end) / 2,
      (ctaLineB.start + ctaLineB.end) / 2,
      duration - 0.1,
    ]) {
      const count = await visibleCountAt(t);
      assert.ok(count <= 1, `more than one caption line visible at t=${t.toFixed(2)} (count=${count})`);
    }

    // Deep into the tail, only the FINAL line (the last of the two CTA
    // lines) may still be showing.
    const finalLineVisible = await page.evaluate((time) => {
      (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
      const lines = Array.from(document.querySelectorAll(".caption-line"));
      const last = lines[lines.length - 1];
      const cs = getComputedStyle(last);
      return { opacity: cs.opacity, visibility: cs.visibility };
    }, duration - 0.1);
    assert.ok(Number(finalLineVisible.opacity) > 0.95, "the final CTA line must hold near the very end");
    assert.equal(finalLineVisible.visibility, "visible");

    const earlierLineFaded = await page.evaluate((time) => {
      (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
      const lines = Array.from(document.querySelectorAll(".caption-line"));
      const earlier = lines[lines.length - 2];
      return Number(getComputedStyle(earlier).opacity);
    }, duration - 0.1);
    assert.ok(earlierLineFaded < 0.05, "the CTA's own first line must not still be lingering into the tail");
  } finally {
    await browser.close();
  }
});

// --- Framed layout (spec 2026-08-23 §1/§2) ---------------------------------

test("columnScale maps the column onto the card, and degrades to 1 rather than to Infinity or NaN", () => {
  assert.equal(columnScale(CARD_W), 1, "a column exactly as wide as the card needs no scaling");
  assert.ok(Math.abs(columnScale(1200) - CARD_W / 1200) < 1e-12);

  // The guard is not academic: `columnWidth` is `Math.max(...pages.map(p => p.width))`,
  // which is -Infinity for an empty page list and NaN if any derivative's width
  // failed to be measured. A `scale(NaN)` is DROPPED by the browser, silently
  // leaving the column at full 1600px size overflowing a 960px card, and a
  // non-finite scale also poisons cardViewportHeight and therefore cameraTrack.
  for (const bad of [0, -10, NaN, Infinity, -Infinity]) {
    const s = columnScale(bad);
    assert.equal(s, 1, `columnScale(${bad}) must fall back to 1, got ${s}`);
    assert.ok(Number.isFinite(s));
  }
});

test("cardViewportHeight is the card's height in COLUMN space, never the frame's height", () => {
  const width = 1200;
  const expected = CARD_H / (CARD_W / width);
  assert.ok(Math.abs(cardViewportHeight(width) - expected) < 1e-9);

  // The whole point: a column wider than the card produces a viewport TALLER
  // than CARD_H, and it must not be confused with FRAME.height. Handing
  // cameraTrack 1920 makes maxY (= pageHeight - frameHeight) hundreds of column
  // pixels too small, so the camera stops early and the marker runs out of the
  // bottom of the card.
  assert.ok(cardViewportHeight(width) > CARD_H, "a scaled-down column sees more column pixels than the card is tall");
  assert.notEqual(cardViewportHeight(width), FRAME.height);

  // The guard propagates: a degenerate width gives a finite viewport, not NaN.
  for (const bad of [0, NaN, Infinity]) {
    assert.equal(cardViewportHeight(bad), CARD_H, `cardViewportHeight(${bad}) must be finite`);
  }
});

test("the page scrolls inside a card, and the scale sits on .scaler where GSAP can never write it", () => {
  const html = buildComposition(input());

  assert.match(html, /class="card"/, "the page must sit on a card, not fill the frame");
  assert.match(html, new RegExp(`left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px`));
  assert.match(html, /\.card \{[^}]*overflow:hidden/, "the card is the window the column scrolls behind");

  // The column is 1000px wide in the fixture; the static scale is CARD_W/1000.
  const expected = (CARD_W / 1000).toFixed(6);
  assert.ok(
    html.includes(`<div class="scaler" style="transform:scale(${expected});">`),
    "the column->card scale must be a static inline transform on .scaler",
  );

  // GSAP writes the WHOLE transform property when it tweens y. If the scale
  // were on .column it would be erased by the first camera key and the page
  // would jump to full size mid-video.
  assert.doesNotMatch(html, /y:\s*-key\.y[^}]*\}\s*,\s*key\.t\s*\)\s*;\s*[\s\S]{0,40}scaler/);
  const js = html.split('<script>')[1] ?? "";
  assert.ok(!js.includes('".scaler"') && !js.includes("'.scaler'"), "the runtime script must never touch .scaler");
  assert.ok(js.includes('getElementById("column")'), "the camera still tweens .column, in unscaled column pixels");
});

test("captions clear Instagram's chrome and are still positioned with top, never bottom", () => {
  const html = buildComposition(input());
  assert.equal(CAPTION_BASELINE, 1720);
  assert.match(html, new RegExp(`\\.caption-line \\{[^}]*top:${CAPTION_BASELINE}px`));
  // `bottom:` on an autoAlpha-driven absolutely positioned element never
  // painted at all in the real renderer — see the CAPTION_BASELINE doc comment.
  assert.doesNotMatch(html, /\.caption-line \{[^}]*bottom:/);
  assert.doesNotMatch(html, /\.hook-text \{[^}]*bottom:/);
  assert.doesNotMatch(html, /\.cta-card \{[^}]*bottom:/);
});

test("the progress bar is one scaleX over the whole duration", () => {
  const html = buildComposition(input());
  assert.match(html, /id="progress"/);
  assert.match(html, /tl\.to\(progress, \{ scaleX: 1, duration: Math\.max\(0\.001, data\.duration\)/);
});

// --- Hook card (spec §2.2) --------------------------------------------------

const withHook = (hook: string, hookKeywords?: string[]) => {
  const base = input();
  return { ...base, pkg: { ...base.pkg, hook, ...(hookKeywords ? { hookKeywords } : {}) } };
};

const hookText = (html: string) => {
  const m = html.match(/<div class="hook-text">([\s\S]*?)<\/div>/);
  return m ? m[1] : null;
};

test("hookKeywords are painted in the accent, case-insensitively and on word boundaries", () => {
  const html = buildComposition(withHook("The quiet Truth about truthful people.", ["truth"]));
  const text = hookText(html);
  assert.ok(text, "the hook card must render pkg.hook");

  // "Truth" matches with its own casing preserved; "truthful" must NOT match —
  // it is a longer word, not the keyword.
  assert.ok(text!.includes('<span class="hook-key">Truth</span>'), `expected the accent span, got: ${text}`);
  assert.ok(!text!.includes('<span class="hook-key">truth</span>ful'), "a keyword must not match inside a longer word");
  assert.equal((text!.match(/hook-key/g) ?? []).length, 1);
});

test("an absent, empty, or never-occurring hookKeywords renders the plain hook instead of throwing", () => {
  for (const keywords of [undefined, [], ["nowhere"], ["", "   "]]) {
    const html = buildComposition(withHook("A plain hook line.", keywords));
    const text = hookText(html);
    assert.equal(text, "A plain hook line.", `keywords=${JSON.stringify(keywords)} must render the hook unpainted`);
  }
});

test("hook text is escaped on both sides of an accent span", () => {
  const html = buildComposition(withHook(`</script><b>danger</b> & "quotes"`, ["danger"]));
  const text = hookText(html);
  assert.ok(text);
  assert.ok(!text!.includes("<b>"), "raw markup must never survive into the hook card");
  assert.ok(text!.includes('<span class="hook-key">danger</span>'), "the keyword itself is still painted");
  assert.equal((html.match(/<script[\s>]/g) ?? []).length, 3, "a </script> in the hook must not close a tag early");
});

test("the hook card's window ends at the end of beat 0, and it fades out before then", () => {
  const html = buildComposition(input());
  const match = html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const data = JSON.parse(match![1]) as { hook: { end: number; fadeAt: number } | null };

  assert.ok(data.hook, "the hook card must exist — pkg.hook is the single biggest retention lever");
  // Beat 0's measured clip end is 2, plus the AUDIO_OFFSET lead-in.
  assert.ok(Math.abs(data.hook!.end - (AUDIO_OFFSET + 2)) < 1e-9, `expected ${AUDIO_OFFSET + 2}, got ${data.hook!.end}`);
  assert.ok(data.hook!.fadeAt > 0 && data.hook!.fadeAt < data.hook!.end, "the fade must finish by beat 0's end, not start there");
});

test("no beats at all produces no hook card rather than one that never leaves", () => {
  const base = input();
  const empty = { ...base, pkg: { ...base.pkg, beats: [] }, beats: [], captions: [], sweeps: [] };
  const html = buildComposition(empty);

  assert.ok(!html.includes('id="hook"'), "with no beat 0 there is no honest moment to hand the page over at");
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    hook: unknown;
    pops: unknown[];
  };
  assert.equal(data.hook, null);
  assert.deepEqual(data.pops, []);
});

test("the CTA end card renders pkg.cta and holds to the end", () => {
  const html = buildComposition(input());
  assert.match(html, /<div class="cta-text">Follow\.<\/div>/);
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    cta: { start: number } | null;
    duration: number;
  };
  assert.ok(data.cta);
  assert.ok(data.cta!.start < data.duration, "the CTA card must actually appear inside the composition");
  // It fades in and is never faded back out: exactly one tween touches ctaEl,
  // and it is the fromTo. A `tl.to(ctaEl, ...)` anywhere would be a second
  // tween on the same property of the same element — the shape that does not
  // survive a seek — and would also blank the end card during the outro hold.
  const js = html.split("<script>")[1] ?? "";
  assert.ok(js.includes("tl.fromTo(ctaEl,"), "the CTA card fades in with a single guarded fromTo");
  assert.ok(!js.includes("tl.to(ctaEl,"), "the CTA card must never be faded back out — nothing follows it");
  assert.equal((js.match(/tl\.(to|fromTo)\(ctaEl,/g) ?? []).length, 1);
});

// --- Card pop (spec §2.3) ---------------------------------------------------

test("the card pop lives on its own wrapper, fires only on page changes, and never overlaps itself", () => {
  const base = input();
  // Three pages, four beats: pages 0,0,1,2 -> exactly two page changes.
  const pages = [
    { src: "assets/page-00.jpg", width: 1000, height: 1400 },
    { src: "assets/page-01.jpg", width: 1000, height: 1400 },
    { src: "assets/page-02.jpg", width: 1000, height: 1400 },
  ];
  const pkgBeats = [0, 0, 1, 2].map((sourcePage, i) => ({
    id: `b${i}`, voiceover: "x", onScreen: `B${i}`, sourcePage, startWord: 0, endWord: 1,
  }));
  const beats = pkgBeats.map((_, i) => ({
    index: i, text: "x", file: `b${i}.wav`, start: i * 2, end: i * 2 + 2,
    speechStart: i * 2 + 0.1, speechEnd: i * 2 + 1.9,
  }));
  const html = buildComposition({
    ...base, pages, pkg: { ...base.pkg, beats: pkgBeats }, beats,
    sweeps: pkgBeats.map(() => []), totalDuration: 8,
  });

  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    pops: { t: number; d: number; from: number }[];
  };
  assert.equal(data.pops.length, 2, "one pop per page change — not one per beat, and not one per camera key");
  assert.ok(Math.abs(data.pops[0].t - (AUDIO_OFFSET + 4)) < 1e-9);
  assert.ok(Math.abs(data.pops[1].t - (AUDIO_OFFSET + 6)) < 1e-9);

  // Two overlapping fromTos on one property of one element are order-dependent,
  // and order is exactly what a seek does not preserve.
  for (let i = 1; i < data.pops.length; i++) {
    assert.ok(
      data.pops[i].t >= data.pops[i - 1].t + data.pops[i - 1].d,
      `pop ${i} starts at ${data.pops[i].t}, before pop ${i - 1} ends at ${data.pops[i - 1].t + data.pops[i - 1].d}`,
    );
  }

  // The pop element must receive no other tween.
  const js = html.split("<script>")[1] ?? "";
  const popRefs = js.match(/\bpop\b(?!Refs)/g) ?? [];
  assert.ok(js.includes('getElementById("card-pop")'));
  assert.ok(popRefs.length > 0);
  assert.ok(!js.includes("tl.to(pop,"), ".card-pop must carry the scale fromTo and nothing else");
});

test("with a real cameraTrack call the marker never leaves the card (live browser)", async () => {
  // The controller's exact wiring: cameraTrack is given the card's viewport in
  // COLUMN space, not FRAME.height. This is the check that fails loudly if that
  // argument is ever swapped back.
  const base = input();
  const page = { src: "assets/page-00.jpg", width: 1000, height: 3000 };
  const steps = [0, 1, 2, 3, 4].map((i) => ({
    box: { x0: 60, y0: 200 + i * 600, x1: 700, y1: 250 + i * 600 },
    start: i * 1.5, end: i * 1.5 + 1.4,
  }));
  const pkgBeats = steps.map((_, i) => ({
    id: `b${i}`, voiceover: "x", onScreen: `B${i}`, sourcePage: 0, startWord: 0, endWord: 1,
  }));
  const beatAudio = steps.map((s, i) => ({
    index: i, text: "x", file: `b${i}.wav`, start: s.start, end: s.end,
    speechStart: s.start, speechEnd: s.end,
  }));
  const camera = cameraTrack(steps, cardViewportHeight(page.width), page.height);
  assert.ok(camera.length > 0, "the fixture must actually make the camera move");

  const html = buildComposition({
    ...base,
    pages: [page],
    pkg: { ...base.pkg, beats: pkgBeats },
    beats: beatAudio,
    captions: [],
    sweeps: steps.map((s) => [s]),
    camera,
    totalDuration: 7.5,
  });

  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await tab.setContent(html, { waitUntil: "load" });
    await tab.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    for (let i = 0; i < steps.length; i++) {
      const t = AUDIO_OFFSET + steps[i].end - 0.05; // the stroke is fully drawn
      const rects = await tab.evaluate(
        ({ time, index }) => {
          (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
          const strokeEl = document.querySelector(`[data-stroke="${index}"]`);
          const cardEl = document.getElementById("card");
          if (!strokeEl || !cardEl) return null;
          const s = strokeEl.getBoundingClientRect();
          const c = cardEl.getBoundingClientRect();
          return { s: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, c: { top: c.top, bottom: c.bottom, left: c.left, right: c.right } };
        },
        { time: t, index: i },
      );
      assert.ok(rects, `stroke ${i} and the card must both exist`);
      const { s, c } = rects!;
      assert.ok(s.top >= c.top - 1 && s.bottom <= c.bottom + 1, `stroke ${i} is outside the card vertically (${s.top}-${s.bottom} vs card ${c.top}-${c.bottom}) — the camera was given the wrong viewport height`);
      assert.ok(s.left >= c.left - 1 && s.right <= c.right + 1, `stroke ${i} is outside the card horizontally`);
    }
  } finally {
    await browser.close();
  }
});

// --- Byline (spec §9) -------------------------------------------------------

const bylineOf = (html: string) => {
  const m = html.match(/<div class="byline" id="byline">([\s\S]*?)<\/div>/);
  return m ? m[1] : null;
};

test("bylineText renders the author only when one was supplied, and never leaves punctuation behind", () => {
  assert.equal(bylineText("Meditations", "Marcus Aurelius"), "Meditations · Marcus Aurelius");

  // `author` is already null unless the four-link verification chain passed
  // upstream. Every "no verified author" shape must produce the bare title —
  // not "Title ·", not "Title · by", not "Title · Unknown".
  for (const missing of [null, undefined, "", "   "]) {
    const line = bylineText("Meditations", missing);
    assert.equal(line, "Meditations", `author=${JSON.stringify(missing)} must render the title alone`);
    assert.ok(!line!.includes("·"), "an absent author must not leave a separator behind");
    assert.ok(!/\bby\b/i.test(line!), "an absent author must never leave a dangling 'by'");
    assert.ok(!/unknown/i.test(line!), "a missing name is rendered as nothing, never as a placeholder");
  }

  // No title is no byline at all, rather than a strip containing only a name.
  for (const missing of [null, undefined, "", "   "]) {
    assert.equal(bylineText(missing, "Marcus Aurelius"), null);
  }
});

test("a very long title is truncated with an ellipsis rather than wrapping or overflowing, and never eats a verified name", () => {
  const long = "A Very Considerably Overlong Book Title That No Single Line Of Twenty-Eight Pixel Type Could Ever Hope To Hold";

  const alone = bylineText(long, null)!;
  assert.ok(alone.endsWith("…"), `expected an ellipsis, got: ${alone}`);
  assert.ok(alone.length < long.length, "the title must actually be shortened");
  assert.ok(!alone.includes("\n"), "the byline is a single line");

  // The name is what had to be verified to appear at all, so the ellipsis
  // lands on the TITLE — the opposite of what CSS overflow alone would do.
  const withAuthor = bylineText(long, "Marcus Aurelius")!;
  assert.ok(withAuthor.endsWith("Marcus Aurelius"), `the author must survive truncation, got: ${withAuthor}`);
  assert.ok(withAuthor.includes("… · "), `the ellipsis belongs to the title, got: ${withAuthor}`);
  assert.ok(
    Array.from(withAuthor).length <= Array.from(alone).length + " · Marcus Aurelius".length,
    "the combined line must not grow past the title-only budget plus the name",
  );

  // A surrogate pair must never be cut in half into a replacement glyph.
  const astral = "𝔊𝔬𝔱𝔥𝔦𝔠 ".repeat(20);
  assert.ok(!bylineText(astral, null)!.includes("�"));
});

test("the byline is rendered into the markup, positioned with top, and carries no tween at all", () => {
  const html = buildComposition({ ...input(), bookTitle: "Meditations", author: "Marcus Aurelius" });

  assert.equal(bylineOf(html), "Meditations · Marcus Aurelius");
  assert.match(html, new RegExp(`\\.byline \\{[^}]*top:${BYLINE_Y}px`));
  assert.equal(BYLINE_Y, 1388);
  // `bottom:` on an absolutely positioned element has burned this composition
  // before — see the CAPTION_BASELINE doc comment.
  assert.doesNotMatch(html, /\.byline \{[^}]*bottom:/);
  // One line, always: nowrap plus an ellipsis, never a second row of type
  // pushing down into the cue band at 1450.
  assert.match(html, /\.byline \{[^}]*white-space:nowrap/);
  assert.match(html, /\.byline \{[^}]*text-overflow:ellipsis/);

  const js = html.split("<script>")[1] ?? "";
  assert.ok(!js.includes("byline"), "the byline is persistent — the runtime script must never touch it");
});

test("no verified author and no title produce no placeholder markup anywhere", () => {
  const noAuthor = buildComposition({ ...input(), bookTitle: "Meditations", author: null });
  assert.equal(bylineOf(noAuthor), "Meditations");

  // A book with no usable title at all: the element is absent, not empty. The
  // controller always passes `bookTitle` now (it is a required field, so this
  // cannot silently go unwired), but an empty string still has to degrade to
  // no byline rather than to a bare separator.
  const nothing = buildComposition({ ...input(), bookTitle: "" });
  assert.ok(!nothing.includes('id="byline"'), "an empty byline strip is worse than no byline");
  assert.ok(!nothing.includes('class="byline"'));
});

// --- Emoji (spec §10) -------------------------------------------------------

const withEmoji = (emoji: unknown) => {
  const base = input();
  const beats = base.pkg.beats.map((b, i) => (i === 0 ? { ...b, emoji } : b));
  return { ...base, pkg: { ...base.pkg, beats: beats as unknown as typeof base.pkg.beats } };
};

test("a beat's emoji is painted beside its cue label, and never reaches anything spoken", () => {
  const html = buildComposition(withEmoji("🔥"));

  assert.match(html, /<div class="cue annot" data-cue="0"><span class="cue-emoji">🔥<\/span><span class="cue-label">Hook<\/span><\/div>/);
  // Beat 1 has no emoji: no empty span, so no stray leading gap on its card.
  assert.match(html, /<div class="cue annot" data-cue="1"><span class="cue-label">Follow<\/span><\/div>/);

  // §10: emoji may appear on the cue card and in social copy, NEVER in
  // anything spoken. `voiceover` is what reaches TTS, and it is untouched.
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    captions: { text: string }[];
  };
  for (const c of data.captions) {
    assert.ok(!c.text.includes("🔥"), "an emoji must never travel on a caption derived from the voiceover");
  }
});

test("an absent, empty or non-string emoji produces a plain cue rather than throwing", () => {
  for (const value of [undefined, "", "   ", 7, null, ["🔥"], { emoji: "🔥" }, true]) {
    let html: string;
    assert.doesNotThrow(() => {
      html = buildComposition(withEmoji(value));
    }, `emoji=${JSON.stringify(value)} must not throw`);
    html = buildComposition(withEmoji(value));
    assert.ok(
      !html.includes('<span class="cue-emoji">'),
      `emoji=${JSON.stringify(value)} must render no emoji span at all`,
    );
    assert.match(html, /<span class="cue-label">Hook<\/span>/, "the label itself must still render");
  }

  // The plain path — no `emoji` key on the beat object whatsoever, which is
  // what every package written before the field existed looks like.
  const html = buildComposition(input());
  assert.ok(!html.includes('<span class="cue-emoji">'));
  assert.ok(html.includes('data-cue="0"'));
});

test("an emoji field carrying markup or an essay is escaped and clipped, not obeyed", () => {
  const nasty = buildComposition(withEmoji(`</script><b>x`));
  assert.equal((nasty.match(/<script[\s>]/g) ?? []).length, 3, "a </script> in an emoji must not close a tag early");
  assert.ok(!nasty.includes("<b>x"), "emoji text is escaped like every other markup site");

  const essay = buildComposition(withEmoji("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥"));
  const span = essay.match(/<span class="cue-emoji">([\s\S]*?)<\/span>/);
  assert.ok(span);
  assert.ok(Array.from(span![1]).length <= 4, `a run of emoji is clipped, got ${span![1]}`);
});

// --- Purchase card (spec §11) ----------------------------------------------

test("a book link produces a final purchase card that says where the link is, never the URL itself", () => {
  const link = "https://example.com/book?ref=bookreel";
  const html = buildComposition({ ...input(), bookLink: link });

  assert.match(html, /<div class="buy-card" id="buy-card"/);
  assert.match(html, /<div class="buy-text">Link in the description<\/div>/);

  // The URL is unreadable at phone size and unclickable in a video. It may
  // exist as an escaped attribute, but never as painted text.
  const text = html.replace(/<[^>]*>/g, " ");
  assert.ok(!text.includes("example.com"), "the raw URL must never be rendered as on-screen text");
  assert.ok(html.includes(`data-book-link="${link.replace(/&/g, "&amp;")}"`), "the link travels as an escaped attribute");

  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    buy: { start: number } | null;
    cta: { start: number } | null;
    duration: number;
  };
  assert.ok(data.buy, "a supplied link must produce a purchase card");
  assert.ok(data.buy!.start > data.cta!.start, "the purchase card follows the CTA, it does not replace it");
  assert.ok(data.buy!.start < data.duration, "a card that starts at the end is a card nobody sees");

  // One tween, one property, one element — and never faded back out.
  const js = html.split("<script>")[1] ?? "";
  assert.equal((js.match(/tl\.(to|fromTo)\(buyEl,/g) ?? []).length, 1);
  assert.ok(js.includes("tl.fromTo(buyEl,"));
  assert.ok(!js.includes("tl.to(buyEl,"));
});

test("no book link means no purchase card at all — not an empty one, and not a placeholder", () => {
  for (const link of [undefined, null, "", "   ", "amazon.com/book", "javascript:alert(1)", "mailto:a@b.c", "not a url"]) {
    const html = buildComposition({ ...input(), bookLink: link });
    assert.ok(
      !html.includes('id="buy-card"'),
      `bookLink=${JSON.stringify(link)} must render no purchase card`,
    );
    assert.ok(!html.includes("Link in the description"), `bookLink=${JSON.stringify(link)} must render no purchase copy`);
    const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
      buy: unknown;
    };
    assert.equal(data.buy, null);
  }
});

// --- Motion (spec §8) -------------------------------------------------------

test("the depth drift is one tween on its own wrapper, and never on .scaler or .column", () => {
  const html = buildComposition(input());

  assert.match(html, /<div class="card-drift" id="card-drift">/);
  assert.match(html, /\.card-drift \{[^}]*transform-origin:50% 50%/);

  const js = html.split("<script>")[1] ?? "";
  assert.ok(js.includes('getElementById("card-drift")'), "the drift must have its own element");
  // Exactly one tween touches it, and it is a scale.
  assert.equal((js.match(/tl\.(to|fromTo)\(drift,/g) ?? []).length, 1);
  assert.match(js, /tl\.to\(drift, \{ scale: DRIFT_TO/);

  // The two forbidden targets. GSAP writes the WHOLE transform property, so a
  // drift on .scaler would erase the column->card scale and a drift on .column
  // would erase the camera — putting every marker in the video on the wrong
  // words while the highlight geometry itself stayed perfectly correct.
  assert.ok(!js.includes('".scaler"') && !js.includes("'.scaler'"), "the drift must never target .scaler");
  assert.ok(!/tl\.(to|fromTo)\(column, \{ scale/.test(js), "the drift must never target .column");
  assert.equal((js.match(/tl\.to\(column,/g) ?? []).length, 1, ".column carries the camera tween and nothing else");
});

test("the light sweep is a chain of non-overlapping fromTos on one band, tilted by a static parent", () => {
  const html = buildComposition(input());

  assert.match(html, /<div class="card-sweep"><div class="card-sweep-band" id="card-sweep"><\/div><\/div>/);
  // The rotation lives on the STATIC wrapper. On the band it would be erased
  // by the first xPercent tween — the .scaler mistake in miniature.
  assert.match(html, /\.card-sweep \{[^}]*transform:rotate\(/);
  assert.doesNotMatch(html, /\.card-sweep-band \{[^}]*rotate\(/);

  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    lightSweeps: { t: number; d: number }[];
    duration: number;
  };
  assert.ok(data.lightSweeps.length > 0, "the band must actually cross the card");
  assert.ok(data.lightSweeps.length <= input().beats.length, "once per beat, not once per stroke");
  for (let i = 1; i < data.lightSweeps.length; i++) {
    assert.ok(
      data.lightSweeps[i].t >= data.lightSweeps[i - 1].t + data.lightSweeps[i - 1].d,
      `sweep ${i} starts at ${data.lightSweeps[i].t}, before sweep ${i - 1} ends`,
    );
  }
  for (const s of data.lightSweeps) {
    assert.ok(s.d > 0 && s.t + s.d <= data.duration + 1e-9, "a pass must fit inside the composition");
  }

  const js = html.split("<script>")[1] ?? "";
  assert.ok(js.includes('getElementById("card-sweep")'));
  assert.ok(js.includes("immediateRender: false"), "every non-zero fromTo is guarded");
  assert.ok(!js.includes("tl.to(band,"), "the band carries the xPercent fromTos and nothing else");
});

test("drift and sweep leave the highlight geometry alone (live browser)", async () => {
  // The same shape as the cameraTrack check above, re-run with the motion in
  // place: if the drift amplitude ever grows enough to carry a marker out of
  // the card, this is what says so — and it says it about geometry, which is
  // what e2e:highlight measures on the other side of the pipeline.
  const base = input();
  const page = { src: "assets/page-00.jpg", width: 1000, height: 3000 };
  const steps = [0, 1, 2, 3, 4].map((i) => ({
    box: { x0: 60, y0: 200 + i * 600, x1: 700, y1: 250 + i * 600 },
    start: i * 1.5, end: i * 1.5 + 1.4,
  }));
  const pkgBeats = steps.map((_, i) => ({
    id: `b${i}`, voiceover: "x", onScreen: `B${i}`, sourcePage: 0, startWord: 0, endWord: 1,
  }));
  const beatAudio = steps.map((s, i) => ({
    index: i, text: "x", file: `b${i}.wav`, start: s.start, end: s.end,
    speechStart: s.start, speechEnd: s.end,
  }));

  const html = buildComposition({
    ...base,
    pages: [page],
    pkg: { ...base.pkg, beats: pkgBeats },
    beats: beatAudio,
    captions: [],
    sweeps: steps.map((s) => [s]),
    camera: cameraTrack(steps, cardViewportHeight(page.width), page.height),
    totalDuration: 7.5,
    bookTitle: "Meditations",
    author: "Marcus Aurelius",
    bookLink: "https://example.com/book",
  });

  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await tab.setContent(html, { waitUntil: "load" });
    await tab.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    for (let i = 0; i < steps.length; i++) {
      const rects = await tab.evaluate(
        ({ time, index }) => {
          (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
          const strokeEl = document.querySelector(`[data-stroke="${index}"]`);
          const cardEl = document.getElementById("card");
          if (!strokeEl || !cardEl) return null;
          const s = strokeEl.getBoundingClientRect();
          const c = cardEl.getBoundingClientRect();
          return { s: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, c: { top: c.top, bottom: c.bottom, left: c.left, right: c.right } };
        },
        { time: AUDIO_OFFSET + steps[i].end - 0.05, index: i },
      );
      assert.ok(rects);
      const { s, c } = rects!;
      assert.ok(s.top >= c.top - 1 && s.bottom <= c.bottom + 1, `stroke ${i} left the card vertically with the drift running`);
      assert.ok(s.left >= c.left - 1 && s.right <= c.right + 1, `stroke ${i} left the card horizontally with the drift running`);
    }

    // The byline is persistent: visible at every instant, including the very
    // first frame (which the hook scrim covers) and the very last.
    const bylineAt = async (t: number) =>
      tab.evaluate((time) => {
        (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
        const el = document.getElementById("byline");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, visibility: cs.visibility, text: el.textContent };
      }, t);
    const duration = Number(html.match(/data-duration="([\d.]+)"/)![1]);
    for (const t of [0, duration / 2, duration - 0.05]) {
      const b = await bylineAt(t);
      assert.ok(b, "the byline element must exist");
      assert.equal(b!.visibility, "visible", `the byline must be visible at t=${t}`);
      assert.equal(b!.opacity, "1");
      assert.equal(b!.text, "Meditations · Marcus Aurelius");
    }

    // The purchase card is genuinely on screen at the end, and it is not
    // covering the CTA card it follows.
    const endState = await tab.evaluate((time) => {
      (window as unknown as { __tl: { pause(t: number): void } }).__tl.pause(time);
      const buy = document.getElementById("buy-card");
      const cta = document.getElementById("cta-card");
      if (!buy || !cta) return null;
      const b = buy.getBoundingClientRect();
      const c = cta.getBoundingClientRect();
      return {
        opacity: getComputedStyle(buy).opacity,
        visibility: getComputedStyle(buy).visibility,
        buyTop: b.top, ctaBottom: c.bottom, buyBottom: b.bottom,
      };
    }, duration - 0.05);
    assert.ok(endState, "both end cards must exist");
    assert.ok(Number(endState!.opacity) > 0.95, `the purchase card must be readable at the end, was ${endState!.opacity}`);
    assert.equal(endState!.visibility, "visible");
    assert.ok(endState!.buyTop >= endState!.ctaBottom, "the purchase card must sit below the CTA card, not over it");
    assert.ok(endState!.buyBottom <= 1920, "the purchase card must stay inside the frame");
  } finally {
    await browser.close();
  }
});
