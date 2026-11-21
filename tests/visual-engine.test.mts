import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { SETTING_FALLBACKS, validateSetting } from "../src/lib/settings/keys";
import {
  PaidApiBlockedError,
  assertFreeReferenceApiUrl,
  assertFreeThumbnailUrl,
  assertLocalComfyUrl,
  enforceFreeRenderMode,
  isBlockedPaidHost,
} from "../src/lib/video/visual-engine/cost-guard";
import { DEFAULT_VISUAL_ENGINE, VISUAL_ENGINES, isHybridVisualEngine } from "../src/lib/video/visual-engine/types";
import { analyzeEpisodeVisuals } from "../src/lib/video/visual-engine/analyze";
import { classifyAndPlanEpisodeScenes } from "../src/lib/video/visual-engine/hybrid-planner";
import {
  discoverSceneStyleBrief,
  extractStyleBriefFromBuffer,
} from "../src/lib/video/visual-engine/references";
import { DEPTH_MAP_H, DEPTH_MAP_W, generateSmoothDepthMap } from "../src/lib/video/visual-engine/depth";
import { inspectComfyCapabilities } from "../src/lib/video/visual-engine/comfyui";
import { generateEpisodeVisuals, parseVisualManifest, publicSceneVisuals } from "../src/lib/video/visual-engine";
import { buildComposition, type CompositionInput } from "../src/lib/video/composition/build";
import { overlappingAnims, renderScene, FULL_FRAME } from "../src/lib/video/scenes/render";
import { pickKeyword } from "../src/lib/video/scenes/validate";
import { bookThemeById } from "../src/lib/video/composition/themes";
import type { Scene } from "../src/lib/video/scenes/types";
import type { ContentPackage } from "../src/lib/content/schema";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

const SAMPLE_PKG: ContentPackage = {
  ideaKey: "small-habits-compound",
  title: "Why Small Habits Compound",
  hook: "Time is running out faster than you think.",
  hookKeywords: ["time"],
  takeaway: ["Small daily steps compound into lasting change."],
  beats: [
    {
      id: "b0",
      voiceover: "Time is running out faster than you think.",
      onScreen: "Time runs out",
      sourcePage: 0,
      startWord: 0,
      endWord: 6,
    },
    {
      id: "b1",
      voiceover: "Every small step up a steep staircase builds lasting discipline.",
      onScreen: "Small steps",
      sourcePage: 0,
      startWord: 7,
      endWord: 14,
    },
  ],
  cta: "Follow for the next chapter.",
  description: "Grounded thoughts on habits and time.",
  hashtags: ["#BookReel", "#Habits"],
};

const SAMPLE_SCENES: Scene[] = [
  {
    index: 0,
    kind: "cinematic",
    start: 0,
    end: 3.2,
    tone: "warm",
    environment: "dusk",
    sentences: [0],
    beatIndex: 0,
    source: { pageIndex: 0, startWord: 0, endWord: 6 },
    reason: "Opening hook about time",
    concept: "hourglass time",
    words: "Time is running out faster than you think.".split(" ").map((word, i) => ({
      word,
      start: i * 0.35,
      end: i * 0.35 + 0.3,
    })),
    cine: {
      hero: "hourglass",
      keyword: "time",
      lead: "running out",
      hook: true,
      accentWords: ["time"],
    },
  },
  {
    index: 1,
    kind: "book-page",
    start: 3.2,
    end: 6.0,
    tone: "neutral",
    environment: "warm",
    sentences: [1],
    beatIndex: 1,
    source: { pageIndex: 0, startWord: 7, endWord: 14 },
    reason: "Show source page",
    concept: "book page",
    shot: "wide",
  },
  {
    index: 2,
    kind: "cinematic",
    start: 6.0,
    end: 9.8,
    tone: "bright",
    environment: "dawn",
    sentences: [1],
    beatIndex: 1,
    source: { pageIndex: 0, startWord: 7, endWord: 14 },
    reason: "Visualise climbing steps",
    concept: "staircase discipline",
    words: "Every small step up a steep staircase builds lasting discipline.".split(" ").map((word, i) => ({
      word,
      start: 6.0 + i * 0.32,
      end: 6.0 + i * 0.32 + 0.28,
    })),
    cine: {
      hero: "staircase",
      keyword: "discipline",
      lead: "small step",
    },
  },
];

