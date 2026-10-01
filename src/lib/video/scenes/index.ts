/**
 * The scene plan, end to end: narration and its measured word times in, a
 * validated, grounded list of scenes out.
 *
 *   sentences (real audio)  →  director (one model call)  →  validation  →  scenes
 *
 * The director is the only model call, and it is the only part allowed to
 * fail: without it the sentences are still grouped into scenes by
 * `slotSentences` and every scene renders the narration itself. A video made
 * that way is plainer than one the director planned; it is never wrong, never
 * ungrounded, and never a failed render.
 */
import { runCliJson } from "../../content/cli-provider";
import type { CliProvider } from "../../content/cli";
import type { Beat } from "../../content/schema";
import type { TimedWord } from "../../media/word-timing";
import type { Box } from "../../ingest/ocr";
import { locateQuote, tokenStream } from "../../analysis/quotes";
import type { StructuredPage } from "../../analysis/types";
import { DIRECTOR_SCHEMA, DIRECTOR_SYSTEM, buildDirectorPrompt } from "./director";
import { takeIconTrouble } from "./icons";
import { capOpening, enforceDurations, normalizeRanges, sentencesOf, slotSentences, MAX_SCENES, MIN_SCENES, SCENE_SECONDS } from "./plan";
import { validateScenes, type ValidateContext } from "./validate";
import type { Scene, SceneSpec, ScenePlanReport } from "./types";

export * from "./types";
export { sentencesOf, MIN_SCENES, MAX_SCENES } from "./plan";
export { MIN_BOOK_SCENES, groundedIn } from "./validate";

export interface PlanScenesOptions {
  bookTitle: string;
  beats: Beat[];
  words: TimedWord[];
  /** Page index → that page's words, the space beat indices address. */
  pageWords: Map<number, string[]>;
  /** The box covering a page's word range, in that page's own pixels. */
  cropFor(page: number, startWord: number, endWord: number): Box | null;
  hasPage(page: number): boolean;
  provider: CliProvider;
  model?: string;
  /** Skips the model call; used by tests and by the fallback path. */
  skipDirector?: boolean;
  /** The script's hook line and accent words: what the opening scene is about. */
  hook?: { text: string; keywords: string[] };
}

/** How many scenes to aim for, from the video's length. */
export function targetSceneCount(seconds: number): number {
  return Math.max(MIN_SCENES, Math.min(MAX_SCENES, Math.round(seconds / SCENE_SECONDS)));
}

/**
 * A quote locator over the page words, reusing book analysis's own — the same
 * matcher that decides whether an IDEA is grounded decides whether a QUOTE on
 * screen is. `locateQuote` reads only `.words` off each page, so a sparse
 * array of those is all it needs.
 */
function quoteLocator(pageWords: Map<number, string[]>): ValidateContext["locate"] {
  const pages: StructuredPage[] = [];
  let max = 0;
  for (const k of pageWords.keys()) max = Math.max(max, k);
  for (let i = 0; i <= max; i++) {
    pages[i] = { words: pageWords.get(i) ?? [] } as StructuredPage;
  }
  return (page, quote) => {
    if (!pageWords.has(page)) return null;
    const found = locateQuote(quote, tokenStream(pages, [page]), pages, page);
    if (!found || found.refs.length === 0) return null;
    const first = found.refs[0];
    const last = found.refs[found.refs.length - 1];
    return { text: found.text, startWord: first.startWord, endWord: last.endWord };
  };
}

export interface ScenePlan extends ScenePlanReport {
  /** Whether the director call ran and was used. */
  directed: boolean;
}

