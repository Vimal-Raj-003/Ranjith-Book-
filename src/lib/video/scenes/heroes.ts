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
 * as the floor, and what a degraded `heroRanker` is: purely lexical like
 * `emphasis.ts` and `three-shapes.ts`, no model call, no network, the same text
 * mapped to the same hero on every run.
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
  "mind",
  "storm",
  "rest",
  "dialogue",
  "wall",
  "heart",
  "loop",
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
    use: "small steps, gradual progress, practice, improving over time",
    words: ["step", "steps", "progress", "improve", "improvement", "incremental", "gradual", "gradually", "build", "practice", "ladder", "level", "advance", "slowly", "daily", "consistent"],
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
    use: "emotion, excitement, energy: a feeling or mood spreading from one person to another",
    words: ["emotion", "feeling", "feel", "energy", "excite", "excited", "excitement", "enthusiasm", "passion", "mood", "rhythm", "noise", "tension", "restless"],
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
  mind: {
    shows: "a glass head in profile, scanned in slices, with a web of thoughts firing inside it",
    use: "memory and the mind: remembering, forgetting, thoughts, what goes on inside your head",
    words: ["mind", "brain", "skull", "memory", "remember", "forget", "forgot", "recall", "thought", "thinking", "mental", "imagination", "consciousness"],
  },
  storm: {
    shows: "a dark churning storm cloud lit from inside by flashes of lightning",
    use: "a storm of fear, anger and stress: panic, dread, turmoil, everything falling apart",
    words: ["fear", "afraid", "anger", "angry", "rage", "stress", "anxiety", "panic", "turmoil", "storm", "chaos", "worry", "dread", "fury", "terror"],
  },
  rest: {
    shows: "a still lake under a slowly rising moon, everything at rest",
    use: "sleep, rest, recovery, stillness: a good night's sleep, switching off, doing nothing on purpose while the body repairs itself",
    words: ["sleep", "rest", "recover", "recovery", "stillness", "calm", "quiet", "pause", "breathe", "relax", "peace", "repair"],
  },
  dialogue: {
    shows: "two glowing forms facing each other, trading light back and forth",
    use: "a conversation: talking, listening, asking, answering, understanding each other",
    words: ["conversation", "talk", "talking", "speak", "listen", "listening", "dialogue", "discuss", "argue", "communicate", "communication", "reply"],
  },
  wall: {
    shows: "a tall brick wall that cracks and gives way under pressure, light breaking through",
    use: "an obstacle in your way: a wall, a locked door, resistance that pushes back and will not give",
    words: ["wall", "barrier", "obstacle", "blocked", "resistance", "resist", "boundary", "refuse", "impossible", "impediment"],
  },
  heart: {
    shows: "a glowing beating heart with a pulse line running through it",
    use: "your body and your health: the heart, the heartbeat, exercise, diet, medicine, staying fit",
    words: ["heart", "heartbeat", "body", "health", "healthy", "exercise", "fitness", "diet", "vitality", "blood", "disease", "medicine", "doctor", "lungs"],
  },
  loop: {
    shows: "a closed ring of glowing spheres chasing each other around the same circuit forever",
    use: "habit and repetition: doing the same thing on autopilot, the cycle you repeat without noticing, stuck going round and round",
    words: ["habit", "habits", "repeat", "repetition", "repeating", "cycle", "loop", "autopilot", "unconscious", "mindless", "rut", "ritual", "trigger"],
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
 * first choice: it is used where no ranker was supplied, and it IS what a
 * degraded `heroRanker` becomes (see there).
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
 * What a hero means, as the one text its narration is compared against: what it
 * is FOR (`use`) and the words that go with it (`words`), the prose the catalogue
 * already states its ideas in. `shows` (the picture) is deliberately left out.
 *
 * Write `use` and `words` for a sentence-similarity model, not for a reader: the
 * kind of idea the object stands for, in the vocabulary a narrator really uses.
 * A broad list attracts sentences that belong to a neighbour (an early habit list
 * took "Procrastination steals what you cannot earn back" from the hourglass), and
 * one word can do it ("circle" took "Your circle quietly shapes who you turn into"
 * from the network, and was dropped). The list is also the keyword matcher's, so
 * keep to words a narrator says about THIS idea and not about the next one, and
 * give a shared word exactly one owner: "routine" is the clock's (the day's
 * structure), "habit" and "habits" the loop's (what you repeat without noticing).
 *
 * How this was chosen, and what that does and does not show. `scripts/hero-bench.mjs`
 * over `tests/fixtures/hero-labels.json` compared descriptions of a hero. The
 * sentences were written and labelled by this code's author, the first 56
 * deliberately without the catalogue's keywords (so the keyword matcher is
 * handicapped by construction), and the formula was picked, and the seven newest
 * heroes' descriptions tuned, on the same set (so any gain is in-sample). It
 * supports the direction (embedding ranks a paraphrase the keyword list cannot
 * see) and nothing about magnitude: it is not an accuracy figure and not evidence
 * of a real-world improvement. The `heldOut` sentences were not tuned against but
 * are not independent either (same author, same vocabulary). The nearest thing to
 * independent evidence is `tests/fixtures/real-scenes.json`: real narration with
 * hand-labelled accepted heroes, which the bench reports separately.
 *
 * Within that, this single vector measured better than a blend of all three texts
 * and better than the best of two vectors (`shows`, and `use`+`words`), which was
 * shipped first. The earlier comparison favoured the two-vector form only because
 * it embedded every sentence in ONE batch. The ranker embeds ONE text at a time,
 * and the q8-quantised model's vectors move with batch composition. The hero
 * descriptions are one batch too, so rewording ONE hero shifts the others' vectors
 * a little: changing a few words of one description moved the top-1 total by up
 * to two of 84. Measure the way the ranker is called, one text per `embed`, or the
 * comparison is of something else, and read a difference of a point or two as
 * noise. The cost of leaving `shows` out is a director's picture-style `concept`
 * ("a barrier blocking a path") matches a hero less directly, which that set does
 * not contain. Re-run the bench when the catalogue changes.
 */