test("hybrid-cinematic is the automatic default visual engine with zero manual selection required", () => {
  assert.equal(DEFAULT_VISUAL_ENGINE, "hybrid-cinematic");
  assert.equal(SETTING_FALLBACKS.visualEngine, "hybrid-cinematic");
  assert.equal(isHybridVisualEngine("hybrid-cinematic"), true);
  assert.equal(isHybridVisualEngine("cinematic-auto"), true);
  assert.equal(isHybridVisualEngine("procedural"), false);
  for (const mode of VISUAL_ENGINES) {
    assert.equal(validateSetting("visualEngine", mode), mode);
  }
  assert.equal(validateSetting("visualEngine", "paid-cloud-ai"), null);
});

test("intelligent hybrid planner selects documentary, 3d-animation, motion-graphics, and hybrid-cinematic per scene and builds full 11-field SceneVisualPlan", async () => {
  const mkWords = (text: string, t0: number) =>
    text.split(/\s+/).map((word, i) => ({ word, start: t0 + i * 0.28, end: t0 + i * 0.28 + 0.24 }));

  const hybridPkg: ContentPackage = {
    ideaKey: "marcus-focus-habit",
    title: "The Discipline of Focus",
    hook: "Most ambition dies in a fog of scattered distraction.",
    hookKeywords: ["ambition", "distraction"],
    takeaway: ["Guard your attention every morning."],
    beats: [
      {
        id: "b0",
        voiceover: "Most ambition dies in a fog of scattered distraction.",
        onScreen: "Scattered distraction",
        sourcePage: 0,
        startWord: 0,
        endWord: 8,
      },
      {
        id: "b1",
        voiceover: "In 170 AD in Vienna, the Roman emperor sat in his cold military tent writing by lamplight.",
        onScreen: "Roman military tent",
        sourcePage: 0,
        startWord: 9,
        endWord: 25,
      },
      {
        id: "b2",
        voiceover: "Just 42% of daily actions run on conscious choice rather than automatic habit.",
        onScreen: "42% conscious choice",
        sourcePage: 0,
        startWord: 26,
        endWord: 38,
      },
      {
        id: "b3",
        voiceover: "Your mind is a closed habit loop spinning on autopilot inside your skull.",
        onScreen: "Habit loop",
        sourcePage: 0,
        startWord: 39,
        endWord: 51,
      },
      {
        id: "b4",
        voiceover: "You must choose between deep focus and noisy distraction every morning.",
        onScreen: "Focus vs distraction",
        sourcePage: 0,
        startWord: 52,
        endWord: 62,
      },
      {
        id: "b5",
        voiceover: "That single quiet hour is printed right here on the page.",
        onScreen: "Book passage",
        sourcePage: 0,
        startWord: 63,
        endWord: 73,
      },
    ],
    cta: "Follow for the next chapter.",
    description: "Focus and discipline.",
    hashtags: ["#Focus"],
  };

  const rawScenes: Scene[] = [
    {
      index: 0,
      kind: "cinematic",
      start: 0,
      end: 3.0,
      tone: "deep",
      environment: "storm",
      sentences: [0],
      beatIndex: 0,
      source: { pageIndex: 0, startWord: 0, endWord: 8 },
      reason: "Hook",
      concept: "scattered ambition",
      words: mkWords(hybridPkg.beats[0].voiceover, 0),
      cine: { hero: "mountain", keyword: "ambition", lead: "", hook: true, accentWords: ["ambition"] },
    },
    {
      index: 1,
      kind: "cinematic",
      start: 3.0,
      end: 7.5,
      tone: "warm",
      environment: "dusk",
      sentences: [1],
      beatIndex: 1,
      source: { pageIndex: 0, startWord: 9, endWord: 25 },
      reason: "Historical scene",
      concept: "emperor writing",
      words: mkWords(hybridPkg.beats[1].voiceover, 3.0),
      cine: { hero: "bookletters", keyword: "emperor", lead: "Roman" },
    },
    {
      index: 2,
      kind: "kinetic-text",
      start: 7.5,
      end: 11.5,
      tone: "deep",
      environment: "grid",
      sentences: [2],
      beatIndex: 2,
      source: { pageIndex: 0, startWord: 26, endWord: 38 },
      reason: "Number sentence",
      concept: "daily actions",
      words: mkWords(hybridPkg.beats[2].voiceover, 7.5),
    },
    {
      index: 3,
      kind: "cinematic",
      start: 11.5,
      end: 15.5,
      tone: "deep",
      environment: "deep",
      sentences: [3],
      beatIndex: 3,
      source: { pageIndex: 0, startWord: 39, endWord: 51 },
      reason: "Mental loop metaphor",
      concept: "mind habit loop",
      words: mkWords(hybridPkg.beats[3].voiceover, 11.5),
      cine: { hero: "loop", keyword: "loop", lead: "closed habit" },
    },
    {
      index: 4,
      kind: "kinetic-text",
      start: 15.5,
      end: 19.5,
      tone: "bright",
      environment: "dawn",
      sentences: [4],
      beatIndex: 4,
      source: { pageIndex: 0, startWord: 52, endWord: 62 },
      reason: "Contrast sentence",
      concept: "deep focus",
      words: mkWords(hybridPkg.beats[4].voiceover, 15.5),
    },
    {
      index: 5,
      kind: "book-page",
      start: 19.5,
      end: 23.0,
      tone: "warm",
      environment: "warm",
      sentences: [5],
      beatIndex: 5,
      source: { pageIndex: 0, startWord: 63, endWord: 73 },
      reason: "Book anchor",
      concept: "quiet hour",
      shot: "medium",
    },
  ];

  const theme = bookThemeById("marginalia");
  const planned = await classifyAndPlanEpisodeScenes({
    bookTitle: "Meditations",
    author: "Marcus Aurelius",
    archetype: "philosophy",
    pkg: hybridPkg,
    scenes: rawScenes,
    theme,
  });

  assert.equal(planned.plans.length, 6, "every scene receives a structured pre-generation SceneVisualPlan");

  // Scene 0: Opening hook -> hybrid-cinematic
  assert.equal(planned.plans[0].visualTreatment, "hybrid-cinematic");
  assert.equal(planned.plans[0].scenePurpose, "opening-hook");

  // Scene 1: Historical / biographical person & place -> documentary
  assert.equal(planned.plans[1].visualTreatment, "documentary");
  assert.equal(planned.plans[1].depthAndParallax.intensity, 0.55);
  assert.equal(planned.plans[1].depthAndParallax.accent3d, false);

  // Scene 2: Grounded "42%" figure -> promoted to `stat` motion-graphics
  assert.equal(planned.scenes[2].kind, "stat");
  assert.equal(planned.scenes[2].stat?.value, "42%");
  assert.equal(planned.plans[2].visualTreatment, "motion-graphics");

  // Scene 3: Internal mental habit loop metaphor -> `3d-animation`
  assert.equal(planned.plans[3].visualTreatment, "3d-animation");
  assert.ok(planned.plans[3].requiredAssets.some((a) => a.startsWith("threejs-hero:")));

  // Scene 4: Grounded "between deep focus and noisy distraction" -> promoted to `comparison` motion-graphics
  assert.equal(planned.scenes[4].kind, "comparison");
  assert.equal(planned.scenes[4].left, "deep focus");
  assert.equal(planned.scenes[4].right, "noisy distraction");
  assert.equal(planned.plans[4].visualTreatment, "motion-graphics");

  // Scene 5: Book page preserved intact
  assert.equal(planned.scenes[5].kind, "book-page");

  // Continuity checks: adjacent camera movements and shot angles never repeat blindly, and all 11 plan fields exist.
  for (let i = 0; i < planned.plans.length; i++) {
    const p = planned.plans[i];
    assert.ok(p.scenePurpose.length > 0);
    assert.ok(p.mainSubject.length > 0);
    assert.ok(p.environmentAndBackground.length > 0);
    assert.ok(p.requiredAssets.length > 0);
    assert.ok(p.compositionAndAngle.foreground.length > 0);
    assert.ok(p.compositionAndAngle.midground.length > 0);
    assert.ok(p.compositionAndAngle.background.length > 0);
    assert.ok(p.lightingAndAtmosphere.lighting.length > 0);
    assert.equal(p.lightingAndAtmosphere.colorGrade, planned.colorGrade);
    if (i > 0) {
      assert.notEqual(
        p.cameraMovement,
        planned.plans[i - 1].cameraMovement,
        `scene ${i} must not repeat previous camera movement`,
      );
      assert.notEqual(
        p.compositionAndAngle.shotAngle,
        planned.plans[i - 1].compositionAndAngle.shotAngle,
        `scene ${i} must not repeat previous shot angle`,
      );
    }
  }
});

