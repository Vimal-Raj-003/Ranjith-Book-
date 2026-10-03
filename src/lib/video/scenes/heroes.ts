/**
 * The cinematic hero catalogue: which procedural 3D object stands for which idea.
 *
 * The objects themselves live in `cine-runtime.js` (plain Three.js, no assets).
 * This file is the other half of the contract: the ids the director may choose
 * from, a one-line brief of each for its prompt, and a deterministic matcher
 * that picks a hero from narration alone. The matcher is what guarantees every
 * video a topic-specific opening even when the director call fails, and it is
 * also the repair when the director names a hero that does not exist.
 *
 * Two matchers live here. `heroRanker` chooses by MEANING, comparing the
 * narration against what each hero is for with the sentence embedder book
 * analysis already uses. `heroForTextSync` is the older keyword counter, kept
 * as the floor: purely lexical like `emphasis.ts` and `three-shapes.ts`, no
 * model call, no network, the same text mapped to the same hero on every run.
 * Both run when the scenes are PLANNED, never when the video is rendered.
 */
import { normalizeToken } from "../../ingest/align";
import { cosine, lexicalEmbedder, transformersEmbedder, type Embedder } from "../../analysis/embed";

export const HERO_IDS = [
  "hourglass",
  "clock",
  "orbit",
  "staircase",
  "bookletters",
  "chain",
  "path",
  "mountain",
  "spark",
  "scales",
  "network",
  "pulse",
  "focus",
  "growth",
  "orb",
] as const;

export type HeroId = (typeof HERO_IDS)[number];

export function isHeroId(v: unknown): v is HeroId {
  return typeof v === "string" && (HERO_IDS as readonly string[]).includes(v);
}

