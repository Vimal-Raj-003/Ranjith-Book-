import test from "node:test";
import assert from "node:assert/strict";
import {
  auditMotionMaxxingLayout,
  pageCameraRecipeAt,
  shotRecipeForScene,
  viralCaptionFontSize,
} from "../src/lib/video/motionmaxxing";
import {
  applyVoiceAwareDucking,
  generateSfxTrack,
  planSfxCues,
  renderSfxBuffer,
  verifyEarshotSync,
} from "../src/lib/media/sfx-synth";
import { loadProjectSfxLibrary, planSelectiveLibrarySfx } from "../src/lib/media/sfx-library";
import { buildComposition, cardCineMoves, CARD_X, CARD_Y, CARD_W, CARD_H } from "../src/lib/video/composition/build";
import { overlappingAnims, renderScene, sceneCss } from "../src/lib/video/scenes/render";
import { EDGE_VOICE_MAP } from "../src/lib/media/edge-tts";
import { bookThemeById } from "../src/lib/video/composition/themes";
import {
  ALL_REEL_MODEL_IDS,
  applyReelModelToScenes,
  chooseAutoReelModel,
  REEL_MODEL_AUTO,
} from "../src/lib/video/reel-models";
import { buildProMotionComposition } from "../src/lib/video/pro-motion-engine";
import { ALL_PRO_MODEL_KINDS } from "../src/lib/video/scenes/pro-stage";
import { ALL_VECTOR_DIAGRAM_KINDS } from "../src/lib/video/scenes/vector-stage";
import { AUTO_REEL_MODEL_OPTION, REEL_MODELS } from "../src/lib/strings";
import { validateSetting } from "../src/lib/settings/keys";
import fs from "node:fs/promises";
import path from "node:path";
import type { Scene } from "../src/lib/video/scenes/types";

const makeScene = (index: number, kind: Scene["kind"], start: number, end: number, extra: Partial<Scene> = {}): Scene => ({
  index,
  kind,
  start,
  end,
  beatIndex: 0,
  sentences: [index],
  concept: "focus",
  reason: "fixture",
  tone: "warm",
  source: { pageIndex: 0, startWord: 0, endWord: 5 },
  ...extra,
});

