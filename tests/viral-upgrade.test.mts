import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildComposition, bylineText, cardViewportHeight, AUDIO_OFFSET, type CompositionInput } from "../src/lib/video/composition/build";
import { shotFor } from "../src/lib/video/scenes/validate";
import { cameraTrack } from "../src/lib/video/sweep";
import { clean as cleanThumbText } from "../src/lib/thumbnails/text";
import { generateSfxTrack, planSfxCues } from "../src/lib/media/sfx-synth";
import { renderCinematicScore } from "../src/lib/media/cinematic-score";
import { MOODS } from "../src/lib/media/moods";
import { classifyAndPlanEpisodeScenes } from "../src/lib/video/visual-engine/hybrid-planner";
import { bookThemeById } from "../src/lib/video/composition/themes";
import type { Scene } from "../src/lib/video/scenes/types";
import type { ContentPackage } from "../src/lib/content/schema";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

test("bylineText and thumbnail clean() strip Archive.org and library catalog suffixes while keeping real titles", () => {
  assert.equal(
    bylineText("Changing your habits steps to better health (IA CAT31310001)", null),
    "Changing your habits steps to better health",
  );
  assert.equal(
    cleanThumbText("Changing your habits steps to better health (IA CAT31310001)"),
    "Changing your habits steps to better health",
  );
  assert.equal(
    bylineText("Meditations [OCLC 123456]", "Marcus Aurelius"),
    "Meditations · Marcus Aurelius",
  );
  assert.equal(
    bylineText("Thinking, Fast and Slow", "Daniel Kahneman"),
    "Thinking, Fast and Slow · Daniel Kahneman",
  );
});