test("cost protection strictly blocks paid AI hosts and remote ComfyUI endpoints while allowing loopback + free APIs", () => {
  for (const paid of [
    "https://api.openai.com/v1/images/generations",
    "https://generativelanguage.googleapis.com/v1beta/models/imagen",
    "https://api.replicate.com/v1/predictions",
    "https://fal.run/fal-ai/flux/dev",
    "https://api.runwayml.com/v1/image_to_video",
    "https://api.klingai.com/v1/videos",
    "https://api.stability.ai/v2beta/stable-image",
    "https://api.elevenlabs.io/v1/text-to-speech",
    "https://cloud.hyperframes.heygen.com/render",
  ]) {
    const host = new URL(paid).hostname;
    assert.equal(isBlockedPaidHost(host), true, `${host} must be on the paid denylist`);
    assert.throws(() => assertLocalComfyUrl(paid), PaidApiBlockedError);
    assert.throws(() => assertFreeReferenceApiUrl(paid), PaidApiBlockedError);
    assert.throws(() => assertFreeThumbnailUrl(paid), PaidApiBlockedError);
  }

  assert.throws(() => assertLocalComfyUrl("https://my-pod-8188.proxy.runpod.net"), PaidApiBlockedError);
  assert.throws(() => assertLocalComfyUrl("http://192.168.1.50:8188"), PaidApiBlockedError);

  assert.equal(assertLocalComfyUrl("http://127.0.0.1:8188").hostname, "127.0.0.1");
  assert.equal(assertLocalComfyUrl("http://localhost:8188").hostname, "localhost");

  assert.equal(assertFreeReferenceApiUrl("https://api.openverse.org/v1/images/?q=mountain").hostname, "api.openverse.org");
  assert.equal(assertFreeReferenceApiUrl("https://commons.wikimedia.org/w/api.php?action=query").hostname, "commons.wikimedia.org");
  assert.equal(assertFreeReferenceApiUrl("https://api.pexels.com/v1/search?query=dawn").hostname, "api.pexels.com");
  assert.equal(assertFreeReferenceApiUrl("https://api.pinterest.com/v5/search/pins?query=book").hostname, "api.pinterest.com");

  assert.equal(enforceFreeRenderMode("cloud"), "local");
  assert.equal(enforceFreeRenderMode("local"), "local");
});

