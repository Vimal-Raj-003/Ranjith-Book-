/**
 * Which book theme a video gets, chosen from what the video is ABOUT.
 *
 * The measured defect. The theme used to come from one global operator setting
 * with a fixed default (`getSetting("theme")` ?? `marginalia`), read once per
 * call and stamped on every episode that call created. Across the last 40 real
 * episodes that produced marginalia 16, editorial 20, spotlight 3, terminal 1,
 * blueprint 0 — a distribution that tracks WHEN THE OPERATOR LAST TOUCHED THE
 * SETTING and nothing about the books. Four episodes on four unrelated subjects
 * rendered identically because all four were marginalia. Five themes exist so
 * that two videos do not look like the same video; a single global switch spends
 * that work on nothing.
 *
 * What this file does instead: give each theme a short brief of the kind of IDEA
 * it suits, and match the episode's own text against those briefs. Same text in,
 * same theme out, forever — there is no randomness here and there must not be.
 * A random theme would be indefensible for the same reason the global setting is
 * indefensible: the look would carry no information about the video, and worse,
 * it could not be reproduced when an operator asks why a video looks like that.
 *
 * This is deliberately a copy, in shape and in style, of
 * `src/lib/video/scenes/heroes.ts`, which solves the identical problem for the
 * cinematic hero catalogue: a `use`/`words` guide per id, a keyword floor that
 * always answers, and an async ranker over the same sentence embedder book
 * analysis uses, degrading to the floor when the model is not there. Read that
 * file before changing this one; the reasoning for the embedding setup (one
 * vector per id, one text per `embed` call, the result cache) is written out
 * there at length and is not repeated here.
 *
 * One difference from heroes.ts worth stating, because it is why there is no
 * score threshold here. The hero catalogue has a legitimate "nothing fits"
 * answer — the generic `orb` — so it can afford a floor below which it declines
 * to choose. A video has to render in SOME theme, and every theme is a legal
 * answer for any text, so declining is not available. The only case handled
 * specially is "no signal at all" (see `spread`).
 *
 * Runs when an episode row is CREATED, never at render time: the chosen id is
 * stamped on the episode and that stamp stays authoritative. Changing the words
 * below re-aims future episodes and must not re-skin an existing one.
 */
import { normalizeToken } from "../../../ingest/align";
import { cosine, lexicalEmbedder, transformersEmbedder, type Embedder } from "../../../analysis/embed";
import { BOOK_THEME_IDS, type BookThemeId } from "./index";

/**
 * What kind of idea each theme is for, and the words that go with it.
 *
 * Written from each theme file's own doc comment, translated from pixels into
 * subject matter — a ranker cannot use "phosphor teal" but it can use "code".
 * The source sentences, in order: marginalia is "the page as a student's copy:
 * warm paper, a felt-tip yellow, annotations in the margin" on a warm desk;
 * terminal is "the page as something on a screen at 2am: deep graphite,
 * phosphor teal, monospace everywhere", a dark editor; editorial is "the page
 * as a magazine feature: ecru press sheet, masthead rule, an editor's pencil",
 * the one light ground in the set; spotlight is "the page under a stage light:
 * near-black, one hot accent, a beam", the loudest, built to stop a thumb;
 * blueprint is "the page as a drawing on a drafting table: deep indigo, a
 * two-scale grid, registration marks", the quietest, calm and technical.
 *
 * Write these for a sentence-similarity model, not for a reader, and keep the
 * five SEPARABLE. Overlapping word lists are the failure mode that matters:
 * commit 94d5ccc exists because the hero lists had grown broad enough that
 * neighbours stole each other's sentences, and with only five ids here a single
 * shared word is a much larger fraction of the signal. So every word below has
 * exactly one owner, chosen by which theme the subject really belongs to:
 * "engineer" is the blueprint's (a drawing on a drafting table) and not the
 * terminal's, whose claim is specifically computing; "data" is the terminal's
 * (digital) and "evidence", "experiment", "research" the blueprint's; "reading"
 * is marginalia's (studying a book) and editorial takes the cultural vocabulary
 * — "story", "society", "journalism" — instead.
 *
 * Two lists are deliberately NOT here: there is no entry for a generic or
 * neutral theme, because none of the five is neutral, and no visual vocabulary,
 * because what a theme looks like is in the theme file and a narrator never
 * says it.
 *
 * Unverified: unlike the hero guide there is no labelled sample behind these
 * words, and no benchmark. They were written from the theme doc comments and
 * checked against the handful of idea texts in `tests/themes-choose.test.mts`
 * and `scripts/theme-choose-demo.mjs` only. Treat the separation as asserted,
 * not measured; a labelled set of real idea texts is what would settle it.
 */