test("procedural SFX engine synthesizes deterministic, non-clipping hook, whoosh, pop, and riser cues", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-sfx-test-"));
  try {
    const scenes: Scene[] = [
      {
        index: 0,
        kind: "cinematic",
        start: 0,
        end: 3.4,
        tone: "deep",
        environment: "storm",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 0, startWord: 0, endWord: 5 },
        reason: "hook",
        concept: "running shoes rain",
        cine: { hero: "storm", keyword: "excuses", lead: "", hook: true },
      },
      {
        index: 1,
        kind: "comparison",
        start: 3.4,
        end: 7.2,
        tone: "bright",
        environment: "dawn",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 0, startWord: 6, endWord: 14 },
        reason: "contrast",
        concept: "sugar vs walk",
        left: "sweet reward",
        right: "short walk",
      },
      {
        index: 2,
        kind: "cinematic",
        start: 7.2,
        end: 11.0,
        tone: "warm",
        environment: "warm",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 0, startWord: 15, endWord: 22 },
        reason: "payoff",
        concept: "morning park walk",
        cine: { hero: "path", keyword: "momentum", lead: "" },
      },
    ];

    const cues = planSfxCues({ durationSec: 13.5, audioOffsetSec: AUDIO_OFFSET, scenes });
    assert.ok(cues.some((c) => c.kind === "hook-hit"), "includes opening hook sub-bass hit");
    assert.ok(cues.some((c) => c.kind === "scene-whoosh"), "includes scene transition whoosh");
    assert.ok(cues.some((c) => c.kind === "card-pop"), "includes motion-graphics card pop");
    assert.ok(cues.some((c) => c.kind === "payoff-riser"), "includes final payoff riser");

    const wavA = path.join(dir, "sfx-a.wav");
    const wavB = path.join(dir, "sfx-b.wav");
    await generateSfxTrack({ durationSec: 13.5, audioOffsetSec: AUDIO_OFFSET, scenes, outPath: wavA });
    await generateSfxTrack({ durationSec: 13.5, audioOffsetSec: AUDIO_OFFSET, scenes, outPath: wavB });

    const bufA = await fs.readFile(wavA);
    const bufB = await fs.readFile(wavB);
    assert.equal(bufA.subarray(0, 4).toString("ascii"), "RIFF");
    assert.ok(bufA.equals(bufB), "SFX synthesis is 100% byte-deterministic across runs");

    // Verify non-silence at hook hit (~0.05s) and safe peak ceiling (< -6 dBFS).
    let maxAbs = 0;
    for (let offset = 44; offset + 2 <= bufA.length; offset += 2) {
      const sample = Math.abs(bufA.readInt16LE(offset)) / 32767;
      if (sample > maxAbs) maxAbs = sample;
    }
    assert.ok(maxAbs > 0.05, "SFX waveform has audible energy");
    assert.ok(maxAbs <= 0.45, `SFX peak (${maxAbs.toFixed(3)}) stays safely below voiceover`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("word-synced active captions highlight spoken words seek-safely and suppress Frame-0 duplicate hook caption", async () => {
  const theme = bookThemeById("spotlight");
  const base = fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput;
  const html = buildComposition({
    ...base,
    sfx: true,
    bookTitle: "Changing your habits (IA CAT31310001)",
  });

  assert.match(html, /<audio id="sfx" src="assets\/sfx\.wav"[^>]*data-track-index="15"/);
  assert.match(html, /class="cap-w/);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    // At t=1.0s (during Scene 0 cinematic hook), beat 0's bottom caption is suppressed so `.cine-hook` stands alone!
    const hookFrame = await page.evaluate(() => {
      const tl = (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl;
      tl.seek(1.0, false);
      const cap0 = document.querySelector('[data-caption="0"]') as HTMLElement;
      return getComputedStyle(cap0).visibility;
    });
    assert.equal(hookFrame, "hidden", "duplicate bottom caption is suppressed during opening cinematic hook");

    // During beat 1 (t = 3.35s), `data-caption="2"` (beat 1's first caption; captions 0 & 1 are beat 0's 5 words)
    // is visible and active words reach opacity 1 while unspoken words rest at 0.42, seek-safely:
    const midBeat = await page.evaluate(() => {
      const tl = (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl;
      tl.seek(3.35, false);
      const cap2 = document.querySelector('[data-caption="2"]') as HTMLElement;
      const words = Array.from(cap2.querySelectorAll(".cap-w")).map((el) => Number(getComputedStyle(el).opacity));
      tl.seek(10.0, false);
      tl.seek(0.2, false);
      tl.seek(3.35, false);
      const wordsAfterSeek = Array.from(cap2.querySelectorAll(".cap-w")).map((el) => Number(getComputedStyle(el).opacity));
      return { vis: getComputedStyle(cap2).visibility, words, wordsAfterSeek };
    });
    assert.equal(midBeat.vis, "visible");
    assert.ok(midBeat.words[0] > 0.95, "already-spoken word is fully lit");
    assert.deepEqual(midBeat.wordsAfterSeek, midBeat.words, "word-synced caption opacities are 100% seek-safe");
  } finally {
    await browser.close();
  }
});

test("hybrid planner caps bare 3d-animation to at most 1 scene per episode so other cinematic scenes get rich 2.5D plates", async () => {
  const pkg: ContentPackage = {
    ideaKey: "habit-test",
    title: "Habits",
    hook: "Your brain runs on hidden loops.",
    hookKeywords: ["loops"],
    takeaway: ["Change the cue."],
    beats: [
      { id: "b0", voiceover: "Your brain runs on hidden loops.", onScreen: "Loops", sourcePage: 0, startWord: 0, endWord: 5 },
      { id: "b1", voiceover: "Inside your skull a closed habit loop repeats on autopilot.", onScreen: "Autopilot", sourcePage: 0, startWord: 6, endWord: 15 },
      { id: "b2", voiceover: "Every morning habit orbit pulls your focus back into routine.", onScreen: "Routine", sourcePage: 0, startWord: 16, endWord: 25 },
      { id: "b3", voiceover: "Break the mental chain before distraction wins.", onScreen: "Break", sourcePage: 0, startWord: 26, endWord: 32 },
    ],
    cta: "Save this.",
    description: "Habits",
    hashtags: ["#Habits"],
  };
  const scenes: Scene[] = [
    { index: 0, kind: "cinematic", start: 0, end: 3, tone: "deep", environment: "deep", sentences: [0], beatIndex: 0, source: { pageIndex: 0, startWord: 0, endWord: 5 }, reason: "hook", concept: "brain loop", cine: { hero: "mind", keyword: "loops", lead: "", hook: true } },
    { index: 1, kind: "cinematic", start: 3, end: 6.5, tone: "deep", environment: "deep", sentences: [1], beatIndex: 1, source: { pageIndex: 0, startWord: 6, endWord: 15 }, reason: "loop", concept: "habit loop", cine: { hero: "loop", keyword: "loop", lead: "" } },
    { index: 2, kind: "cinematic", start: 6.5, end: 10, tone: "cool", environment: "dusk", sentences: [2], beatIndex: 2, source: { pageIndex: 0, startWord: 16, endWord: 25 }, reason: "orbit", concept: "habit orbit", cine: { hero: "orbit", keyword: "routine", lead: "" } },
    { index: 3, kind: "cinematic", start: 10, end: 13.5, tone: "warm", environment: "dawn", sentences: [3], beatIndex: 3, source: { pageIndex: 0, startWord: 26, endWord: 32 }, reason: "chain", concept: "mental chain", cine: { hero: "chain", keyword: "chain", lead: "" } },
  ];

  const out = await classifyAndPlanEpisodeScenes({
    bookTitle: "Changing Habits",
    archetype: "productivity",
    pkg,
    scenes,
    theme: bookThemeById("spotlight"),
  });

  const threeDCount = out.plans.filter((p) => p.visualTreatment === "3d-animation").length;
  const plateCount = out.plans.filter((p) => p.visualTreatment === "hybrid-cinematic" || p.visualTreatment === "documentary").length;
  assert.equal(threeDCount, 1, "caps procedural 3d-animation to at most 1 centerpiece scene");
  assert.equal(plateCount, 3, "routes all remaining cinematic beats to rich 2.5D ComfyUI plates");
});

test("viralCaptions renders boxless stroke pop-bounce active words seek-safely and cinematic score is non-silent & deterministic", async () => {
  const scoreA = renderCinematicScore(6, MOODS.spotlight);
  const scoreB = renderCinematicScore(6, MOODS.spotlight);
  assert.equal(scoreA.length, scoreB.length);
  let scorePeak = 0;
  for (let i = 0; i < scoreA.length; i++) {
    assert.equal(scoreA[i], scoreB[i]);
    if (Math.abs(scoreA[i]) > scorePeak) scorePeak = Math.abs(scoreA[i]);
  }
  assert.ok(scorePeak > 0.05, "warm cinematic score has rich non-silent harmonic body");

  const theme = bookThemeById("spotlight");
  const base = fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput;
  const html = buildComposition({
    ...base,
    sfx: true,
    viralCaptions: true,
    bookTitle: "Changing your habits (IA CAT31310001)",
  });

  assert.match(html, /class="captions captions-viral"/);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    const probe = await page.evaluate(() => {
      const tl = (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl;
      tl.seek(3.25, false);
      const cap2 = document.querySelector('[data-caption="2"]') as HTMLElement;
      const bg = getComputedStyle(cap2).backgroundColor;
      const snapA = Array.from(cap2.querySelectorAll(".cap-w")).map((el) => ({
        color: getComputedStyle(el).color,
        transform: (el as HTMLElement).style.transform,
      }));
      tl.seek(11.0, false);
      tl.seek(0.2, false);
      tl.seek(3.25, false);
      const snapB = Array.from(cap2.querySelectorAll(".cap-w")).map((el) => ({
        color: getComputedStyle(el).color,
        transform: (el as HTMLElement).style.transform,
      }));
      return { bg, snapA, snapB };
    });

    assert.equal(probe.bg, "rgba(0, 0, 0, 0)", "viral caption removes clunky background box");
    assert.deepEqual(probe.snapB, probe.snapA, "viral pop-bounce word state is 100% seek-safe");
    assert.ok(
      probe.snapA.some((w) => w.transform.includes("translateY(-4px)")),
      "active spoken word pops upward with dynamic scale",
    );
  } finally {
    await browser.close();
  }
});

test("page zoom never crops highlighted text horizontally: narrow columns pan to center and wide two-column spans step back (live browser)", async () => {
  // 1. Upstream shotFor checks BOTH vertical and horizontal width when pageWidth is supplied:
  assert.equal(
    shotFor("close", { x0: 116, y0: 603, x1: 574, y1: 690 }, 1442, 1236),
    "close",
    "narrow single column (458px on 1236px page) safely fits 2.2x close shot",
  );
  assert.equal(
    shotFor("close", { x0: 116, y0: 966, x1: 1102, y1: 1018 }, 1442, 1236),
    "wide",
    "wide two-column span (986px on 1236px page) steps back to wide instead of cropping both edges",
  );

  // 2. Live browser check: build a 2-column 1236x1600 page with a narrow left-column close shot (beat 0)
  //    followed by a full two-column wide span (beat 1). Neither stroke may ever leave #card!
  const theme = bookThemeById("spotlight");
  const base = fixtureInput({ theme }) as unknown as CompositionInput;
  const pageSpec = { src: "assets/page-00.jpg", width: 1236, height: 1600, pageIndex: 5 };
  const sweeps = [
    [{ box: { x0: 116, y0: 603, x1: 574, y1: 690 }, start: 0.2, end: 3.8 }],
    [{ box: { x0: 116, y0: 966, x1: 1102, y1: 1018 }, start: 4.2, end: 7.8 }],
  ];
  const allSteps = sweeps.flat();
  const camera = cameraTrack(allSteps, cardViewportHeight(pageSpec.width), pageSpec.height);
  const scenes: Scene[] = [
    {
      index: 0,
      kind: "book-crop",
      shot: "close",
      crop: { x0: 116, y0: 603, x1: 574, y1: 690 },
      start: 0,
      end: 4,
      tone: "warm",
      sentences: [0],
      beatIndex: 0,
      source: { pageIndex: 5, startWord: 0, endWord: 5 },
      reason: "left column",
      concept: "left column",
    },
    {
      index: 1,
      kind: "book-page",
      shot: "close",
      start: 4,
      end: 8,
      tone: "warm",
      sentences: [1],
      beatIndex: 1,
      source: { pageIndex: 5, startWord: 6, endWord: 12 },
      reason: "two columns",
      concept: "two columns",
    },
  ];
  const html = buildComposition({
    ...base,
    pages: [pageSpec],
    pkg: {
      ...base.pkg,
      beats: [
        { id: "b0", voiceover: "Left column text.", onScreen: "Left", sourcePage: 5, startWord: 0, endWord: 5 },
        { id: "b1", voiceover: "Both columns text.", onScreen: "Both", sourcePage: 5, startWord: 6, endWord: 12 },
      ],
    },
    beats: [
      { index: 0, text: "Left column text.", file: "b0.wav", start: 0, end: 4, speechStart: 0.2, speechEnd: 3.8 },
      { index: 1, text: "Both columns text.", file: "b1.wav", start: 4, end: 8, speechStart: 4.2, speechEnd: 7.8 },
    ],
    captions: [],
    sweeps,
    camera,
    scenes,
    viralCaptions: true,
    totalDuration: 8,
    bookTitle: "Habit Test",
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

    for (const check of [
      { time: AUDIO_OFFSET + 2.5, strokeIdx: 0, label: "zoomed 2.2x left-column stroke" },
      { time: AUDIO_OFFSET + 6.5, strokeIdx: 1, label: "two-column full-width stroke" },
    ]) {
      const bounds = await page.evaluate(
        ({ t, idx }) => {
          const tl = (window as unknown as { __tl: { seek(time: number, s: boolean): void } }).__tl;
          tl.seek(t, false);
          const card = document.getElementById("card")!.getBoundingClientRect();
          const stroke = document.querySelector(`[data-stroke="${idx}"]`)!.getBoundingClientRect();
          return {
            cardLeft: card.left,
            cardRight: card.right,
            cardTop: card.top,
            cardBottom: card.bottom,
            strokeLeft: stroke.left,
            strokeRight: stroke.right,
            strokeTop: stroke.top,
            strokeBottom: stroke.bottom,
          };
        },
        { t: check.time, idx: check.strokeIdx },
      );

      assert.ok(
        bounds.strokeLeft >= bounds.cardLeft + 8 && bounds.strokeRight <= bounds.cardRight - 8,
        `${check.label} stays 100% horizontally inside #card (${bounds.strokeLeft.toFixed(1)}..${bounds.strokeRight.toFixed(1)} vs ${bounds.cardLeft}..${bounds.cardRight})`,
      );
      assert.ok(
        bounds.strokeTop >= bounds.cardTop + 8 && bounds.strokeBottom <= bounds.cardBottom - 8,
        `${check.label} stays 100% vertically inside #card`,
      );
    }
  } finally {
    await browser.close();
  }
});
