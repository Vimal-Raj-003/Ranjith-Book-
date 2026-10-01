// Fixture input for the seek-safety harness (scripts/e2e-seek.mjs).
//
// Deliberately bigger than tests/composition.test.mts's `input()`: three
// pages, six beats, and sweep strokes that land on more than one page, so
// the camera actually has to move and there is real cross-page geometry for
// a seek bug to hide in. `tests/composition.test.mts` already proves the
// two-beat/one-page shape is seek-safe; this fixture is what would catch a
// bug that only shows up once the column is tall enough for the camera
// track to do real work.
import { buildCaptions } from "../../src/lib/media/captions.ts";

/**
 * @param {{ theme: unknown, withScenes?: boolean, cinematic?: boolean }} opts
 *   `cinematic` swaps three scenes for hero scenes (the opening hook, an
 *   hourglass and a growth spiral) so the seek harness and the live checks cover
 *   the cinematic engine; the default plan is unchanged.
 */
export function fixtureInput({ theme, withScenes = false, cinematic = false }) {
  const pages = [
    { src: "assets/page-00.jpg", width: 1000, height: 1400 },
    { src: "assets/page-01.jpg", width: 1000, height: 1400 },
    { src: "assets/page-02.jpg", width: 1000, height: 1400 },
  ];

  const pkgBeats = [
    { id: "hook", voiceover: "A quiet opening line begins.", onScreen: "Hook", sourcePage: 0, startWord: 0, endWord: 3 },
    { id: "context", voiceover: "The context deepens quickly here.", onScreen: "Context", sourcePage: 0, startWord: 4, endWord: 8 },
    { id: "idea-1", voiceover: "An idea emerges from the page.", onScreen: "Idea", sourcePage: 1, startWord: 0, endWord: 4 },
    { id: "idea-2", voiceover: "The idea complicates further still.", onScreen: "More", sourcePage: 1, startWord: 5, endWord: 9 },
    { id: "turn", voiceover: "Everything turns around right here.", onScreen: "Turn", sourcePage: 2, startWord: 0, endWord: 4 },
    { id: "cta", voiceover: "Follow along for more breakdowns.", onScreen: "Follow", sourcePage: 2, startWord: 5, endWord: 8 },
  ];

  // BeatAudio-shaped entries: sequential clip windows with real gaps between
  // them (GAP-like spacing, mirroring media/tts.ts), each with a speech
  // window strictly inside its clip window.
  const beats = [
    { index: 0, text: pkgBeats[0].voiceover, file: "b0.wav", start: 0, end: 2.0, speechStart: 0.1, speechEnd: 1.9 },
    { index: 1, text: pkgBeats[1].voiceover, file: "b1.wav", start: 2.3, end: 4.3, speechStart: 2.4, speechEnd: 4.2 },
    { index: 2, text: pkgBeats[2].voiceover, file: "b2.wav", start: 4.6, end: 6.6, speechStart: 4.7, speechEnd: 6.5 },
    { index: 3, text: pkgBeats[3].voiceover, file: "b3.wav", start: 6.9, end: 8.9, speechStart: 7.0, speechEnd: 8.8 },
    { index: 4, text: pkgBeats[4].voiceover, file: "b4.wav", start: 9.2, end: 11.2, speechStart: 9.3, speechEnd: 11.1 },
    { index: 5, text: pkgBeats[5].voiceover, file: "b5.wav", start: 11.5, end: 13.5, speechStart: 11.6, speechEnd: 13.4 },
  ];

  const captions = buildCaptions(beats);

  // Sweep strokes: page-local boxes (the same coordinate space `pages[i]`
  // itself is drawn in). Two strokes per beat, so a beat's marker moves line
  // to line, and beats 2/3 (page 1) and 4/5 (page 2) put real geometry on
  // pages other than the first — the case a one-page fixture cannot cover.
  const sweeps = [
    [
      { box: { x0: 60, y0: 60, x1: 560, y1: 110 }, start: 0.1, end: 1.0 },
      { box: { x0: 60, y0: 120, x1: 640, y1: 170 }, start: 1.0, end: 1.9 },
    ],
    [
      { box: { x0: 60, y0: 320, x1: 600, y1: 370 }, start: 2.4, end: 3.3 },
      { box: { x0: 60, y0: 380, x1: 660, y1: 430 }, start: 3.3, end: 4.2 },
    ],
    [
      { box: { x0: 60, y0: 60, x1: 560, y1: 110 }, start: 4.7, end: 5.6 },
      { box: { x0: 60, y0: 120, x1: 600, y1: 170 }, start: 5.6, end: 6.5 },
    ],
    [
      { box: { x0: 60, y0: 320, x1: 620, y1: 370 }, start: 7.0, end: 7.9 },
      { box: { x0: 60, y0: 380, x1: 600, y1: 430 }, start: 7.9, end: 8.8 },
    ],
    [
      { box: { x0: 60, y0: 60, x1: 560, y1: 110 }, start: 9.3, end: 10.2 },
      { box: { x0: 60, y0: 120, x1: 620, y1: 170 }, start: 10.2, end: 11.1 },
    ],
    [
      { box: { x0: 60, y0: 320, x1: 640, y1: 370 }, start: 11.6, end: 12.5 },
      { box: { x0: 60, y0: 380, x1: 600, y1: 430 }, start: 12.5, end: 13.4 },
    ],
  ];

  // Hand-authored camera keys (rather than `cameraTrack`, which is scoped to
  // a single page's height) spanning the whole three-page column, so the
  // camera genuinely moves across the fixture's duration instead of sitting
  // still at y=0.
  const camera = [
    { t: 0, y: 0 },
    { t: 1.9, y: 0 },
    { t: 4.2, y: 500 },
    { t: 6.5, y: 1400 },
    { t: 8.8, y: 1900 },
    { t: 11.1, y: 2800 },
    { t: 13.4, y: 3000 },
  ];

  // One scene of every kind (Phase 3C), covering the whole narration in order.
  // Deliberately exercises all eight layer templates plus both book kinds, so
  // the seek harness proves the scene stack and not just one template of it.
  const icon = (name) => ({ name, paths: '<path d="M12 7v5l3 3" />', query: name, score: 0.5 });
  const sceneAt = (i, kind, start, end, tone, extra) => ({
    index: i, kind, start, end, tone, sentences: [i], beatIndex: Math.min(i, pkgBeats.length - 1),
    source: { pageIndex: Math.min(i % 3, 2), startWord: 0, endWord: 3 },
    reason: "fixture", concept: "a clock", ...extra,
  });
  const scenes = [
    // The third word is deliberately "compounding." rather than a generic
    // one: emphasis.ts classifies it as "growth", and lottie.ts has an
    // authored clip for that category (Phase 4's first advanced-visual
    // module) — this scene has no icon set, so it exercises the Lottie
    // accent path, and this fixture is what scripts/e2e-seek.mjs's
    // seek-safety proof and scripts/verify-lottie.mjs's screenshots both
    // run against. Scenes elsewhere in this same array (e.g. #2's
    // icon-concept) still exercise the ordinary Tabler-icon path unchanged.
    sceneAt(0, "kinetic-text", 0, 2.0, "deep", { words: [
      { word: "A", start: 0.1, end: 0.5 }, { word: "quiet", start: 0.6, end: 1.1 }, { word: "compounding.", start: 1.2, end: 1.9 },
    ] }),
    sceneAt(1, "book-page", 2.0, 4.3, "warm", {}),
    sceneAt(2, "icon-concept", 4.3, 6.6, "cool", { icons: [icon("clock"), icon("bulb")], items: ["time", "ideas"] }),
    sceneAt(3, "book-crop", 6.6, 8.9, "warm", { crop: { x0: 40, y0: 300, x1: 900, y1: 440 } }),
    sceneAt(4, "comparison", 8.9, 10.2, "bright", { left: "before", right: "after", icons: [icon("clock"), icon("bulb")] }),
    sceneAt(5, "steps", 10.2, 11.2, "cool", { steps: ["first", "second", "third"] }),
    sceneAt(6, "growth-curve", 11.2, 12.0, "bright", { curve: { points: [4, 12, 30, 70], label: "compounding" } }),
    sceneAt(7, "timeline", 12.0, 12.7, "cool", { steps: ["then", "now"] }),
    sceneAt(8, "stat", 12.7, 13.1, "deep", { stat: { value: "3", label: "degrees" } }),
    sceneAt(9, "quote", 13.1, 13.5, "warm", { quote: { text: "What stands in the way becomes the way", page: 2 } }),
  ];

  if (cinematic) {
    scenes[0] = sceneAt(0, "cinematic", 0, 2.0, "deep", {
      words: [{ word: "A", start: 0.1, end: 0.5 }, { word: "quiet", start: 0.6, end: 1.1 }, { word: "compounding.", start: 1.2, end: 1.9 }],
      cine: { hero: "clock", keyword: "compounding", lead: "", hook: true, accentWords: ["compounding"] },
    });
    scenes[2] = sceneAt(2, "cinematic", 4.3, 6.6, "deep", {
      words: [{ word: "An", start: 4.7, end: 4.9 }, { word: "idea", start: 4.9, end: 5.4 }, { word: "emerges", start: 5.5, end: 6.0 }, { word: "here.", start: 6.0, end: 6.5 }],
      cine: { hero: "hourglass", keyword: "idea", lead: "An" },
    });
    scenes[6] = sceneAt(6, "cinematic", 11.2, 12.0, "deep", {
      words: [{ word: "Compounding", start: 11.3, end: 11.8 }],
      cine: { hero: "growth", keyword: "compounding", lead: "" },
    });
  }

  return {
    ...(withScenes ? { scenes } : {}),
    bookTitle: "Fixture Book",
    pkg: {
      title: "Fixture Book",
      hook: pkgBeats[0].voiceover,
      ideaKey: "fixture-key",
      cta: pkgBeats[5].voiceover,
      description: "",
      hashtags: [],
      takeaway: [],
      beats: pkgBeats,
    },
    beats,
    captions,
    pages,
    sweeps,
    camera,
    theme,
    totalDuration: beats[beats.length - 1].end,
  };
}