/** What each hero depicts and when to use it — the director's catalogue. */
export const HERO_GUIDE: Record<HeroId, { shows: string; use: string; words: string[] }> = {
  hourglass: {
    shows: "a glowing hourglass, sand falling",
    use: "time running out, patience, waiting, deadlines, moments, a limited lifetime",
    words: ["time", "hour", "moment", "wait", "patience", "deadline", "wasted", "waste", "late", "urgent", "lifetime", "limited", "finite", "minutes", "years", "passing", "ticking", "running"],
  },
  clock: {
    shows: "a clock inside a vortex of light, hands racing",
    use: "the daily routine, schedules, the day, rushing, being busy, commuting",
    words: ["clock", "schedule", "routine", "day", "daily", "morning", "evening", "week", "timing", "rush", "hurry", "busy", "calendar", "commute", "hours", "tonight", "o'clock", "tired", "tiredness"],
  },
  orbit: {
    shows: "planets orbiting a glowing sun",
    use: "a system, the bigger picture, perspective, order, cycles, the whole of something",
    words: ["system", "universe", "world", "order", "perspective", "pattern", "cycle", "planet", "whole", "everything", "cosmos", "nature", "center", "centre", "orbit", "life", "bigger", "larger"],
  },
  staircase: {
    shows: "a staircase with a glowing light climbing it",
    use: "small steps, gradual progress, habits, practice, improving over time",
    words: ["step", "steps", "progress", "improve", "improvement", "habit", "habits", "incremental", "gradual", "gradually", "build", "practice", "ladder", "level", "advance", "slowly", "daily", "consistent", "routine"],
  },
  bookletters: {
    shows: "an open book releasing a spiral of letters",
    use: "reading, learning, knowledge, words, ideas on the page, what the author says",
    words: ["book", "read", "reading", "page", "word", "words", "learn", "learning", "knowledge", "study", "write", "writing", "author", "text", "wisdom", "education", "chapter", "literature", "novel", "mind"],
  },
  chain: {
    shows: "a heavy chained weight that breaks free",
    use: "the past, burdens, being stuck, a trap, regret, resentment, limits, breaking free",
    words: ["past", "burden", "weight", "trap", "stuck", "bound", "chain", "regret", "guilt", "baggage", "limit", "limiting", "constraint", "anchor", "escape", "free", "shackle", "bitterness", "bitter", "resentment", "grudge", "prisoner", "heavy", "held"],
  },
  path: {
    shows: "a glowing road splitting into two paths",
    use: "a choice, a decision, direction, a journey, which way to go",
    words: ["choice", "choose", "decision", "decide", "direction", "journey", "path", "road", "crossroads", "option", "alternative", "route", "future", "lead", "navigate", "destination", "lost", "wander", "way"],
  },
  mountain: {
    shows: "a low-poly mountain with a beacon on the summit",
    use: "a hard challenge, a goal, ambition, an obstacle, effort, reaching the top",
    words: ["challenge", "goal", "summit", "obstacle", "difficult", "ambition", "achieve", "effort", "struggle", "peak", "overcome", "mountain", "hurdle", "ascent", "endure", "perseverance", "hard", "reach", "climb"],
  },
  spark: {
    shows: "a light bulb igniting with rays and sparks",
    use: "an idea, an insight, a discovery, a solution, the moment something clicks",
    words: ["idea", "insight", "realize", "realise", "discover", "discovery", "solution", "answer", "secret", "key", "breakthrough", "invent", "creative", "creativity", "curious", "understand", "inspiration", "light", "clue", "notice"],
  },
  scales: {
    shows: "a balance scale tipping to one side",
    use: "weighing, balance, a trade-off, cost versus benefit, fairness, comparing two things",
    words: ["balance", "weigh", "tradeoff", "trade-off", "fair", "fairness", "cost", "benefit", "compare", "comparison", "judge", "justice", "versus", "equal", "price", "value", "worth", "measure", "pros", "cons", "either", "both"],
  },
  network: {
    shows: "a web of glowing connected nodes",
    use: "relationships, people, community, connection, a system of linked parts",
    words: ["connection", "connect", "relationship", "people", "friend", "friends", "family", "community", "network", "society", "together", "team", "social", "others", "colleagues", "links", "ecosystem", "culture", "everyone", "someone"],
  },
  pulse: {
    shows: "a pulsing core sending out rings and waves",
    use: "emotion, anger, fear, anxiety, excitement, energy, a feeling spreading",
    words: ["emotion", "feeling", "feel", "anger", "angry", "fear", "anxiety", "stress", "energy", "excite", "excited", "excitement", "enthusiasm", "passion", "mood", "heart", "rhythm", "noise", "tension", "calm", "restless", "temper", "furious", "cross"],
  },
  focus: {
    shows: "rings converging on one bright point",
    use: "attention, focus, clarity, distraction, priorities, filtering out noise",
    words: ["focus", "attention", "attend", "distraction", "distracted", "clarity", "concentrate", "priority", "priorities", "filter", "ignore", "narrow", "essential", "mindful", "awareness", "matters", "important", "single", "one"],
  },
  growth: {
    shows: "a spiral of spheres that grow larger and larger",
    use: "compounding, accumulation, small gains piling up, investing, a snowball effect",
    words: ["grow", "growth", "compound", "compounding", "accumulate", "snowball", "invest", "investment", "savings", "interest", "exponential", "multiply", "expand", "increase", "rise", "gains", "momentum", "wealth", "money"],
  },
  orb: {
    shows: "a glowing orb with rings and a swirl of light",
    use: "ONLY when no other object fits — a generic cinematic backdrop",
    words: [],
  },
};

/** Every non-fallback hero, in the catalogue's own order (which breaks ties). */
const SPECIFIC = HERO_IDS.filter((h) => h !== "orb");

function stem(w: string): string {
  return w.replace(/(ing|edly|ed|es|s)$/, "");
}