function heroDescription(id: HeroId): string {
  const g = HERO_GUIDE[id];
  return `${g.use}. ${g.words.join(", ")}`;
}

/** Longer than any scene's narration needs to be; bounds the work and the cache key. */
const MAX_TEXT_CHARS = 1000;

/**
 * Below this cosine similarity a hero is not an honest fit for a text, so it is
 * neither chosen outright (the generic `orb` is) nor allowed to displace a better
 * but already-used hero in a variety repair. Applies to the embedding source only:
 * a degraded ranker is the keyword matcher, whose own rule is "no keyword, no hero".
 *
 * Retuned for the 21-hero catalogue (`node --import tsx scripts/hero-bench.mjs`
 * prints both sweeps). On the author-labelled sample, 0.20 keeps 52 of the 53
 * sentences the embedder ranks right and sends 6 of its 31 wrong ones and 11 of
 * 16 off-topic ones to the orb; 0.22 would cost two more right ones for four more
 * bad ones, and 0.25 nine for seven. On the 84 real scenes (hand-labelled with the
 * heroes a viewer would accept) the sweep is flat from 0.20 to 0.22 (38 and 37
 * accepted, 29 and 26 wrong) and clearly worse at 0.25 (29 accepted), so the
 * independent evidence puts the knee at 0.20 to 0.22 too. Kept at 0.20: it is
 * the value this shipped with, and the generic orb is not free (at 0.22 a
 * further 4 of those 84 scenes lose their hero). Genuine fits and misses overlap
 * heavily (right answers score 0.17 to 0.56, wrong 0.16 to 0.50), so this is a
 * blunt floor that removes the weakest matches, not a classifier. It cannot remove
 * off-topic text that shares a word with a hero: "Follow for more" scores 0.28 on
 * the staircase and "Link in the description" 0.25 on the network, above any floor
 * that still keeps real matches. A new hero moves every score: re-run the sweeps.
 */
export const MIN_HERO_SCORE = 0.2;

/** By id, not identity: the same module can be loaded twice (ESM and CJS) and book analysis compares ids too. */
const isLexical = (e: Embedder) => e.id === lexicalEmbedder.id;

export interface HeroRanker {
  /**
   * The hero whose meaning best fits `text`, skipping those in `avoid` while any
   * other still FITS. When `source` is "embedding", in order of preference:
   *   1. the best hero not in `avoid` that scores at least `MIN_HERO_SCORE`;
   *   2. else the best hero overall that does, a repeat, so a text whose only good
   *      fits are all used repeats rather than failing;
   *   3. else `"orb"`: nothing in the catalogue fits.
   * So a result inside `avoid` (or `"orb"`) means "no fresh hero is a fair fit":
   * callers that must not repeat should decline the swap.
   *
   * When `source` is "lexical" (degraded) this is exactly `heroForTextSync(text,
   * avoid)`: see `heroRanker`.
   *
   * Always resolves to a real hero. A text the ranker has not seen is embedded on
   * the spot, so there is no way to ask about a string and quietly get a different
   * matcher than the ranker's `source` says.
   */
  pick(text: string, avoid?: readonly HeroId[]): Promise<HeroId>;
  /**
   * How well the catalogue fits `text`, in 0..1, for ordering candidates. "embedding":
   * the cosine of the best match. "lexical": the keyword hit count n squashed to
   * n / (n + 1), so 0 when nothing matches and a strictly higher score for more hits
   * (the order the keyword matcher itself uses). Comparable within a source only.
   */
  score(text: string): Promise<number>;
  /**
   * "embedding": ranking by meaning. "lexical": the degraded mode, matching words
   * against each hero's keyword list. Becomes "lexical" if the model fails mid-plan.
   */
  readonly source: "embedding" | "lexical";
  /** Why the semantic model was not used, when it was not (null when it ran, or when lexical was asked for). */
  readonly degradedBecause: string | null;
}