export const THEME_GUIDE: Record<BookThemeId, { use: string; words: string[] }> = {
  marginalia: {
    use: "studying something for yourself: a book read slowly, a lesson taken to heart, a passage underlined, notes kept in the margin, the private patient work of paying attention",
    words: [
      "study", "student", "learn", "lesson", "teach", "teacher", "school", "class",
      "textbook", "notebook", "notes", "annotate", "margin", "underline", "homework",
      "reading", "reader", "memorise", "revision", "practice",
    ],
  },
  terminal: {
    use: "software and machines: code, computers, the internet, data, automation, and the kind of work done alone at a keyboard late at night",
    words: [
      "code", "coding", "software", "program", "programming", "computer", "machine",
      "algorithm", "data", "digital", "internet", "screen", "keyboard", "debug",
      "server", "database", "automation", "robot", "technology", "developer",
    ],
  },
  editorial: {
    use: "people and the culture they live in: a reported story, a profile, an argument about society, history, politics or art — the long magazine piece",
    words: [
      "story", "culture", "society", "social", "magazine", "journalist", "journalism",
      "essay", "interview", "reporter", "history", "historical", "politics", "art",
      "artist", "fashion", "city", "public", "generation", "conversation",
    ],
  },
  spotlight: {
    use: "ambition and performance in front of an audience: money, business, selling, competition, winning, fame, risk — the loud urgent push to get somewhere",
    words: [
      "win", "winner", "success", "ambition", "money", "wealth", "sell", "pitch",
      "business", "market", "deal", "compete", "competition", "champion", "audience",
      "stage", "fame", "power", "risk", "hustle",
    ],
  },
  blueprint: {
    use: "how something is made and proved: design, architecture, engineering, a method followed exactly, measurement, research, evidence, a system drawn out part by part",
    words: [
      "design", "architecture", "engineer", "schematic", "blueprint", "plan",
      "structure", "system", "method", "process", "measure", "measurement",
      "precision", "science", "scientific", "research", "experiment", "evidence",
      "framework", "diagram",
    ],
  },

  /* --- the six added with the theme engine (2026-10-05) -------------------
   *
   * Same discipline as the five above and for the same reason, only harder:
   * with eleven ids a shared word is a smaller fraction of the signal than it
   * was with five, but there are 55 pairs to keep apart instead of 10, so the
   * chance of an accidental collision is five times higher. Every word below
   * was checked against all 100 already claimed —
   * `tests/theme-choice.test.mts` fails the moment two lists claim one word.
   *
   * Two words were deliberately dropped during that check rather than
   * reassigned: "once" and "home", both wanted by Vintage Storybook. They are
   * common enough to appear in prose about anything, so they would have pulled
   * unrelated episodes toward it — the exact failure the separability rule
   * exists to prevent, arriving through a word nobody would suspect.
   *
   * Unverified, same as the five above: written from the theme doc comments,
   * with no labelled sample behind them.
   */
  academia: {
    use: "thinking about how to live, read slowly and argued over for centuries: philosophy, the classics, virtue, meaning, mortality, the scholarly life",
    words: [
      "philosophy", "philosopher", "wisdom", "virtue", "stoic", "meaning", "soul",
      "mortality", "ancient", "classical", "scholar", "library", "manuscript",
      "translation", "latin", "greek", "meditation", "contemplation", "truth", "ethics",
    ],
  },
  atelier: {
    use: "taste and the made object: luxury, craft, materials, aesthetics, collecting, the discipline of doing one thing exquisitely well",
    words: [
      "luxury", "elegance", "craft", "craftsman", "atelier", "couture", "aesthetic",
      "beauty", "taste", "refinement", "detail", "material", "texture", "minimal",
      "brand", "gallery", "curator", "collector", "heritage", "exquisite",
    ],
  },
  dossier: {
    use: "finding out what actually happened: reporting from a place, an investigation, archives, witnesses, a war, a crisis, a journey taken to see for yourself",
    words: [
      "report", "investigation", "document", "archive", "witness", "testimony",
      "field", "location", "footage", "inquiry", "case", "record", "source",
      "fact", "verify", "expedition", "journey", "war", "crisis", "survivor",
    ],
  },
  quiet: {
    use: "doing less on purpose: simplicity, clarity, focus, stillness, restraint, the quiet daily discipline of keeping attention on one thing",
    words: [
      "simplicity", "simple", "clarity", "clear", "focus", "essential", "minimalism",
      "declutter", "calm", "stillness", "silence", "space", "restraint", "sparse",
      "slow", "intentional", "habit", "routine", "discipline", "attention",
    ],
  },
  storybook: {
    use: "a tale told to someone: fables, myths, folklore, childhood, a village long ago, a remembered family, the things a narrator says out loud",
    words: [
      "fable", "fairy", "myth", "legend", "folklore", "childhood", "child",
      "grandmother", "village", "forest", "adventure", "cottage", "bedtime",
      "illustration", "nostalgia", "memory", "memoir", "lullaby", "orphan", "tale",
    ],
  },
  neon: {
    use: "what is coming next: artificial intelligence, the virtual, invention, the companies and breakthroughs racing to build the future",
    words: [
      "future", "futuristic", "artificial", "intelligence", "neural", "network",
      "cyber", "virtual", "simulation", "orbit", "quantum", "invention",
      "innovation", "startup", "disrupt", "accelerate", "transform", "tomorrow",
      "frontier", "breakthrough",
    ],
  },
};

