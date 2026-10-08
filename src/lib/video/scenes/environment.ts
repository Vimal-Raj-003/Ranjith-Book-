/**
 * The environment catalogue: the world each scene sits in, and how one is chosen.
 *
 * `theme.backdrop()` used to be emitted once, outside the scene stack, and the theme
 * itself came from a global setting, so nothing a sentence said could change the
 * background. Each scene now carries an `environment`. The visual director picks it
 * while it reads the narration (the same call that already picks `kind`, `hero` and
 * `concept`), and `validate.ts` repairs it when it is missing or invalid.
 *
 * Why these seven, and not eight different gradients. The set is judged on whether
 * two unrelated videos look different at a glance and one video's world follows its
 * story without looking random, so each environment differs from the others in
 * WHERE THE LIGHT COMES FROM and HOW HEAVY THE DARK IS, not in hue. A theme only has
 * two hues to give (its accent and its second bloom), so hue cannot carry seven
 * meanings; light direction, weight and texture can:
 *
 *   still   an even quiet ground, light high up      (rest, clarity; the safe default)
 *   dawn    light rising from the bottom edge        (beginning, hope, progress)
 *   dusk    heavy sky, a low band of fading light    (time slipping, loss, endings)
 *   storm   dark, slanting streaks, a hard flash     (conflict, fear, pressure, obstacles)
 *   deep    a tunnel closing round a faint pool      (the mind, memory, what lies beneath)
 *   warm    a wide glow lit from the middle          (people, closeness, comfort)
 *   grid    a ruled grid under a spotlight           (structure, method, plans, numbers)
 *
 * Mapped onto this catalogue's own content: a book of self-improvement and philosophy
 * spends its time on time (dusk), the mind (deep), attention and rest (still),
 * obstacles and fear (storm), progress (dawn), other people (warm) and method (grid).
 *
 * An earlier proposal also had `void` and `paper`. `void` (dark emptiness) is `deep`
 * without a reason to exist beside it: both are dark and centred, and a viewer cannot
 * tell them apart. `paper` (the page) is the theme's own ground, which `still` already
 * is; a page scene shows the real page card on top of whatever is behind it.
 *
 * Pure data and functions: no model call, no DOM, safe to import anywhere.
 */
import { ENVIRONMENTS, isEnvironment, type Environment, type Scene, type SceneTone } from "./types";
import type { HeroId } from "./heroes";

/** What each environment looks like and when to use it: the director's catalogue. */
export const ENVIRONMENT_GUIDE: Record<Environment, { shows: string; use: string }> = {
  still: {
    shows: "an even, quiet ground with a soft light high up and nothing pulling at the eye",
    use: "calm and clarity: rest, quiet, simplicity, one clear point, reading and reflection, and the safe default when a sentence carries no strong mood",
  },
  dawn: {
    shows: "warm light rising from the bottom edge of the frame and widening upward",
    use: "a beginning, hope, progress, an insight arriving, a way out opening, things getting better",
  },
  dusk: {
    shows: "a heavy dark sky above and a low band of fading light along the horizon",
    use: "time slipping away, loss, regret, endings, the cost of waiting, what is behind you",
  },
  storm: {
    shows: "a dark, tense ground with slanting streaks of rain and one hard flash of light off to the side",
    use: "conflict, anger, fear, pressure, an obstacle pushing back, everything going wrong",
  },
  deep: {
    shows: "a dark tunnel closing in around a faint pool of light, with rings spreading out from the centre",
    use: "the mind and the inner life: thought, memory, attention turned inward, mystery, what lies beneath the surface",
  },
  warm: {
    shows: "a wide, soft, enveloping glow lit from the middle of the frame",
    use: "people and closeness: relationships, conversation, care, belonging, comfort, gratitude",
  },
  grid: {
    shows: "a faint ruled grid under a spotlight, like a plan on drafting paper",
    use: "structure and method: a system, a plan, steps, rules, cause and effect, numbers, a schedule",
  },
};

/** The catalogue as the director's prompt prints it. */
export function environmentCatalogue(): string {
  return ENVIRONMENTS.map((id) => `- ${id} — ${ENVIRONMENT_GUIDE[id].shows}. Use for: ${ENVIRONMENT_GUIDE[id].use}.`).join("\n");
}

/**
 * The world a hero's idea lives in, for when the director did not choose one. A
 * `Record` over every hero, so a new hero cannot be added to the catalogue without
 * saying which world it belongs to (the same discipline `FIT` and `HERO_GUIDE` hold).
 * This is the meaning-derived fallback: a hero is chosen by what the narration is
 * about, so the world it implies follows the story even with no director at all.
 */
export const HERO_ENVIRONMENT: Record<HeroId, Environment> = {
  hourglass: "dusk",
  clock: "grid",
  orbit: "deep",
  staircase: "dawn",
  bookletters: "still",
  chain: "dusk",
  path: "dawn",
  mountain: "storm",
  spark: "dawn",
  scales: "grid",
  network: "warm",
  pulse: "warm",
  focus: "still",
  growth: "dawn",
  mind: "deep",
  storm: "storm",
  rest: "still",
  dialogue: "warm",
  wall: "storm",
  heart: "warm",
  loop: "grid",
  orb: "still",
};

/**
 * The world a scene's TONE implies, the last resort. The tone is set from the scene's
 * KIND (validate.ts's `TONE_BY_KIND`), not from what it says, so this is a weaker answer
 * than the hero's: it only says what sort of scene it is (a page, a diagram, a statement).
 */
export const TONE_ENVIRONMENT: Record<SceneTone, Environment> = {
  neutral: "still",
  warm: "warm",
  cool: "grid",
  bright: "dawn",
  deep: "deep",
};

/**
 * An environment for a scene that has none of its own: its hero's, when it has one,
 * otherwise its tone's. Always answers, so no scene is ever left without a world.
 */
export function environmentFor(scene: Pick<Scene, "kind" | "tone" | "cine">): Environment {
  if (scene.kind === "cinematic" && scene.cine) return HERO_ENVIRONMENT[scene.cine.hero] ?? TONE_ENVIRONMENT[scene.tone] ?? "still";
  return TONE_ENVIRONMENT[scene.tone] ?? "still";
}

/** The director's choice when it is one of ours, otherwise the derived one. Never a guess at a near miss. */
export function resolveEnvironment(asked: unknown, scene: Pick<Scene, "kind" | "tone" | "cine">): Environment {
  return isEnvironment(asked) ? asked : environmentFor(scene);
}
