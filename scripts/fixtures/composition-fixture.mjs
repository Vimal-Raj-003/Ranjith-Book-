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
 * @param {{ theme: unknown }} opts
 */
export function fixtureInput({ theme }) {
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

  return {
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