test("ShotCraft + MotionMaxxing: 4-way camera cycle, spring/whip/split primitives, and safe-zone geometry audit pass cleanly", () => {
  const recipes = [0, 1, 2, 3].map((i) => pageCameraRecipeAt(i).recipe);
  assert.equal(new Set(recipes).size, 4, "4 distinct ShotCraft book-page camera moves cycle cleanly");

  assert.equal(viralCaptionFontSize("STOP NOW!"), 76);
  assert.equal(viralCaptionFontSize("Why equal choices freeze"), 70);
  assert.equal(viralCaptionFontSize("Every single habit eventually turns into pure automatism"), 58);

  const scenes: Scene[] = [
    makeScene(0, "cinematic", 0, 3, {
      cine: { hero: "hourglass", hook: true, lead: "", keyword: "FOCUS", accentWords: ["focus"] },
      words: [{ word: "Deep", start: 0.1, end: 0.4 }, { word: "focus", start: 0.4, end: 0.9 }],
    }),
    makeScene(1, "book-page", 3, 7, { shot: "wide" }),
    makeScene(2, "comparison", 7, 11, { left: "Busy work", right: "Deep focus", transitionIn: "whip-pan" }),
    makeScene(3, "stat", 11, 15, { stat: { value: "85%", label: "retention lift" }, transitionIn: "spring-pop" }),
    makeScene(4, "book-crop", 15, 19, { shot: "close", crop: { x0: 40, y0: 120, x1: 860, y1: 240 } }),
  ];

  const moves = cardCineMoves(scenes, 0.7);
  assert.equal(moves.length, 2);
  assert.notDeepEqual(moves[0].from, moves[1].from, "consecutive page scenes use distinct ShotCraft camera angles");

  const theme = bookThemeById("blueprint");
  const html = buildComposition({
    pkg: {
      ideaKey: "deep-focus",
      takeaway: ["Deep focus wins."],
      title: "Focus",
      hook: "Deep focus wins.",
      hookKeywords: ["focus"],
      cta: "Read more.",
      description: "Desc",
      hashtags: ["#focus"],
      beats: [{ id: "hook", voiceover: "Deep focus wins every single day.", onScreen: "Deep focus", sourcePage: 0, startWord: 0, endWord: 5 }],
    },
    beats: [{ index: 0, text: "Deep focus wins every single day.", file: "", start: 0, end: 19, speechStart: 0.1, speechEnd: 18.8 }],
    captions: [
      { text: "DEEP FOCUS", start: 0.1, end: 1.5, beatIndex: 0, words: [{ word: "DEEP", start: 0.1, end: 0.7 }, { word: "FOCUS", start: 0.7, end: 1.4 }] },
      { text: "Wins every single day", start: 3.2, end: 6.0, beatIndex: 0, words: [{ word: "Wins", start: 3.2, end: 4.0 }, { word: "every", start: 4.0, end: 4.8 }, { word: "single", start: 4.8, end: 5.4 }, { word: "day", start: 5.4, end: 6.0 }] },
    ],
    pages: [{ src: "assets/page-0.jpg", width: 1100, height: 1600, pageIndex: 0 }],
    sweeps: [[{ box: { x0: 80, y0: 180, x1: 880, y1: 230 }, start: 3.2, end: 6.0 }]],
    camera: [{ t: 0, y: 0 }],
    theme,
    totalDuration: 19,
    viralCaptions: true,
    bookTitle: "The Will Psychology",
    scenes,
  });

  const embedded = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
    assert.equal(embedded.motionMaxxing.ok, true);
    assert.equal(embedded.motionMaxxing.safeZonePass, true);
    assert.equal(embedded.motionMaxxing.seekSafePass, true);
    assert.ok(!html.includes('class="bokeh-dot"'), "viral renders suppress floating bokeh/spark dots");
    assert.deepEqual(embedded.lightSweeps, [], "viral renders suppress white flash sweep streaks");
    assert.equal(shotRecipeForScene(scenes[2]), "shotcraft-whip-compare");

  const audit = auditMotionMaxxingLayout({
    scenes,
    captions: [{ text: "DEEP FOCUS", start: 0.1, end: 1.5, beatIndex: 0, words: [] }],
    anims: embedded.anims,
    viralCaptions: true,
  });
  assert.equal(audit.ok, true, audit.issues.join("; "));
});

test("Earshot: synthesizes 8 studio foley kinds, ducks under speech spans, and verifies frame-accurate cut sync", () => {
  const scenes: Scene[] = [
    makeScene(0, "cinematic", 0, 3),
    makeScene(1, "book-page", 3, 6.5),
    makeScene(2, "quote", 6.5, 10),
    makeScene(3, "stat", 10, 14, { stat: { value: "90%", label: "clarity" } }),
    makeScene(4, "steps", 14, 18, { steps: ["Spot cue", "Pause", "Choose"] }),
  ];
  const strokes = [
    { start: 3.2, end: 4.5 },
    { start: 6.8, end: 8.1 },
  ];
  const speechSpans = [
    { start: 0.2, end: 2.6 },
    { start: 3.3, end: 6.0 },
    { start: 10.2, end: 13.5 },
  ];

  const cues = planSfxCues({
    durationSec: 20,
    audioOffsetSec: 0.7,
    scenes,
    strokes,
  });

  const kinds = new Set(cues.map((c) => c.kind));
  assert.ok(kinds.has("hook-hit"), "includes hook-hit");
  assert.ok(kinds.has("page-turn"), "includes paper page-turn foley");
  assert.ok(kinds.has("sub-drop"), "includes quote sub-drop");
  assert.ok(kinds.has("card-pop"), "includes card-pop thock");
  assert.ok(kinds.has("counter-tick"), "includes stat/steps counter ticks");
  assert.ok(kinds.has("marker-swish"), "includes marker highlight swish");
  assert.ok(kinds.has("payoff-riser"), "includes payoff riser");

  const unducked = renderSfxBuffer(20, cues);
  const ducked = renderSfxBuffer(20, cues, { speechSpans, audioOffsetSec: 0.7 });

  // Verify ducking reduces RMS inside spoken window while keeping peak headroom safe.
  let rmsUnducked = 0;
  let rmsDucked = 0;
  const checkStart = Math.round((0.7 + 10.25) * 44100);
  const checkEnd = Math.round((0.7 + 11.0) * 44100);
  for (let i = checkStart; i < checkEnd; i++) {
    rmsUnducked += unducked[i] * unducked[i];
    rmsDucked += ducked[i] * ducked[i];
  }
  assert.ok(rmsDucked < rmsUnducked * 0.75, "voice-aware sidechain ducking attenuates SFX during active speech");

  const report = verifyEarshotSync(ducked, cues, true);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.syncedCues, cues.length);
  assert.equal(report.voiceDucked, true);
  assert.ok(report.peakDb <= -6, `headroom ${report.peakDb} dBFS must stay <= -6 dBFS`);
  assert.equal(applyVoiceAwareDucking(new Float32Array(100), [], 0.7), false);
});