interface RankedHeroes {
  /** Specific heroes with their cosine, best first. Empty for blank text. */
  ranked: { id: HeroId; s: number }[];
  /** The best cosine (0 for blank text), whether or not it clears the floor. */
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
 * Degradation never fails a plan, and never leaves it worse off than before the
 * ranker existed. With no cached model and no network, or when the lexical
 * embedder is asked for, or if the model dies after loading, the ranker IS the
 * keyword matcher (`heroForTextSync`) from then on: no embedding at all. The
 * bag-of-words embedder was tried as the fallback and ranked below the keyword
 * matcher it replaced on the labelled sample (`scripts/hero-bench.mjs` prints
 * both), so it is not used for ranking. `source` and `degradedBecause`
 * say what happened, so the plan can record it; answers already given before a
 * mid-plan failure stay as they were.
 */
export async function heroRanker(embedder: Embedder = transformersEmbedder): Promise<HeroRanker> {
  const descriptions = SPECIFIC.map(heroDescription);

  async function embedAll(e: Embedder, texts: string[]): Promise<Float32Array[]> {
    const vectors = await e.embed(texts);
    if (vectors.length !== texts.length) throw new Error(`${e.id} returned ${vectors.length} vectors for ${texts.length} texts`);
    return vectors;
  }

  // Either semantic (the embedder, its hero vectors, and the answers computed with
  // them) or degraded to keywords, which needs no data. Replaced whole on
  // degradation, so a question in flight never mixes two matchers.
  type State =
    | { mode: "semantic"; embedder: Embedder; vectors: Float32Array[]; cache: Map<string, RankedHeroes> }
    | { mode: "keyword" };
  const KEYWORD: State = { mode: "keyword" };
  let degradedBecause: string | null = null;
  let state: State = KEYWORD;
  if (!isLexical(embedder)) {
    try {
      // One vector per specific hero, in catalogue order.
      state = { mode: "semantic", embedder, vectors: await embedAll(embedder, descriptions), cache: new Map() };
    } catch (err) {
      degradedBecause = err instanceof Error ? err.message : String(err);
    }
  }

  /** The ranking for `text`, or null when this ranker is (or has just become) the keyword matcher. */
  async function rank(text: string): Promise<RankedHeroes | null> {
    const st = state;
    if (st.mode === "keyword") return null;
    const key = text.trim().slice(0, MAX_TEXT_CHARS);
    if (!key) return { ranked: [], best: 0 };
    const hit = st.cache.get(key);
    if (hit) return hit;
    let query: Float32Array;
    try {
      query = (await embedAll(st.embedder, [key]))[0];
    } catch (err) {
      if (state === st) {
        degradedBecause = err instanceof Error ? err.message : String(err);
        state = KEYWORD;
      }
      return null;
    }
    const scored = SPECIFIC.map((id, order) => ({ id, order, s: cosine(query, st.vectors[order]) })).sort((a, b) => b.s - a.s || a.order - b.order);
    const out: RankedHeroes = { ranked: scored.map(({ id, s }) => ({ id, s })), best: Math.max(0, scored[0]?.s ?? 0) };
    st.cache.set(key, out);
    return out;
  }

  return {
    get source() {
      return state.mode === "semantic" ? "embedding" : "lexical";
    },
    get degradedBecause() {
      return degradedBecause;
    },
    async pick(text, avoid = []) {
      const ranked = await rank(text);
      if (!ranked) return heroForTextSync(text, avoid);
      const fits = ranked.ranked.filter((r) => r.s >= MIN_HERO_SCORE);
      return (fits.find((r) => !avoid.includes(r.id)) ?? fits[0])?.id ?? "orb";
    },
    async score(text) {
      const ranked = await rank(text);
      if (ranked) return ranked.best;
      const hits = heroMatch(text);
      return hits / (hits + 1);
    },
  };
}

/** The catalogue as the director's prompt prints it. */
export function heroCatalogue(): string {
  return HERO_IDS.map((id) => `- ${id} — ${HERO_GUIDE[id].shows}. Use for: ${HERO_GUIDE[id].use}.`).join("\n");
}