test("scene visual analyzer tailors prompts by treatment (documentary vs hybrid-cinematic) and builds a consistent visual bible locally", async () => {
  const theme = bookThemeById("academia");
  const planned = await classifyAndPlanEpisodeScenes({
    bookTitle: "Atomic Habits",
    author: "James Clear",
    archetype: "productivity",
    pkg: SAMPLE_PKG,
    scenes: SAMPLE_SCENES,
    theme,
  });
  const planMap = new Map(planned.plans.map((p) => [p.sceneIndex, p]));

  const out = await analyzeEpisodeVisuals({
    bookTitle: "Atomic Habits",
    author: "James Clear",
    archetype: "productivity",
    pkg: SAMPLE_PKG,
    scenes: planned.scenes,
    scenePlans: planMap,
    theme,
    localOnly: true,
  });

  assert.equal(out.source, "local-heuristic");
  assert.ok(out.bible.visualStyle.length > 10);
  assert.ok(out.bible.negativePrompt.includes("watermark"));

  const hookIntent = out.intents.get(0)!;
  const stepIntent = out.intents.get(2)!;
  assert.match(hookIntent.promptCore, /hourglass|sand|clock|time/i, "scene 0 matches time narration");
  assert.match(stepIntent.promptCore, /staircase|steps|stone|climb/i, "scene 2 matches staircase narration");
  assert.ok(hookIntent.searchQueries.length >= 2);
  assert.notEqual(hookIntent.cameraMove, stepIntent.cameraMove, "consecutive scenes vary camera moves");
});