test("Voice lock & visual craft: single-speaker episode TTS lock, monolingual studio voices, editorial quote card, and light-palette plate contrast", async () => {
  // 1. Every mapped Edge neural voice is a stable monolingual studio voice (never MultilingualNeural, which shifts persona per beat).
  for (const [id, cfg] of Object.entries(EDGE_VOICE_MAP)) {
    assert.ok(!cfg.voice.includes("MultilingualNeural"), `${id} must not use unstable MultilingualNeural (${cfg.voice})`);
  }

  // 2. tts.ts never falls back per-beat from Edge-TTS to Pocket-TTS inside a beat loop.
  const ttsSrc = await fs.readFile(path.join(process.cwd(), "src", "lib", "media", "tts.ts"), "utf8");
  assert.ok(!ttsSrc.includes(".catch(() => synthPocket"), "tts.ts must never mix two TTS engines across beats of one episode");
  assert.ok(ttsSrc.includes("synthAllBeatsWith"), "tts.ts locks one voice engine across all beats of an episode");

  // 3. Editorial quote card joins scanned-PDF hyphenation ("reveal- ed." -> "revealed.") and attaches bgImageSrc cleanly.
  const rect = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H };
  const quoteScene = makeScene(2, "quote", 4, 9, {
    quote: { text: "In choice then, a man's character stands fully reveal- ed.", page: 0 },
    bgImageSrc: "assets/cine-plate-0.jpg",
  });
  const renderedQuote = renderScene(quoteScene, rect, bookThemeById("quiet").palette.accent)!;
  assert.match(renderedQuote.markup, /sc-quote-card/, "quote renders inside framed editorial card");
  assert.match(renderedQuote.markup, /sc-has-plate/, "plated scene carries sc-has-plate contrast class");
  assert.match(renderedQuote.markup, /fully revealed\./, "scanned line-break hyphenation is joined cleanly");

  // 4. sceneCss on both light and dark themes strictly uses palette colours only.
  for (const themeId of ["quiet", "marginalia", "blueprint", "spotlight", "terminal", "editorial"] as const) {
    const t = bookThemeById(themeId);
    const css = sceneCss(t, rect);
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const palette = new Set(Object.values(t.palette).map((v) => String(v).toLowerCase()));
    for (const h of hex) {
      assert.ok([...palette].some((p) => p.includes(h.toLowerCase())), `${themeId}: ${h} is not a palette colour`);
    }
  }
});