/** How well a text matches each hero: matched-word counts, with a tiny bonus for rarer words. */
export function heroScores(text: string): Record<HeroId, number> {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  const set = new Set(tokens);
  const stems = new Set(tokens.map(stem));
  const out = {} as Record<HeroId, number>;
  for (const id of HERO_IDS) {
    let score = 0;
    for (const w of HERO_GUIDE[id].words) {
      const k = normalizeToken(w);
      if (set.has(k) || stems.has(stem(k))) score += 1;
    }
    out[id] = score;
  }
  return out;
}

/** How strongly a text matches its best SPECIFIC hero (0 when only the orb would do). */
export function heroMatch(text: string): number {
  const scores = heroScores(text);
  return Math.max(0, ...SPECIFIC.map((id) => scores[id]));
}

/**
 * The best hero for a stretch of narration by KEYWORD COUNT, or "orb" when
 * nothing matches. `avoid` lists heroes already used, which are skipped while a
 * different one also matches — repetition is the thing the cinematic opening
 * exists to avoid.
 *
 * Measured on 82 real scenes this scored 0 on 12% (the generic orb) and 1, a
 * single incidental word, on 67%. It is the floor under `heroRanker`, not the
 * first choice: used only where no ranker was supplied.
 */
export function heroForTextSync(text: string, avoid: readonly HeroId[] = []): HeroId {
  const scores = heroScores(text);
  const ranked = SPECIFIC.map((id, order) => ({ id, s: scores[id], order }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.order - b.order);
  if (ranked.length === 0) return "orb";
  const fresh = ranked.find((r) => !avoid.includes(r.id));
  return (fresh ?? ranked[0]).id;
}

/**
 * What a hero means, as the two kinds of text it can be asked about. A hero is
 * compared on the better of them.
 *
 *   - what it SHOWS: the director's `concept` for a scene describes a picture
 *     ("a barrier blocking a path"), which is what `shows` is written in.
 *   - what it is FOR: narration states an idea, which is what `use` and `words`
 *     are written in.
 *
 * One blended description of all three was measured worse than either on its own
 * material. On 56 hand-labelled narration-only sentences (none containing a
 * catalogue word) the blend ranked the right hero first 26 times, these two
 * separate descriptions 36, and the keyword matcher 6.
 */
function heroDescriptions(id: HeroId): string[] {
  const g = HERO_GUIDE[id];
  return [g.shows, `${g.use}. ${g.words.join(", ")}`];
}

/** Longer than any scene's narration needs to be; bounds the work and the cache key. */
const MAX_TEXT_CHARS = 1000;

/** By id, not identity: the same module can be loaded twice (ESM and CJS) and book analysis compares ids too. */
const isLexical = (e: Embedder) => e.id === lexicalEmbedder.id;

export interface HeroRanker {
  /**
   * The hero whose meaning best fits `text`, skipping those in `avoid` while any
   * other still fits (when all are used the best pick repeats rather than
   * failing). Always resolves to a real hero. A text the ranker has not seen is
   * embedded on the spot, so there is no way to ask about a string and quietly
   * get keyword matching instead.
   */
  pick(text: string, avoid?: readonly HeroId[]): Promise<HeroId>;
  /** Cosine similarity of the best match, 0..1 — how well the catalogue actually fits. */
  score(text: string): Promise<number>;
  /** Which embedder is doing the ranking right now. Becomes "lexical" if the model fails mid-plan. */
  readonly source: "embedding" | "lexical";
  /** Why the semantic model was not used, when it was not (null when it ran, or when lexical was asked for). */
  readonly degradedBecause: string | null;
}

interface RankedHeroes {
  /** Specific heroes, best first. Empty when nothing fits at all. */
  ranked: HeroId[];
  best: number;
}

/**
 * Rank heroes by MEANING rather than by keyword count.
 *
 * Measured on 82 real scenes, the keyword matcher scored 0 on 12% (which then
 * fell to the generic `orb`) and 1 — a single incidental word — on 67%. The
 * catalogue states what each hero is for in prose; comparing that prose to the
 * narration uses the information the keyword list throws away.
 *
 * `pick` and `score` are async, so a text is embedded when it is asked about
 * (once: answers are cached) and every caller awaits a real answer. The hero
 * descriptions are embedded here, once per plan. Used by the scene planner,
 * never at render time.
 *
 * Degradation never fails a plan. With no cached model and no network the
 * ranker is built on `lexicalEmbedder` (bag of words, never unavailable); if
 * the model dies after loading, the ranker switches to it from then on. Either
 * way `source` and `degradedBecause` say so, so the plan can record it.
 */
export async function heroRanker(embedder: Embedder = transformersEmbedder): Promise<HeroRanker> {
  const descriptions = SPECIFIC.flatMap(heroDescriptions);
  const perHero = descriptions.length / SPECIFIC.length;

  async function embedAll(e: Embedder, texts: string[]): Promise<Float32Array[]> {
    const vectors = await e.embed(texts);
    if (vectors.length !== texts.length) throw new Error(`${e.id} returned ${vectors.length} vectors for ${texts.length} texts`);
    return vectors;
  }

  // One consistent snapshot of "the embedder in use, its hero vectors, and the
  // answers computed with them", replaced whole on degradation so a question
  // already in flight can never mix vectors from two different embedders.
  interface State {
    embedder: Embedder;
    /** `perHero` consecutive vectors per specific hero, in catalogue order. */
    vectors: Float32Array[];
    cache: Map<string, RankedHeroes>;
  }
  let degradedBecause: string | null = null;
  let state: State;
  try {
    state = { embedder, vectors: await embedAll(embedder, descriptions), cache: new Map() };
  } catch (err) {
    degradedBecause = err instanceof Error ? err.message : String(err);
    state = { embedder: lexicalEmbedder, vectors: await lexicalEmbedder.embed(descriptions), cache: new Map() };
  }

  async function degrade(from: State, err: unknown): Promise<State> {
    if (state === from) {
      degradedBecause = err instanceof Error ? err.message : String(err);
      state = { embedder: lexicalEmbedder, vectors: await lexicalEmbedder.embed(descriptions), cache: new Map() };
    }
    return state;
  }

  async function rank(text: string): Promise<RankedHeroes> {
    const key = text.trim().slice(0, MAX_TEXT_CHARS);
    if (!key) return { ranked: [], best: 0 };
    let st = state;
    const hit = st.cache.get(key);
    if (hit) return hit;
    let query: Float32Array;
    try {
      query = (await embedAll(st.embedder, [key]))[0];
    } catch (err) {
      if (isLexical(st.embedder)) throw err; // pure code: cannot fail, and must not loop if it ever did
      st = await degrade(st, err);
      query = (await lexicalEmbedder.embed([key]))[0];
    }
    const scored = SPECIFIC.map((id, order) => ({
      id,
      order,
      s: Math.max(...st.vectors.slice(order * perHero, (order + 1) * perHero).map((v) => cosine(query, v))),
    })).sort((a, b) => b.s - a.s || a.order - b.order);
    const best = scored[0]?.s ?? 0;
    // Nothing in common at all (a blank vector, or only words no hero mentions) is the one case the generic backdrop is for.
    const out: RankedHeroes = { ranked: best > 0 ? scored.map((x) => x.id) : [], best: Math.max(0, best) };
    st.cache.set(key, out);
    return out;
  }

  return {
    get source() {
      return isLexical(state.embedder) ? "lexical" : "embedding";
    },
    get degradedBecause() {
      return degradedBecause;
    },
    async pick(text, avoid = []) {
      const { ranked } = await rank(text);
      return ranked.find((id) => !avoid.includes(id)) ?? ranked[0] ?? "orb";
    },
    async score(text) {
      return (await rank(text)).best;
    },
  };
}

/** The catalogue as the director's prompt prints it. */
export function heroCatalogue(): string {
  return HERO_IDS.map((id) => `- ${id} — ${HERO_GUIDE[id].shows}. Use for: ${HERO_GUIDE[id].use}.`).join("\n");
}