test("clean-room reference brief extracts non-copyrightable colour/lighting metrics and discards image buffers", async () => {
  const theme = bookThemeById("spotlight");
  const analysis = await analyzeEpisodeVisuals({
    bookTitle: "Atomic Habits",
    pkg: SAMPLE_PKG,
    scenes: SAMPLE_SCENES,
    theme,
    localOnly: true,
  });
  const intent = analysis.intents.get(0)!;

  const sampleBuf = await sharp({
    create: { width: 120, height: 180, channels: 3, background: { r: 214, g: 132, b: 44 } },
  })
    .png()
    .toBuffer();

  const brief = await extractStyleBriefFromBuffer(
    sampleBuf,
    {
      source: "openverse",
      id: "ov-1",
      title: "Warm golden hour hourglass",
      thumbnailUrl: "https://example.org/thumb.jpg",
      license: "cc0",
      similarityScore: 0.88,
    },
    intent,
    theme,
  );

  assert.ok(brief);
  assert.equal(brief!.warmth, "warm");
  assert.equal(brief!.referenceSource, "openverse");
  assert.match(brief!.dominantHex, /^#[0-9a-f]{6}$/i);
  assert.match(brief!.accentHex, /^#[0-9a-f]{6}$/i);

  const offline = await discoverSceneStyleBrief(intent, analysis.bible, theme, { offlineOnly: true });
  assert.equal(offline.brief.referenceSource, "local-director");
  assert.deepEqual(offline.candidates, []);
});

test("smooth 2.5D depth generator produces a valid 180x320 grayscale depth map", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "bookreel-depth-test-"));
  try {
    const srcSvg = Buffer.from(
      `<svg width="540" height="960" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#0b132b"/>
            <stop offset="100%" stop-color="#1c2541"/>
          </linearGradient>
        </defs>
        <rect width="540" height="960" fill="url(#sky)"/>
        <circle cx="270" cy="540" r="140" fill="#f59e0b"/>
      </svg>`,
    );
    const imgBuf = await sharp(srcSvg).jpeg().toBuffer();
    const outPath = path.join(tmpDir, "depth.png");
    await generateSmoothDepthMap(imgBuf, outPath);

    const meta = await sharp(outPath).metadata();
    assert.equal(meta.width, DEPTH_MAP_W);
    assert.equal(meta.height, DEPTH_MAP_H);
    assert.equal(meta.format, "png");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("3-plane hybrid 2.5D plate (+ accent3d + callout) is seek-safe in live Chromium and falls back automatically if plate image is missing", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "bookreel-plate-seek-"));
  try {
    const platePath = path.join(tmpDir, "plate.jpg");
    const depthPath = path.join(tmpDir, "depth.png");
    const plateBuf = await sharp({
      create: { width: 540, height: 960, channels: 3, background: { r: 36, g: 82, b: 146 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    await fsp.writeFile(platePath, plateBuf);
    await generateSmoothDepthMap(plateBuf, depthPath);

    const plateDataUri = `data:image/jpeg;base64,${plateBuf.toString("base64")}`;
    const depthDataUri = `data:image/png;base64,${(await fsp.readFile(depthPath)).toString("base64")}`;

    const theme = bookThemeById("spotlight");
    const base = fixtureInput({ theme }) as unknown as CompositionInput;
    const plateScene: Scene = {
      ...SAMPLE_SCENES[0],
      cine: {
        ...SAMPLE_SCENES[0].cine!,
        hook: false,
        plate: {
          imageSrc: plateDataUri,
          depthSrc: depthDataUri,
          cameraMove: "push-in",
          shotAngle: "low-angle-heroic",
          treatment: "hybrid-cinematic",
          parallaxIntensity: 0.92,
          colorGrade: "golden-amber",
          accent3d: true,
          callout: "small step",
          atmosphere: "embers",
          dominantHex: "#245292",
          accentHex: "#f59e0b",
          shadowHex: "#090d16",
        },
      },
    };
    const missingPlateScene: Scene = {
      ...SAMPLE_SCENES[2],
      cine: {
        ...SAMPLE_SCENES[2].cine!,
        plate: {
          imageSrc: "data:image/gif;base64,invalid",
          depthSrc: "data:image/gif;base64,invalid",
          cameraMove: "pan-right",
          treatment: "documentary",
          atmosphere: "dust",
          dominantHex: "#245292",
          accentHex: "#f59e0b",
          shadowHex: "#090d16",
        },
      },
    };

    const r0 = renderScene(plateScene, FULL_FRAME, theme.palette.accent)!;
    assert.deepEqual(overlappingAnims(r0.anims), []);
    assert.match(r0.markup, /data-plate-img="1"/);
    assert.match(r0.markup, /cine-plate-scrim/);
    assert.match(r0.markup, /cine-callout/);

    const html = buildComposition({
      ...base,
      bookTitle: "Atomic Habits",
      scenes: [plateScene, SAMPLE_SCENES[1], missingPlateScene],
    });

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl));

      const coldPixels = await page.evaluate(() => {
        const tl = (window as unknown as { __tl: { seek(t: number, suppress?: boolean): void } }).__tl;
        tl.seek(1.4, false);
        const c = document.querySelector('[data-scene="0"] .cine-canvas') as HTMLCanvasElement;
        const ctx = c.getContext("2d")!;
        const d = ctx.getImageData(360, 640, 4, 4).data;
        return Array.from(d.slice(0, 16));
      });
      assert.ok(coldPixels.some((v) => v > 0), "3-plane hybrid 2.5D plate painted non-empty WebGL pixels");

      const afterRoundTrip = await page.evaluate(() => {
        const tl = (window as unknown as { __tl: { seek(t: number, suppress?: boolean): void } }).__tl;
        tl.seek(7.5, false);
        const c2 = document.querySelector('[data-scene="2"] .cine-canvas') as HTMLCanvasElement;
        const fallbackVisible = c2.style.visibility === "visible" && c2.style.opacity === "1";

        tl.seek(0.2, false);
        tl.seek(1.4, false);
        const c0 = document.querySelector('[data-scene="0"] .cine-canvas') as HTMLCanvasElement;
        const d0 = c0.getContext("2d")!.getImageData(360, 640, 4, 4).data;
        return { fallbackVisible, pixels: Array.from(d0.slice(0, 16)) };
      });

      assert.equal(afterRoundTrip.fallbackVisible, true, "broken plate automatically fell back to procedural 3D hero");
      assert.deepEqual(afterRoundTrip.pixels, coldPixels, "hybrid 2.5D plate rendering is 100% deterministic across seeks");
    } finally {
      await browser.close();
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ComfyUI stopped / unreachable automatically falls back to procedural 3D heroes under hybrid-cinematic without failing", async () => {
  const diag = await inspectComfyCapabilities({
    baseUrl: "http://127.0.0.1:59189",
    autoStart: false,
  });
  assert.equal(diag.reachable, false);
  assert.equal(diag.checkpoint, null);
  assert.ok(diag.fallbackReason);

  const prevUrl = process.env.BOOKREEL_COMFYUI_URL;
  const prevAuto = process.env.BOOKREEL_COMFYUI_AUTOSTART;
  process.env.BOOKREEL_COMFYUI_URL = "http://127.0.0.1:59189";
  process.env.BOOKREEL_COMFYUI_AUTOSTART = "0";
  try {
    const out = await generateEpisodeVisuals({
      episodeId: "test-ep-fallback",
      bookTitle: "Meditations",
      pkg: SAMPLE_PKG,
      scenes: SAMPLE_SCENES,
      theme: bookThemeById("marginalia"),
      offlineReferences: true,
      localAnalysisOnly: true,
    });

    assert.equal(out.engine, "hybrid-cinematic");
    assert.equal(out.projectAssets.length, 0);
    assert.equal(out.manifest.scenePlans?.length, 3);
    assert.ok(out.manifest.scenes.every((s) => s.mode === "procedural-fallback"));
    assert.ok(out.scenes.every((s) => !s.cine?.plate), "procedural hero scenes remain intact");
    assert.ok(out.notes.some((n) => /procedural 3D/i.test(n)));

    const roundTrip = publicSceneVisuals(parseVisualManifest(JSON.stringify(out.manifest)));
    assert.equal(roundTrip.length, 2);
    assert.equal(roundTrip[0].mode, "procedural-fallback");
    assert.equal(roundTrip[0].visualTreatment, "hybrid-cinematic");
  } finally {
    if (prevUrl === undefined) delete process.env.BOOKREEL_COMFYUI_URL;
    else process.env.BOOKREEL_COMFYUI_URL = prevUrl;
    if (prevAuto === undefined) delete process.env.BOOKREEL_COMFYUI_AUTOSTART;
    else process.env.BOOKREEL_COMFYUI_AUTOSTART = prevAuto;
  }
});

test("motion graphics upgrade: non-dangling labels, strong keywords, chronological timeline, and word-synced seek-safe animations", async () => {
  // 1. pickKeyword skips weak pronouns ("yourself") in favour of real content nouns ("commitment"):
  const closeWords = "Make a commitment to yourself right now".split(" ").map((w, i) => ({
    word: w,
    start: 10 + i * 0.35,
    end: 10.3 + i * 0.35,
  }));
  assert.equal(pickKeyword(undefined, closeWords), "commitment");
  assert.equal(pickKeyword("yourself", closeWords), "commitment");

  // 2. Planner extracts complete non-dangling stat labels ("calls in a single day") and chronological timelines:
  const mkWords = (text: string, t0: number) =>
    text.split(/\s+/).filter(Boolean).map((word, idx) => ({
      word,
      start: +(t0 + idx * 0.32).toFixed(3),
      end: +(t0 + idx * 0.32 + 0.26).toFixed(3),
      beatIndex: 0,
      index: idx,
      source: "audio" as const,
    }));

  const proPkg: ContentPackage = {
    ideaKey: "eagle-way-pro",
    title: "The Eagle Way",
    hook: "Being busy is not the same as being productive.",
    hookKeywords: ["productive"],
    takeaway: ["Finish one needle-moving task every morning."],
    beats: [
      { id: "b0", voiceover: "Being busy is not the same as being productive.", onScreen: "", sourcePage: 0, startWord: 0, endWord: 8 },
      { id: "b1", voiceover: "Suppose you had to make 15 calls in a single day.", onScreen: "", sourcePage: 0, startWord: 9, endWord: 19 },
      { id: "b2", voiceover: "In the morning write one task, in the afternoon finish the work, tonight sleep in calm.", onScreen: "", sourcePage: 0, startWord: 20, endWord: 35 },
      { id: "b3", voiceover: "First write your goal, second block your calendar, finally share your progress.", onScreen: "", sourcePage: 0, startWord: 36, endWord: 47 },
      { id: "b4", voiceover: "Productivity shared is productivity doubled over time.", onScreen: "", sourcePage: 0, startWord: 48, endWord: 54 },
    ],
    cta: "Read the book.",
    description: "The Eagle Way",
    hashtags: ["productivity"],
  };

  const baseScenes: Scene[] = proPkg.beats.map((b, idx) => ({
    index: idx,
    kind: idx === 0 ? "cinematic" : "kinetic-text",
    start: idx * 5,
    end: (idx + 1) * 5,
    tone: idx === 0 ? "deep" : "cool",
    environment: idx === 0 ? "deep" : "dawn",
    sentences: [idx],
    beatIndex: idx,
    source: { pageIndex: 0, startWord: b.startWord, endWord: b.endWord },
    reason: "test",
    concept: idx === 4 ? "productivity doubled" : "",
    words: mkWords(b.voiceover, idx * 5 + 0.2),
    ...(idx === 0 ? { cine: { hero: "focus" as const, keyword: "productive", lead: "", hook: true, accentWords: ["productive"] } } : {}),
  }));

  const planned = await classifyAndPlanEpisodeScenes({
    bookTitle: "The Eagle Way",
    archetype: "productivity",
    pkg: proPkg,
    scenes: baseScenes,
    theme: bookThemeById("marginalia"),
  });

  // Scene 1 ("Suppose you had to make 15 calls in a single day.") -> stat with non-dangling label!
  assert.equal(planned.scenes[1].kind, "stat");
  assert.equal(planned.scenes[1].stat?.value, "15");
  assert.equal(planned.scenes[1].stat?.label, "calls in a single day");
  assert.doesNotMatch(planned.scenes[1].stat?.label ?? "", /\b(in|a|single)$/i);

  // Scene 2 -> chronological timeline
  assert.equal(planned.scenes[2].kind, "timeline");
  assert.ok((planned.scenes[2].steps?.length ?? 0) >= 3);

  // Scene 3 -> connected process steps
  assert.equal(planned.scenes[3].kind, "steps");
  assert.equal(planned.scenes[3].steps?.length, 3);

  // Scene 4 -> compounding / doubling growth-curve
  assert.equal(planned.scenes[4].kind, "growth-curve");

  // 3. Word-level synchronization & zero overlapping animations across every rendered template:
  const rect = { x: 60, y: 200, w: 960, h: 1170 };
  const accent = bookThemeById("marginalia").palette.accent;

  const statRender = renderScene(planned.scenes[1], rect, accent)!;
  assert.deepEqual(overlappingAnims(statRender.anims), []);
  const spoken15Word = planned.scenes[1].words!.find((w) => w.word === "15")!;
  const countAnim = statRender.anims.find((a) => a.k === "count")!;
  assert.equal(countAnim.t, spoken15Word.start, "stat counter starts at the exact spoken timestamp of '15'");

  const tlRender = renderScene(planned.scenes[2], rect, accent)!;
  assert.deepEqual(overlappingAnims(tlRender.anims), []);
  const morningWord = planned.scenes[2].words!.find((w) => w.word === "morning")!;
  const afternoonWord = planned.scenes[2].words!.find((w) => w.word === "afternoon")!;
  const tlRows = tlRender.anims.filter((a) => a.e >= 0 && a.e < planned.scenes[2].steps!.length);
  assert.equal(tlRows[0].t, morningWord.start, "timeline row 1 arrives when 'morning' is spoken");
  assert.equal(tlRows[1].t, afternoonWord.start, "timeline row 2 arrives when 'afternoon' is spoken");

  const curveRender = renderScene(planned.scenes[4], rect, accent)!;
  assert.deepEqual(overlappingAnims(curveRender.anims), []);
  assert.match(curveRender.markup, /class="sc-curve-line"[^>]*d="M /);
  assert.match(curveRender.markup, /class="sc-curve-node"/, "growth curve renders intermediate milestone nodes");
});
