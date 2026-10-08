import type { MusicMood } from "./music-synth";

/**
 * The music-bed mood registry, as pure data.
 *
 * This module is the client-safe half of a split, following the one
 * `pipeline-steps.ts` makes for `pipeline.ts`. The registry used to live in
 * `ffmpeg.ts`, which imports `node:child_process`; anything that wanted the list
 * of mood ids had to import that file. That is fine on the server and fatal in a
 * `"use client"` component, because the bundler then follows the import into
 * `child_process`, which cannot resolve in the browser. The inspector needs the
 * ids to offer a mood picker and `settings/keys.ts` needs them to validate one,
 * so they live here, where nothing can pull node in behind them.
 *
 * Keep it that way: no value imports, and nothing from `ffmpeg.ts`. The only
 * import is the `MusicMood` TYPE, which is erased at build time.
 * `ffmpeg.ts` re-exports `MOODS` as `MUSIC_MOODS`, so its public name is
 * unchanged and `generateMusicBed` reads the same object it always did.
 */

/**
 * What the bed sounds like, chosen per video rather than fixed.
 *
 * The previous bed was three static sine partials with a slow tremolo — a
 * drone, not music. A drone has no phrase and no development, so after about
 * fifteen seconds the ear stops hearing it as background and starts hearing it
 * as a fault. These are short chord progressions instead: they move, they
 * resolve, and they get out of the way.
 *
 * Semitone offsets from the key's root, one entry per chord, three voices each.
 */

const MOODS: Record<string, MusicMood> = {
  // Dark, developer-native. Minor, unhurried, no brightness.
  terminal: {
    id: "terminal",
    // i – VI – III – VII, the standard "calm technical" loop.
    progression: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],
    chordSeconds: 4,
    root: 130.81, // C3
  },
  // Punchy, made for Shorts. Same minor colour, faster harmonic rhythm.
  spotlight: {
    id: "spotlight",
    progression: [[0, 3, 7], [5, 8, 12], [10, 14, 17], [7, 10, 14]],
    chordSeconds: 3,
    root: 146.83, // D3
  },
  // Calm, technical, documentary. Suspended voicings, very little movement.
  blueprint: {
    id: "blueprint",
    progression: [[0, 5, 7], [2, 7, 9], [0, 5, 7], [-2, 3, 5]],
    chordSeconds: 5,
    root: 123.47, // B2
  },
  // Warm paper, magazine feature. Major, gentle, the friendliest of the four.
  editorial: {
    id: "editorial",
    // I – V – vi – IV.
    progression: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
    chordSeconds: 4.5,
    root: 138.59, // C#3
  },

  // The six below were added with the intensity layers. The four above ship in
  // every video made so far and are never edited: a re-render of an old episode
  // must come out in the same key, so a change to one of them is a change to the
  // sound of work already delivered. `tests/settings-keys.test.mts` pins them.

  // Wide, cinematic, unhurried. Major with a suspended 2nd — the "establishing
  // shot" of the set.
  vista: {
    id: "vista",
    progression: [[0, 5, 7], [5, 9, 12], [7, 12, 14], [0, 4, 7]],
    chordSeconds: 5.5,
    root: 110.0, // A2
  },
  // Tense, forward-leaning. Minor seconds held against the root.
  tension: {
    id: "tension",
    progression: [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-1, 3, 6]],
    chordSeconds: 3.5,
    root: 123.47, // B2
  },
  // Resolute, hymn-like. Root-position major triads, slow.
  resolve: {
    id: "resolve",
    progression: [[0, 4, 7], [5, 9, 12], [3, 7, 10], [0, 4, 7]],
    chordSeconds: 5,
    root: 130.81, // C3
  },
  // Nocturnal and intimate. Minor 7ths, very low movement.
  nocturne: {
    id: "nocturne",
    progression: [[0, 3, 10], [-2, 3, 7], [0, 3, 10], [5, 8, 12]],
    chordSeconds: 6,
    root: 98.0, // G2
  },
  // Bright and propulsive, for lighter books. Major, fastest harmonic rhythm.
  momentum: {
    id: "momentum",
    progression: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]],
    chordSeconds: 2.5,
    root: 146.83, // D3
  },
  // Austere. Open fifths only, no third, so it states no mood of its own.
  stark: {
    id: "stark",
    progression: [[0, 7, 12], [5, 12, 17], [0, 7, 12], [3, 10, 15]],
    chordSeconds: 4.5,
    root: 116.54, // A#2
  },
};

export { MOODS };