test("Viral HyperFrames 3-style stage + Reels Foley: seek-safe SVG vectorMode, 20% BGM, and ui-click/shutter-snap/clock-tick sync", () => {
  const rect = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H };
  const vecScene = makeScene(0, "cinematic", 0, 5, {
    cine: { hero: "focus", keyword: "attention", lead: "Internal", hook: true, vectorMode: true },
    words: [
      { word: "Willpower", start: 0.1, end: 0.5 },
      { word: "is", start: 0.52, end: 0.7 },
      { word: "attention.", start: 0.72, end: 1.2 },
    ],
  });
  const renderedVec = renderScene(vecScene, rect, bookThemeById("terminal").palette.accent)!;
  assert.match(renderedVec.markup, /cine-vec-wrap/, "vectorMode emits inline SVG stage");
  assert.ok(!renderedVec.markup.includes("cine-hero"), "vectorMode skips WebGL canvas");
  assert.ok(renderedVec.anims.some((a) => a.k === "draw"), "vectorMode schedules GSAP SVG stroke draw tweens");
  assert.deepEqual(overlappingAnims(renderedVec.anims), [], "vectorMode has zero overlapping tweens");

  const cropScene = makeScene(1, "book-crop", 5, 10, { crop: { x0: 40, y0: 200, x1: 800, y1: 320 } });
  const scalesScene = makeScene(2, "cinematic", 10, 16, {
    cine: { hero: "scales", keyword: "alternatives", lead: "swinging between" },
  });
  const nextVecScene = makeScene(3, "cinematic", 16, 21, {
    cine: { hero: "loop", keyword: "habit", lead: "daily", vectorMode: true },
  });

  const cues = planSfxCues({
    durationSec: 23,
    audioOffsetSec: 0.7,
    scenes: [vecScene, cropScene, scalesScene, nextVecScene],
  });
  const kinds = new Set(cues.map((c) => c.kind));
  assert.ok(kinds.has("shutter-snap"), "book-crop cut schedules shutter-snap foley");
  assert.ok(kinds.has("clock-tick"), "scales hero schedules horological clock-tick foley");
  assert.ok(kinds.has("ui-click"), "vectorMode scene schedules crisp ui-click foley");

  const buf = renderSfxBuffer(23, cues, { speechSpans: [{ start: 1, end: 4 }], audioOffsetSec: 0.7 });
  const sync = verifyEarshotSync(buf, cues, true);
  assert.equal(sync.ok, true, `Earshot sync failed: ${JSON.stringify(sync)}`);
  assert.ok(sync.peakDb <= -6, `Peak headroom exceeded: ${sync.peakDb} dB`);

  assert.equal(ALL_PRO_MODEL_KINDS.length, 21, "All 21 interactive Pro & Glassmorphism rigs registered");
  for (const pm of ALL_PRO_MODEL_KINDS) {
    const proScene = makeScene(0, "cinematic", 2, 8, {
      cine: { hero: "focus", keyword: "target", lead: "Lab test", proModel: pm },
    });
    const out = renderScene(proScene, rect, bookThemeById("blueprint").palette.accent)!;
    assert.match(out.markup, /pro-stage/, `${pm} renders pro-stage container`);
    assert.deepEqual(overlappingAnims(out.anims), [], `${pm} has zero overlapping GSAP tweens`);
  }

  assert.equal(ALL_VECTOR_DIAGRAM_KINDS.length, 10, "All 10 geometric vector diagrams registered");
  for (const vk of ALL_VECTOR_DIAGRAM_KINDS) {
    const vecDiagramScene = makeScene(0, "cinematic", 2, 8, {
      cine: { hero: "focus", keyword: "target", lead: "Vector test", vectorMode: true, vectorKind: vk },
    });
    const out = renderScene(vecDiagramScene, rect, bookThemeById("blueprint").palette.accent)!;
    assert.match(out.markup, /vec-stroke-/, `${vk} renders vector SVG strokes`);
    assert.deepEqual(overlappingAnims(out.anims), [], `${vk} has zero overlapping GSAP tweens`);
  }

  // 10-Model Pro Motion + Auto UI/Backend selector contract
  assert.equal(ALL_REEL_MODEL_IDS.length, 10, "Exactly 10 Pro Motion models registered");
  assert.equal(REEL_MODELS.length, ALL_REEL_MODEL_IDS.length, "UI exposes all 10 Pro Motion models");
  assert.equal(AUTO_REEL_MODEL_OPTION.id, REEL_MODEL_AUTO, "Auto option matches REEL_MODEL_AUTO");
  assert.deepEqual(
    REEL_MODELS.map((m) => m.id),
    [...ALL_REEL_MODEL_IDS],
    "UI REEL_MODELS and backend ALL_REEL_MODEL_IDS agree exactly",
  );
  assert.equal(validateSetting("reelModel", "auto"), "auto");
  for (const id of ALL_REEL_MODEL_IDS) {
    assert.equal(validateSetting("reelModel", id), id);
  }
  assert.equal(validateSetting("reelModel", "unknown-model"), null);

  // Auto rotation across 10 ideas produces all 10 distinct models without duplicates
  const pickedAuto: string[] = [];
  for (let i = 0; i < 10; i++) {
    const chosen = chooseAutoReelModel(`Book idea number ${i} about psychology and habits`, pickedAuto, i);
    pickedAuto.push(chosen);
  }
  assert.equal(new Set(pickedAuto).size, 10, "Auto mode rotates cleanly across all 10 distinct Pro Motion models");

  // applyReelModelToScenes + buildProMotionComposition produce valid compositions for all 10 models
  const samplePkg = {
    ideaKey: "k",
    title: "Test Idea",
    hook: "Test Hook",
    beats: [
      { id: "b0", voiceover: "Missing one planned workout does not mean failure.", onScreen: "One missed workout", sourcePage: 0, startWord: 0, endWord: 5 },
      { id: "b1", voiceover: "Fifty people shifted a crowd of 500,000 through unified direction.", onScreen: "Unified direction", sourcePage: 0, startWord: 6, endWord: 12 },
      { id: "b2", voiceover: "Filter out daily friction and focus on what matters most.", onScreen: "Zero friction", sourcePage: 1, startWord: 0, endWord: 8 },
      { id: "b3", voiceover: "Follow BookReel for more ideas from great books.", onScreen: "Follow BookReel", sourcePage: 1, startWord: 9, endWord: 16 },
    ],
    takeaway: ["Takeaway"],
    cta: "Follow BookReel",
    description: "Desc",
    hashtags: [],
  };
  const basePlan = [
    makeScene(0, "cinematic", 0, 4, { beatIndex: 0, cine: { hero: "focus", keyword: "workout", lead: "Missing one", hook: true } }),
    makeScene(1, "cinematic", 4, 9, { beatIndex: 1, cine: { hero: "scales", keyword: "crowd", lead: "Fifty shifted" } }),
    makeScene(2, "cinematic", 9, 13, { beatIndex: 2, cine: { hero: "clock", keyword: "BookReel", lead: "Follow" } }),
  ];
  const sampleTimedBeats = [
    { index: 0, text: samplePkg.beats[0].voiceover, file: "b0.wav", start: 0, end: 5, duration: 5, speechStart: 0.1, speechEnd: 4.8 },
    { index: 1, text: samplePkg.beats[1].voiceover, file: "b1.wav", start: 5, end: 11, duration: 6, speechStart: 5.1, speechEnd: 10.8 },
    { index: 2, text: samplePkg.beats[2].voiceover, file: "b2.wav", start: 11, end: 17, duration: 6, speechStart: 11.1, speechEnd: 16.8 },
    { index: 3, text: samplePkg.beats[3].voiceover, file: "b3.wav", start: 17, end: 21, duration: 4, speechStart: 17.1, speechEnd: 20.8 },
  ];
  for (const modelId of ALL_REEL_MODEL_IDS) {
    const styled = applyReelModelToScenes(modelId, basePlan, samplePkg);
    for (const sc of styled) {
      const r = renderScene(sc, rect, bookThemeById("spotlight").palette.accent);
      assert.ok(r, `${modelId} scene ${sc.index} renders`);
      assert.deepEqual(overlappingAnims(r!.anims), [], `${modelId} scene ${sc.index} is seek-safe`);
    }
    const pm = buildProMotionComposition({
      model: modelId,
      pkg: samplePkg,
      beats: sampleTimedBeats,
      words: [],
      totalDuration: 21,
      bookTitle: "Test Book",
      author: "Test Author",
      bookLink: "https://example.com/book",
      music: true,
      sfx: true,
    });
    assert.match(pm.html, /data-composition-id="main"/, `${modelId} emits HyperFrames root`);
    assert.match(pm.html, /window\.__timelines\["main"\] = tl;/, `${modelId} registers master GSAP timeline`);
    assert.ok(pm.sfxMoments.length >= 2, `${modelId} schedules matched studio SFX cues`);
  }
});

