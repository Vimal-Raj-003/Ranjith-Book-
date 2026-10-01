/**
 * Turning what the director asked for into what may actually be rendered.
 *
 * Nothing the model returns is trusted. Every template that can be WRONG about
 * the book is checked against the book:
 *
 *   quote  — the line must be found in the cited page words, by the same
 *            locator book analysis uses. What is rendered is then the book's
 *            own words, rebuilt from the page, never the model's copy of them.
 *   stat   — the number must appear in the source text.
 *   comparison / steps / timeline / growth-curve / icon-concept
 *          — every label must be grounded in what is actually said: its content
 *            words have to appear in the narration it sits under or in the page
 *            words that narration cites.
 *   book-crop — needs real geometry for the cited words; without it there is
 *            nothing to zoom to.
 *
 * Anything that fails falls back to `kinetic-text` of the sentence itself,
 * which is the narration and so cannot be irrelevant to it. Every fallback is
 * recorded in the returned notes, so a video that quietly lost its variety
 * says so instead of just looking plain.
 *
 * Two whole-video rules are enforced afterwards: no template three times in a
 * row, and at least `MIN_BOOK_SCENES` scenes showing the real page.
 */
import { normalizeToken } from "../../ingest/align";
import type { Box } from "../../ingest/ocr";
import type { Embedder } from "../../analysis/embed";
import { resolveIcon, MIN_SCORE } from "./icons";
import { emphasizeWords } from "./emphasis";
import { heroForText, heroMatch, isHeroId, type HeroId } from "./heroes";
import { BOOK_KINDS } from "./types";
import type { Scene, SceneIcon, ScenePlanReport, SceneSpec, SceneTone, Sentence, VisualKind } from "./types";

/**
 * The floor for a kinetic-text scene's optional accent icon — stricter than
 * `MIN_SCORE` (icons.ts), which gates a scene whose ONLY content is the icon
 * (icon-concept, comparison). This one is purely decorative, added beside
 * text that already stands on its own, so only a confident match is worth
 * the screen space; anything weaker is silently skipped, same as any other
 * icon lookup that finds nothing.
 */
const MIN_SCORE_ACCENT = MIN_SCORE + 0.1;

/** A video about a book shows the book at least this many times. */
export const MIN_BOOK_SCENES = 3;
/** The same template more than this many times in a row reads as a slideshow. */
export const MAX_RUN = 2;
/** Share of a label's content words that must appear in what is said. */
const GROUNDED_SHARE = 0.5;

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its of on or she so that the their them they this to was we were what when which who will with you your not can do does your our".split(
    " ",
  ),
);

const TONE_BY_KIND: Record<VisualKind, SceneTone> = {
  "book-page": "warm",
  "book-crop": "warm",
  quote: "warm",
  "kinetic-text": "deep",
  "icon-concept": "cool",
  comparison: "bright",
  steps: "cool",
  "growth-curve": "bright",
  timeline: "cool",
  stat: "deep",
  cinematic: "deep",
};

/**
 * Whole-video variety rules. A cinematic scene is the visual the product exists
 * to make; the others are supporting. A video of quote cards and book pages is
 * the slideshow this system replaced.
 */
export const CINEMATIC_SHARE = 0.4;
export const MAX_QUOTES = 2;
export const MAX_ICON_SCENES = 2;
export const MAX_HERO_USES = 2;

function contentWords(s: string): string[] {
  return s
    .split(/\s+/)
    .map(normalizeToken)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Is this label actually said? Its content words must appear in the narration
 * it sits under, or in the book words that narration cites — the two places a
 * label can honestly come from.
 */
export function groundedIn(label: string, haystacks: string[]): boolean {
  const words = contentWords(label);
  if (words.length === 0) return false;
  const hay = new Set(haystacks.flatMap((h) => contentWords(h)));
  // Stems, so "habits" matches "habit" and "compounds" matches "compound".
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
  const stems = new Set([...hay].map(stem));
  const hits = words.filter((w) => hay.has(w) || stems.has(stem(w))).length;
  return hits / words.length >= GROUNDED_SHARE;
}

/** Number words a narrator actually says, and the digits they stand for. */
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13",
  fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000", million: "1000000",
  half: "50", double: "2", twice: "2",
};