/** The ids in the registry's own order, which is what breaks a scoring tie. */
const THEME_IDS: readonly BookThemeId[] = BOOK_THEME_IDS;

/** The same crude suffix strip `heroes.ts` uses, so "studies" matches "study". */
function stem(w: string): string {
  return w.replace(/(ing|edly|ed|es|s)$/, "");
}

/** How many of each theme's words a text uses — the keyword floor's whole signal. */
export function themeScores(text: string): Record<BookThemeId, number> {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  const set = new Set(tokens);
  const stems = new Set(tokens.map(stem));
  const out = {} as Record<BookThemeId, number>;
  for (const id of THEME_IDS) {
    let score = 0;
    for (const w of THEME_GUIDE[id].words) {
      const k = normalizeToken(w);
      if (set.has(k) || stems.has(stem(k))) score += 1;
    }
    out[id] = score;
  }
  return out;
}

/**
 * The last resort: a theme derived from the text's own bytes when the text uses
 * none of the catalogue's words at all.
 *
 * This is the one place where the answer carries no meaning, and it is here
 * because the alternative is strictly worse. With no match, a ranked list falls
 * back on the tie-break — registry order — and every unmatched episode in the
 * product becomes `marginalia`. That IS the defect this file was written to fix,
 * reintroduced through the back door, and it would hit exactly the ideas whose
 * wording the guide does not cover yet. Spreading them over the five instead
 * keeps the product promise ("different videos look different") even where the
 * stronger promise ("the look follows the meaning") cannot be kept.
 *
 * It is not random: FNV-1a over the normalised tokens is a pure function of the
 * words, so one idea has one theme for as long as its text is unchanged, and a
 * second run reproduces the first exactly. It is also not a secret fallback —
 * `themeScores` is exported, so a caller that wants to know whether a theme was
 * matched or merely spread can see a row of zeroes for itself.
 */
