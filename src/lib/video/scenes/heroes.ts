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
 * Purely lexical, like `emphasis.ts` and `three-shapes.ts`: no model call, no
 * network, the same text mapped to the same hero on every run.
 */
import { normalizeToken } from "../../ingest/align";

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
 * The best hero for a stretch of narration, or "orb" when nothing matches.
 * `avoid` lists heroes already used, which are skipped while a different one
 * also matches — repetition is the thing the cinematic opening exists to avoid.
 */
export function heroForText(text: string, avoid: readonly HeroId[] = []): HeroId {
  const scores = heroScores(text);
  const ranked = SPECIFIC.map((id, order) => ({ id, s: scores[id], order }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.order - b.order);
  if (ranked.length === 0) return "orb";
  const fresh = ranked.find((r) => !avoid.includes(r.id));
  return (fresh ?? ranked[0]).id;
}

/** The catalogue as the director's prompt prints it. */
export function heroCatalogue(): string {
  return HERO_IDS.map((id) => `- ${id} — ${HERO_GUIDE[id].shows}. Use for: ${HERO_GUIDE[id].use}.`).join("\n");
}