/**
 * Is this number actually stated? A narrator says "three degrees" where a stat
 * card reads "3", and both are the same fact — so the digits are matched
 * against the digits in the text AND against the number words spoken in it.
 * A card reading "87%" over narration that never mentions 87 still fails,
 * which is the case this exists to catch.
 */
export function numberIsSaid(digits: string, haystacks: string[]): boolean {
  for (const h of haystacks) {
    if (h.replace(/[^\d]/g, "").includes(digits)) return true;
    for (const raw of h.split(/\s+/)) {
      const word = normalizeToken(raw);
      if (word && NUMBER_WORDS[word] === digits) return true;
    }
  }
  return false;
}

export interface ValidateContext {
  sentences: Sentence[];
  /** Page index → that page's word list, the space beat indices address. */
  pageWords: Map<number, string[]>;
  /** The box covering a page's word range, in column pixels, or null. */
  cropFor(page: number, startWord: number, endWord: number): Box | null;
  /** Whether a page image exists to show at all. */
  hasPage(page: number): boolean;
  /** Locate a quote in a page's words. Returns the book's own words and where. */
  locate(page: number, quote: string): { text: string; startWord: number; endWord: number } | null;
  embedder?: Embedder;
  /** The script's hook line and its accent words: what the opening scene is about. */
  hook?: { text: string; keywords: string[] };
}

/** The narration and the book words a scene may draw its labels from. */
function haystacksFor(spec: { from: number; to: number }, ctx: ValidateContext): string[] {
  const out: string[] = [];
  for (let i = spec.from; i <= spec.to; i++) {
    const s = ctx.sentences[i];
    if (!s) continue;
    out.push(s.text);
    const words = ctx.pageWords.get(s.sourcePage);
    if (words) out.push(words.slice(s.startWord, s.endWord + 1).join(" "));
  }
  return out;
}

function sentenceWords(from: number, to: number, ctx: ValidateContext) {
  const out: { word: string; start: number; end: number }[] = [];
  for (let i = from; i <= to; i++) out.push(...(ctx.sentences[i]?.words ?? []));
  return out;
}

/** Lowercased, punctuation-free tokens of a text. */
function tokens(s: string): string[] {
  return s.split(/\s+/).map(normalizeToken).filter(Boolean);
}

/** The index in `hay` where `needle` occurs as a contiguous run of tokens, or -1. */
function runIndex(hay: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, k) => hay[i + k] === t)) return i;
  }
  return -1;
}

const KEYWORD_MAX_CHARS = 18;

/**
 * The words to set large. The director's own pick is used only if it really is a
 * run of words the narrator says (so type on screen can never claim anything the
 * voice did not); otherwise the first emphasised word, otherwise the longest
 * ordinary word, so a cinematic scene always has something worth setting large.
 */
export function pickKeyword(asked: string | undefined, words: { word: string }[]): string {
  const spoken = words.map((w) => normalizeToken(w.word));
  const want = tokens(asked ?? "");
  if (want.length > 0 && want.length <= 2 && runIndex(spoken, want) >= 0) {
    const shown = want.join(" ");
    if (shown.length <= KEYWORD_MAX_CHARS) return shown;
  }
  const emph = emphasizeWords(words.map((w) => w.word));
  const hit = emph.findIndex((e) => e !== null);
  if (hit >= 0 && spoken[hit]) return spoken[hit];
  let best = "";
  for (const w of spoken) if (w.length > best.length && !STOP.has(w) && w.length <= KEYWORD_MAX_CHARS) best = w;
  return best || spoken[0] || "";
}

/**
 * Up to six narrated words leading into the keyword. The director's own lead is
 * kept only if it is a contiguous run of spoken words; otherwise the words just
 * before the keyword in the sentence, or nothing when the keyword opens it.
 */