export async function planScenes(opts: PlanScenesOptions): Promise<ScenePlan> {
  const sentences = sentencesOf(opts.beats, opts.words);
  if (sentences.length === 0) return { scenes: [], notes: ["No sentences could be cut from the narration, so no scenes were planned."], used: {}, directed: false };

  const seconds = sentences[sentences.length - 1].end - sentences[0].start;
  const target = targetSceneCount(seconds);
  const notes: string[] = [];

  let specs: SceneSpec[] | null = null;
  if (!opts.skipDirector) {
    try {
      const reply = await runCliJson<{ scenes?: SceneSpec[] }>(
        opts.provider,
        DIRECTOR_SYSTEM,
        buildDirectorPrompt(opts.bookTitle, sentences, opts.pageWords, target, opts.hook?.text),
        DIRECTOR_SCHEMA,
        opts.model,
      );
      if (Array.isArray(reply?.scenes) && reply.scenes.length) specs = reply.scenes;
      else notes.push("The visual director returned no scenes — the narration itself is shown throughout.");
    } catch (err) {
      notes.push(
        `Visual planning failed (${err instanceof Error ? err.message : String(err)}) — the narration itself is shown throughout.`,
      );
    }
  }

  // The director's ranges are corrected into a legal cover rather than
  // trusted: a dropped or repeated sentence costs the grouping, never the
  // video. With no director at all, the slots are the fallback grouping.
  const ranges = capOpening(
    specs
      ? enforceDurations(
          normalizeRanges(
            specs.map((s) => ({ fromSentence: Number(s.fromSentence) || 0, toSentence: Number(s.toSentence) || 0 })),
            sentences.length,
          ),
          sentences,
        )
      : slotSentences(sentences, target).map((s) => ({ fromSentence: s.fromSentence, toSentence: s.toSentence })),
    sentences,
  );

  // Re-attach each surviving range to the spec that started at its first
  // sentence; a range the corrections moved keeps whatever the director said
  // about the sentence it now begins on, which is the closest honest match.
  const byFrom = new Map((specs ?? []).map((s) => [Number(s.fromSentence) || 0, s]));
  const resolved = ranges.map((r) => {
    const spec = byFrom.get(r.fromSentence);
    return {
      ...(spec ?? { kind: "kinetic-text" as const, fromSentence: r.fromSentence, toSentence: r.toSentence }),
      from: r.fromSentence,
      to: r.toSentence,
      fromSentence: r.fromSentence,
      toSentence: r.toSentence,
    };
  });

  const ctx: ValidateContext = {
    sentences,
    pageWords: opts.pageWords,
    cropFor: opts.cropFor,
    hasPage: opts.hasPage,
    locate: quoteLocator(opts.pageWords),
    hook: opts.hook,
  };
  const report = await validateScenes(resolved, ctx);

  // Icons are optional by design — a phrase with no good picture simply gets
  // none — so a lookup that FAILED is indistinguishable from one that found
  // nothing unless it is reported. Without this, a machine with the icon
  // package missing would quietly render every icon scene as plain text and
  // look like a directing choice.
  const iconTrouble = takeIconTrouble();
  if (iconTrouble) {
    notes.push(`Icons were unavailable (${iconTrouble}) — scenes that would have used one show the narration instead.`);
  }

  // Close the pauses between scenes. A scene ends on its last spoken word and
  // the next begins on its first, so between them lies the silence the speaker
  // actually took — a gap of up to about half a second with nothing declared
  // for it. Each scene is extended back to where the previous one ended, which
  // both removes the gap and puts the cross-fade INSIDE the pause, where a cut
  // belongs. Word times are absolute, so kinetic text is unaffected.
  for (let i = 1; i < report.scenes.length; i++) {
    report.scenes[i].start = report.scenes[i - 1].end;
  }

  if (report.scenes.length < MIN_SCENES) {
    notes.push(`Only ${report.scenes.length} scenes were planned; the narration may be too short to carry ${MIN_SCENES}.`);
  }

  return {
    scenes: report.scenes,
    notes: [...notes, ...report.notes],
    used: report.used,
    directed: Boolean(specs),
  };
}

/** A one-line summary for the episode's notes. */
export function describePlan(plan: ScenePlan): string {
  const kinds = Object.entries(plan.used)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return `${plan.scenes.length} scenes${plan.directed ? "" : " (planned without the visual director)"}: ${kinds}.`;
}

export type { Scene };