test("Real sfx/ folder library: loads all 18 studio files, places cues selectively (>=5.2s gap), matches models, and varies across videos", async () => {
  const lib = await loadProjectSfxLibrary();
  assert.ok(lib.length >= 18, `Expected >= 18 real SFX files in sfx/, loaded ${lib.length}`);

  const nineScenes: Scene[] = [
    makeScene(0, "cinematic", 0, 6.5, {
      sceneModel: "magnates-cinema",
      cine: {
        hero: "clock",
        keyword: "act",
        lead: "",
        hook: true,
        plate: {
          imageSrc: "a.jpg",
          depthSrc: "d.png",
          cameraMove: "push-in",
          atmosphere: "still",
          dominantHex: "#0f172a",
          accentHex: "#7dd3fc",
          shadowHex: "#04070f",
        },
      },
    }),
    makeScene(1, "book-crop", 6.5, 13.3, { sceneModel: "trifecta-viral", crop: { x0: 0, y0: 0, x1: 500, y1: 200 } }),
    makeScene(2, "cinematic", 13.3, 20.9, { sceneModel: "neuro-lab", cine: { hero: "mind", keyword: "timer", lead: "wired", proModel: "lab-apparatus" } }),
    makeScene(3, "cinematic", 20.9, 29.4, { sceneModel: "vision-bento", cine: { hero: "focus", keyword: "locked", lead: "ms", proModel: "obstacle-radar" } }),
    makeScene(4, "quote", 29.4, 36.2, { sceneModel: "investigative-dossier", quote: { text: "Choose at once.", page: 70 } }),
    makeScene(5, "steps", 36.2, 48.6, { sceneModel: "vox-explainer", steps: ["One", "Two", "Three"] }),
    makeScene(6, "cinematic", 48.6, 51.5, { sceneModel: "dankoe-vector", cine: { hero: "path", keyword: "volition", lead: "map", vectorMode: true } }),
    makeScene(7, "comparison", 51.5, 54.5, { sceneModel: "trifecta-viral", left: "A", right: "B" }),
    makeScene(8, "cinematic", 54.5, 58.0, { sceneModel: "magnates-cinema", cine: { hero: "clock", keyword: "excuse", lead: "Save" } }),
  ];

  const planA = planSelectiveLibrarySfx({
    durationSec: 59.1,
    audioOffsetSec: 0.7,
    scenes: nineScenes,
    library: lib,
    reelModel: "omni-7-ultra",
    seedKey: "episode-alpha",
  });
  const planB = planSelectiveLibrarySfx({
    durationSec: 59.1,
    audioOffsetSec: 0.7,
    scenes: nineScenes,
    library: lib,
    reelModel: "omni-7-ultra",
    seedKey: "episode-beta",
  });

  assert.ok(planA.length >= 5 && planA.length <= 7, `Sparse natural count (got ${planA.length}, never wall-to-wall)`);
  for (let i = 1; i < planA.length; i++) {
    assert.ok(planA[i].timeSec - planA[i - 1].timeSec >= 5.2, "At least 5.2s clean breathing room between SFX cues");
    assert.notEqual(planA[i].fileName, planA[i - 1].fileName, "Never repeats the same SFX file back-to-back");
  }
  assert.notDeepEqual(
    planA.map((p) => p.fileName),
    planB.map((p) => p.fileName),
    "Different videos pick varied SFX combinations instead of identical files",
  );

  // Plain narration / book-page scenes stay 100% free of SFX spam
  const plainReadingScenes: Scene[] = [
    makeScene(0, "book-page", 0, 8),
    makeScene(1, "kinetic-text", 8, 16),
    makeScene(2, "book-page", 16, 24),
  ];
  const plainPlan = planSelectiveLibrarySfx({
    durationSec: 25,
    audioOffsetSec: 0.7,
    scenes: plainReadingScenes,
    library: lib,
    reelModel: "vox-explainer",
    seedKey: "plain-ep",
  });
  assert.equal(plainPlan.length, 0, "Plain reading/narration scenes without visual rigs do not force unnecessary SFX");

  const osTmp = path.join(process.cwd(), ".bookreel", "work", "test-selective-sfx.wav");
  const track = await generateSfxTrack({
    durationSec: 59.1,
    audioOffsetSec: 0.7,
    scenes: nineScenes,
    speechSpans: [{ start: 1, end: 5 }, { start: 13.5, end: 18 }],
    reelModel: "omni-7-ultra",
    seedKey: "episode-alpha",
    outPath: osTmp,
  });
  assert.equal(track.syncReport.ok, true, JSON.stringify(track.syncReport));
  assert.ok((track.usedFiles?.length ?? 0) >= 5);
  await fs.rm(osTmp, { force: true }).catch(() => {});
});