function spread(text: string): BookThemeId {
  let h = 2166136261;
  for (const raw of text.toLowerCase().split(/\s+/)) {
    const w = normalizeToken(raw);
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
  }
  return THEME_IDS[(h >>> 0) % THEME_IDS.length];
}

/**
 * The theme for a text by KEYWORD COUNT. Total: every string gets a theme, and
 * the same string always gets the same one.
 *
 * This is the floor under `themeRanker`, and it IS what a degraded `themeRanker`
 * becomes (see there). It is also what the interactive episode-creation path
 * uses on its own, because it needs no model, no cache directory and no network
 * — see `createIdeaEpisodes`.
 *
 * Ties go to registry order, which only matters between two themes a text
 * matches equally often; a text that matches NOTHING goes to `spread` instead,
 * for the reason written there.
 */
export function themeForTextSync(text: string): BookThemeId {
  return themeTop(text, 1)[0];
}

/**
 * The best `n` themes for a text, best first — what the inspector shows as a
 * suggestion beside the picker, and the pipeline the single-answer
 * `themeForTextSync` above is now a one-line call into.
 *
 * It is written this way round on purpose. The suggestion list and the theme an
 * episode is actually stamped with MUST come from one ranking, and the cheapest
 * way to guarantee that is for there to be exactly one: a second copy of the
 * scoring, the `> 0` filter, the sort and the `spread` fallback would agree
 * today and drift the first time one of the four was touched, and the symptom
 * would be a panel telling the operator Auto picks a theme that Auto does not
 * pick. `tests/theme-choice.test.mts` holds the two to agreement as well, which
 * is belt and braces for a thing that is worth both.
 *
 * Note what this does NOT promise. It is the ranking for the TEXT it is given.
 * Two callers passing different text about the same episode will legitimately
 * get different answers — `runIngest` ranks a planned part's title, chapter
 * heading and opening prose; `createIdeaEpisodes` ranks an idea brief; the
 * inspector's endpoint ranks the finished row's title, hook and script. Only
 * the last of those exists at the moment the panel is looked at. So the panel's
 * copy says what it ranked rather than claiming to reproduce a decision that
 * was made earlier from other words.
 *
 * Returns fewer than `n` entries only when the text matches fewer than `n`
 * themes at all, which is the honest answer: padding the list with themes the
 * text scored zero against would present registry order as a recommendation,
 * and registry order is the defect this whole file exists to fix.
 */