export function pickLead(asked: string | undefined, keyword: string, words: { word: string }[]): string {
  const spoken = words.map((w) => normalizeToken(w.word));
  const kw = tokens(keyword);
  const want = tokens(asked ?? "");
  if (want.length > 0 && want.length <= 6 && runIndex(spoken, want) >= 0 && runIndex(want, kw) < 0) {
    return words
      .slice(runIndex(spoken, want), runIndex(spoken, want) + want.length)
      .map((w) => w.word)
      .join(" ")
      .replace(/[,;:]+$/, "");
  }
  const at = runIndex(spoken, kw);
  if (at <= 0) return "";
  return words
    .slice(Math.max(0, at - 6), at)
    .map((w) => w.word)
    .join(" ")
    .replace(/[,;:.]+$/, "");
}

/**
 * Resolve one scene. Returns the scene, plus a note when the template asked
 * for could not be honoured.
 */
async function resolveScene(
  spec: SceneSpec & { from: number; to: number },
  index: number,
  ctx: ValidateContext,
  usedIcons: Set<string>,
): Promise<{ scene: Scene; note?: string }> {
  const first = ctx.sentences[spec.from];
  const last = ctx.sentences[spec.to];
  const hay = haystacksFor(spec, ctx);
  const concept = (spec.concept ?? "").trim();

  const base = {
    index,
    start: first.start,
    end: last.end,
    sentences: Array.from({ length: spec.to - spec.from + 1 }, (_, k) => spec.from + k),
    beatIndex: first.beatIndex,
    source: { pageIndex: first.sourcePage, startWord: first.startWord, endWord: first.endWord },
    reason: (spec.reason ?? "").trim(),
    concept,
  };

  const kinetic = (why?: string): { scene: Scene; note?: string } => ({
    scene: {
      ...base,
      kind: "kinetic-text",
      tone: TONE_BY_KIND["kinetic-text"],
      words: sentenceWords(spec.from, spec.to, ctx),
      ...(why ? { fallbackFrom: spec.kind } : {}),
    },
    ...(why ? { note: `Scene ${index + 1}: ${why} — showing the narration itself instead.` } : {}),
  });

  const withKind = (kind: VisualKind, extra: Partial<Scene>): Scene => ({
    ...base,
    kind,
    tone: TONE_BY_KIND[kind],
    ...extra,
  });

  switch (spec.kind) {
    case "book-page":
      if (!ctx.hasPage(first.sourcePage)) return kinetic("the page image is missing");
      return { scene: withKind("book-page", {}) };

    case "book-crop": {
      if (!ctx.hasPage(first.sourcePage)) return kinetic("the page image is missing");
      const box = ctx.cropFor(first.sourcePage, first.startWord, first.endWord);
      if (!box) {
        return {
          scene: withKind("book-page", {}),
          note: `Scene ${index + 1}: no word geometry to zoom into — showing the whole page instead.`,
        };
      }
      return { scene: withKind("book-crop", { crop: box }) };
    }

    case "quote": {
      const found = spec.quote ? ctx.locate(first.sourcePage, spec.quote) : null;
      if (!found) return kinetic("the quote was not found in the book");
      return {
        scene: withKind("quote", {
          quote: { text: found.text, page: first.sourcePage },
          source: { pageIndex: first.sourcePage, startWord: found.startWord, endWord: found.endWord },
        }),
      };
    }

    case "stat": {
      const value = (spec.value ?? "").trim();
      const digits = value.replace(/[^\d]/g, "");
      if (!digits || !numberIsSaid(digits, hay)) {
        return kinetic("the number is not in the narration or the page");
      }
      const label = (spec.label ?? concept).trim();
      return { scene: withKind("stat", { stat: { value, label: groundedIn(label, hay) ? label : "" } }) };
    }

    case "comparison": {
      const left = (spec.left ?? "").trim();
      const right = (spec.right ?? "").trim();
      if (!left || !right || !groundedIn(left, hay) || !groundedIn(right, hay)) {
        return kinetic("the two sides are not both in what is said");
      }
      const icons: SceneIcon[] = [];
      for (const side of [left, right]) {
        const icon = await resolveIcon(side, { embedder: ctx.embedder, exclude: usedIcons });
        if (icon) {
          usedIcons.add(icon.name);
          icons.push(icon);
        }
      }
      return { scene: withKind("comparison", { left, right, icons: icons.length === 2 ? icons : [] }) };
    }

    case "steps":
    case "timeline": {
      const steps = (spec.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 4);
      if (steps.length < 2) return kinetic(`a ${spec.kind} scene needs at least two entries`);
      const ungrounded = steps.filter((s) => !groundedIn(s, hay));
      if (ungrounded.length) return kinetic(`the ${spec.kind} entries are not in what is said`);
      return { scene: withKind(spec.kind, { steps }) };
    }

    case "growth-curve": {
      const label = (spec.label ?? concept).trim();
      if (!groundedIn(label, hay)) return kinetic("the curve's label is not in what is said");
      // A fixed accelerating shape: this is a picture of compounding, never a
      // plot of data the book did not give.
      return {
        scene: withKind("growth-curve", { curve: { points: [4, 8, 14, 24, 40, 64, 96], label } }),
      };
    }

    case "icon-concept": {
      const items = (spec.items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
      const labels = items.length ? items : concept ? [concept] : [];
      if (!labels.length) return kinetic("no concept was given to picture");
      const ungrounded = labels.filter((l) => !groundedIn(l, hay));
      if (items.length && ungrounded.length) return kinetic("the icon labels are not in what is said");

      const icons: SceneIcon[] = [];
      for (const label of labels) {
        // The label FIRST, then the scene's concept as context.
        // Concept-first was measured and was wrong: "an arrow curving around a
        // barrier" swamped three different labels and returned three arrows,
        // because the concept describes the whole scene while each label names
        // its own item. The label is the specific thing this icon is OF.
        const icon =
          (await resolveIcon(label, { embedder: ctx.embedder, exclude: usedIcons })) ??
          (await resolveIcon(`${label} ${concept}`.trim(), { embedder: ctx.embedder, exclude: usedIcons }));
        if (icon) {
          usedIcons.add(icon.name);
          icons.push(icon);
        }
      }
      if (!icons.length) return kinetic("no icon means what this scene is about");
      // Only real labels are PAINTED. `concept` is a description of a picture
      // ("a barrier blocking a path") written to be matched against icon tags;
      // on screen it reads as a stage direction, so a scene that gave no
      // labels shows the icon alone.
      return { scene: withKind("icon-concept", { icons, items: items.slice(0, icons.length) }) };
    }

    case "cinematic": {
      const words = sentenceWords(spec.from, spec.to, ctx);
      const text = words.map((w) => w.word).join(" ");
      const hero: HeroId = isHeroId(spec.hero) ? spec.hero : heroForText(`${concept} ${text}`);
      const keyword = pickKeyword(spec.keyword, words);
      return { scene: withKind("cinematic", { words, cine: { hero, keyword, lead: pickLead(spec.lead, keyword, words) } }) };
    }

    case "kinetic-text":
    default:
      return kinetic();
  }
}

/** A scene's narration, for matching a hero to it. */
function narrationOf(s: Scene, ctx: ValidateContext): string {
  return s.sentences.map((i) => ctx.sentences[i]?.text ?? "").join(" ");
}

/** Turn a scene into a cinematic one, keeping its timing and source. */
function toCinematic(s: Scene, ctx: ValidateContext, hero: HeroId, hook?: boolean): Scene {
  const words = s.words ?? sentenceWords(s.sentences[0], s.sentences[s.sentences.length - 1], ctx);
  const keyword = pickKeyword(s.cine?.keyword, words);
  return {
    ...s,
    kind: "cinematic",
    tone: TONE_BY_KIND.cinematic,
    words,
    icon: undefined,
    icons: undefined,
    quote: undefined,
    crop: undefined,
    cine: {
      hero,
      keyword,
      lead: hook ? "" : pickLead(s.cine?.lead, keyword, words),
      ...(hook ? { hook: true, accentWords: ctx.hook?.keywords ?? [] } : {}),
    },
  };
}

/**
 * Validate and repair a whole plan. Scene ranges must already be a legal cover
 * of the sentences (see `plan.normalizeRanges`).
 */
export async function validateScenes(
  specs: (SceneSpec & { from: number; to: number })[],
  ctx: ValidateContext,
): Promise<ScenePlanReport> {
  const notes: string[] = [];
  const usedIcons = new Set<string>();
  const scenes: Scene[] = [];

  for (let i = 0; i < specs.length; i++) {
    const { scene, note } = await resolveScene(specs[i], i, ctx, usedIcons);
    if (note) notes.push(note);
    scenes.push(scene);
  }

  // --- the opening is always cinematic and about THIS topic ---------------------
  // Whatever the director chose for scene 0, the video opens on a hero object for
  // the hook's own idea with the spoken hook sentence set in cinematic type —
  // never a plain book page, never a card of text.
  if (scenes.length > 0) {
    const first = scenes[0];
    const want: HeroId =
      first.kind === "cinematic" && first.cine ? first.cine.hero : heroForText(`${ctx.hook?.text ?? ""} ${narrationOf(first, ctx)}`);
    scenes[0] = toCinematic(first, ctx, want, true);
    if (first.kind !== "cinematic") notes.push(`Scene 1: opened with a cinematic hook instead of ${first.kind}.`);
  }

  // --- visual variety --------------------------------------------------------
  const heroUses = (id: HeroId) => scenes.filter((s) => s.kind === "cinematic" && s.cine?.hero === id).length;
  const heroOf = (s: Scene) => (s.kind === "cinematic" ? s.cine?.hero : undefined);

  // A hero never twice in a row and never more than MAX_HERO_USES times: the
  // later scene gets the next-best hero for ITS narration instead.
  for (let i = 1; i < scenes.length; i++) {
    const h = heroOf(scenes[i]);
    if (!h) continue;
    const prev = heroOf(scenes[i - 1]);
    if (h !== prev && (h === "orb" ? heroUses(h) <= 1 : heroUses(h) <= MAX_HERO_USES)) continue;
    const used = scenes.flatMap((s) => (heroOf(s) ? [heroOf(s)!] : []));
    const next = heroForText(`${scenes[i].concept} ${narrationOf(scenes[i], ctx)}`, [...used, ...(prev ? [prev] : [])]);
    if (next !== h && next !== "orb") scenes[i] = toCinematic(scenes[i], ctx, next, scenes[i].cine?.hook);
  }

  // Quote cards are the book's words on their own; two is a video about a book,
  // five is a slideshow of quotations.
  let quotes = 0;
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].kind !== "quote") continue;
    if (++quotes <= MAX_QUOTES) continue;
    const box = ctx.cropFor(scenes[i].source.pageIndex, scenes[i].source.startWord, scenes[i].source.endWord);
    const to: VisualKind = ctx.hasPage(scenes[i].source.pageIndex) && box ? "book-crop" : "kinetic-text";
    scenes[i] = {
      ...scenes[i],
      kind: to,
      tone: TONE_BY_KIND[to],
      fallbackFrom: "quote",
      quote: undefined,
      ...(to === "book-crop" && box ? { crop: box } : { words: sentenceWords(scenes[i].sentences[0], scenes[i].sentences[scenes[i].sentences.length - 1], ctx) }),
    };
    notes.push(`Scene ${i + 1}: more than ${MAX_QUOTES} quote cards — changed to ${to}.`);
  }

  // The cinematic floor. Scenes that are only the narration in type (and icon
  // scenes past their cap) become hero scenes, best-matching narration first,
  // and not next to another cinematic scene unless the floor cannot be met
  // any other way.
  const floor = scenes.length >= 6 ? Math.max(3, Math.ceil(scenes.length * CINEMATIC_SHARE)) : Math.ceil(scenes.length * CINEMATIC_SHARE);
  const cineCount = () => scenes.filter((s) => s.kind === "cinematic").length;
  if (cineCount() < floor) {
    let icons = 0;
    const cands = scenes
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "kinetic-text" || (s.kind === "icon-concept" && ++icons > MAX_ICON_SCENES))
      .map(({ s, i }) => ({ i, match: heroMatch(`${s.concept} ${narrationOf(s, ctx)}`) }))
      .sort((a, b) => b.match - a.match || a.i - b.i);
    for (const pass of [0, 1]) {
      for (const c of cands) {
        if (cineCount() >= floor) break;
        if (scenes[c.i].kind === "cinematic") continue;
        const adjacent = scenes[c.i - 1]?.kind === "cinematic" || scenes[c.i + 1]?.kind === "cinematic";
        if (pass === 0 && adjacent) continue;
        const used = scenes.flatMap((s) => (heroOf(s) ? [heroOf(s)!] : []));
        const hero = heroForText(`${scenes[c.i].concept} ${narrationOf(scenes[c.i], ctx)}`, used);
        if (hero === "orb" && used.includes("orb")) continue;
        scenes[c.i] = toCinematic(scenes[c.i], ctx, hero);
        notes.push(`Scene ${c.i + 1}: shown as a cinematic ${hero} scene for variety.`);
      }
    }
  }

  // No template three times in a row. The third becomes a book scene where the
  // page allows it (which also serves the book-scene floor below), otherwise
  // the narration itself.
  for (let i = MAX_RUN; i < scenes.length; i++) {
    const run = scenes.slice(i - MAX_RUN, i + 1);
    if (!run.every((s) => s.kind === run[0].kind)) continue;
    const from = scenes[i].kind;
    const to: VisualKind = from === "book-page" ? "kinetic-text" : ctx.hasPage(scenes[i].source.pageIndex) ? "book-page" : "kinetic-text";
    scenes[i] = {
      ...scenes[i],
      kind: to,
      tone: TONE_BY_KIND[to],
      fallbackFrom: from,
      ...(to === "kinetic-text"
        ? { words: sentenceWords(scenes[i].sentences[0], scenes[i].sentences[scenes[i].sentences.length - 1], ctx) }
        : {}),
    };
    notes.push(`Scene ${i + 1}: ${from} three times in a row — changed to ${to} for variety.`);
  }

  // The book must stay visible — but proportionally. Three book scenes out of
  // twelve is a video about a book; three out of four is the page again, which
  // is the very thing the scene system exists to fix. So the floor is a third
  // of the plan, capped at MIN_BOOK_SCENES.
  const isBook = (s: Scene) => BOOK_KINDS.includes(s.kind);
  const bookFloor = Math.min(MIN_BOOK_SCENES, Math.max(1, Math.round(scenes.length / 3)));
  for (let i = scenes.length - 1; i >= 0 && scenes.filter(isBook).length < bookFloor; i--) {
    const s = scenes[i];
    if (isBook(s) || s.kind !== "kinetic-text" || !ctx.hasPage(s.source.pageIndex)) continue;
    // Never two book scenes running, which would undo the variety just won.
    if (scenes[i - 1] && isBook(scenes[i - 1])) continue;
    if (scenes[i + 1] && isBook(scenes[i + 1])) continue;
    scenes[i] = { ...s, kind: "book-page", tone: TONE_BY_KIND["book-page"], fallbackFrom: s.kind, words: undefined };
    notes.push(`Scene ${i + 1}: changed to the book page so the book stays visible.`);
  }

  // A small accent icon for kinetic text, kind selection now settled (a scene
  // the book-floor pass above just turned INTO kinetic-text would otherwise
  // be eligible here too, which is backwards — that pass runs first for
  // exactly this reason). Deliberately stricter than every other icon lookup
  // in this file: those are load-bearing (the scene has nothing else to
  // show), this is decorative, so a borderline match is worse than none —
  // "use kinetic typography instead of forcing an unrelated icon" holds even
  // when kinetic typography is what is already being shown.
  for (const s of scenes) {
    if (s.kind !== "kinetic-text" || !s.concept) continue;
    const icon = await resolveIcon(s.concept, { embedder: ctx.embedder, exclude: usedIcons, minScore: MIN_SCORE_ACCENT });
    if (icon) {
      usedIcons.add(icon.name);
      s.icon = icon;
    }
  }

  const used: Record<string, number> = {};
  for (const s of scenes) used[s.kind] = (used[s.kind] ?? 0) + 1;

  const bookCount = scenes.filter(isBook).length;
  if (bookCount < bookFloor) {
    notes.push(`Only ${bookCount} scene(s) show the book; ${bookFloor} were wanted, but no other scene could be converted.`);
  }

  return { scenes: scenes.map((s, i) => ({ ...s, index: i })), notes, used };
}