export function themeTop(text: string, n = 3): BookThemeId[] {
  const scores = themeScores(text);
  const ranked = THEME_IDS.map((id, order) => ({ id, s: scores[id], order }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.order - b.order);
  if (ranked.length === 0) return [spread(text)];
  return ranked.slice(0, Math.max(1, n)).map((r) => r.id);
}

/**
 * What a theme means, as the one text the episode's words are compared against:
 * what it is FOR plus the words that go with it. Exactly `heroDescription`'s
 * formula, for the reasons set out there — in particular that the ranker embeds
 * one text per call, so a comparison made in a single batch measures something
 * else.
 */
function themeDescription(id: BookThemeId): string {
  const g = THEME_GUIDE[id];
  return `${g.use}. ${g.words.join(", ")}`;
}

/** Longer than any idea brief needs to be; bounds the work and the cache key. */
const MAX_TEXT_CHARS = 1000;

/** By id, not identity: the same module can be loaded twice (ESM and CJS). */
const isLexical = (e: Embedder) => e.id === lexicalEmbedder.id;

export interface ThemeRanker {
  /**
   * The theme whose brief best fits `text`. Always resolves to a real id.
   *
   * With `source` "embedding" that is the highest cosine, except when the text
   * has no measurable similarity to any brief at all (best cosine at or below
   * zero), where it hands over to `themeForTextSync` rather than let the
   * tie-break hand every such text to the first theme in the registry.
   *
   * With `source` "lexical" (degraded) this is exactly `themeForTextSync(text)`.
   */
  pick(text: string): Promise<BookThemeId>;
  /**
   * "embedding": ranking by meaning. "lexical": the degraded mode, counting
   * keywords. Becomes "lexical" if the model fails after loading.
   */
  readonly source: "embedding" | "lexical";
  /** Why the model was not used, when it was not (null when it ran, or when lexical was asked for). */
  readonly degradedBecause: string | null;
}

/**
 * Rank themes by MEANING rather than by keyword count.
 *
 * The keyword floor can only see words the guide happens to list, and an idea
 * brief is three or four sentences — short enough that it often lists none of
 * them, which is how `spread` gets used at all. The briefs state what each
 * theme is for in prose; comparing that prose to the idea uses the information
 * the word lists throw away, and it is the difference between "this book is
 * about shipping software" matching `terminal` because it said "software" and
 * matching it because of what the sentence means.
 *
 * Degradation never fails a run and never leaves it worse than the floor. With
 * no cached model and no network, or when the lexical embedder is asked for, or
 * if the model dies after loading, this ranker IS `themeForTextSync` from then
 * on. The bag-of-words embedder is not used for ranking here for the same
 * reason heroes.ts does not use it: it ranked below the keyword matcher it
 * would replace.
 *
 * `pick` is async so the text is embedded when it is asked about, once —
 * answers are cached per ranker, which matters because one upload asks about
 * several episodes in a row.
 */
export async function themeRanker(embedder: Embedder = transformersEmbedder): Promise<ThemeRanker> {
  async function embedAll(e: Embedder, texts: string[]): Promise<Float32Array[]> {
    const vectors = await e.embed(texts);
    if (vectors.length !== texts.length) throw new Error(`${e.id} returned ${vectors.length} vectors for ${texts.length} texts`);
    return vectors;
  }

  // Either semantic (the embedder, its theme vectors, and the answers computed
  // with them) or degraded to keywords, which needs no data. Replaced whole on
  // degradation, so a question in flight never mixes the two matchers.
  type State =
    | { mode: "semantic"; embedder: Embedder; vectors: Float32Array[]; cache: Map<string, BookThemeId> }
    | { mode: "keyword" };
  const KEYWORD: State = { mode: "keyword" };
  let degradedBecause: string | null = null;
  let state: State = KEYWORD;
  if (!isLexical(embedder)) {
    try {
      // One vector per theme, in registry order.
      state = { mode: "semantic", embedder, vectors: await embedAll(embedder, THEME_IDS.map(themeDescription)), cache: new Map() };
    } catch (err) {
      degradedBecause = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    get source() {
      return state.mode === "semantic" ? "embedding" : "lexical";
    },
    get degradedBecause() {
      return degradedBecause;
    },
    async pick(text) {
      const st = state;
      if (st.mode === "keyword") return themeForTextSync(text);
      const key = text.trim().slice(0, MAX_TEXT_CHARS);
      if (!key) return themeForTextSync(text);
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
        return themeForTextSync(text);
      }
      const scored = THEME_IDS.map((id, order) => ({ id, order, s: cosine(query, st.vectors[order]) })).sort((a, b) => b.s - a.s || a.order - b.order);
      // No similarity to any brief is not a tie to be broken by registry order:
      // that is how every such text would become the first theme in the list.
      if ((scored[0]?.s ?? 0) <= 0) return themeForTextSync(text);
      st.cache.set(key, scored[0].id);
      return scored[0].id;
    },
  };
}
