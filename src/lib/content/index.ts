import crypto from "node:crypto";
import { prisma } from "../db";
import { ContentRejectedError } from "../errors";
import { reserveIdea, releaseIdea } from "./idea";
import type { Archetype, ContentPackage, GenerateInput, IdeaBrief, LengthSpec, ScriptLength } from "./schema";
import { LENGTHS, spokenWordCount, voScriptFromPackage } from "./schema";
import { expectedSeconds, maxWordsFor, VIDEO_MAX_SECONDS } from "./duration";
import { checkRanges } from "./ranges";
import { generateWithCli, runCliJson } from "./cli-provider";
import type { CliProvider } from "./cli";
import {
  checkQuotationBudget,
  MAX_QUOTE_WORDS,
  MAX_VERBATIM_SHARE,
  RUN_FLOOR,
  type QuotationReport,
  type RightsStatus,
} from "./quotation";
import {
  findAuthorMentions,
  revisionBrief,
  GROUNDING_SYSTEM,
  GROUNDING_SCHEMA,
  buildGroundingPrompt,
  type GroundingReport,
} from "./verify";

export * from "./schema";
export {
  checkQuotationBudget,
  MAX_QUOTE_WORDS,
  MAX_VERBATIM_SHARE,
  RUN_FLOOR,
  SUBFLOOR_RUN,
  MAX_SUBFLOOR_SHARE,
  type QuotationReport,
  type RightsStatus,
} from "./quotation";
export { findAuthorMentions, type GroundingReport, type GroundingIssue } from "./verify";
/**
 * The purchase line is composed here, in code, and never asked of the writer —
 * see `./book-link`. The pipeline stores `appendBookLink(pkg.description,
 * book.bookLink)`, not `pkg.description`.
 */
export { appendBookLink, normalizeBookLink, BOOK_LINK_PREFIX, MAX_BOOK_LINK_LENGTH } from "./book-link";

function normalizeHook(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function hookHash(bookId: string, hook: string): string {
  return crypto.createHash("sha256").update(`${bookId}::${normalizeHook(hook)}`).digest("hex");
}

/** Jaccard similarity over word sets — cheap near-duplicate detector. */
function similarity(a: string, b: string): number {
  const sa = new Set(normalizeHook(a).split(" "));
  const sb = new Set(normalizeHook(b).split(" "));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export interface GenerateContentOpts {
  bookId: string;
  bookTitle: string;
  /** Absent unless verified. Never handed to the writer or the checker as a
   *  usable name when `authorVerified` is false — see `./prompt`. */
  author: string | null;
  authorVerified: boolean;
  archetype: Archetype;
  rightsStatus: RightsStatus;
  ideaKey: string;
  /** Page text the episode covers — also the quotation budget's source text. */
  pages: GenerateInput["pages"];
  provider: CliProvider;
  model?: string;
  onStep?: (step: string) => Promise<void> | void;
  /** The book-analysis idea a long episode is built around. */
  brief?: IdeaBrief;
  /** Absent means "short", the photo-episode shape, which has no length gate. */
  length?: ScriptLength;
  /**
   * A "long" script's length plan (duration.ts): the writer is told `writer`, a
   * draft is checked against the (wider) `gate`. Absent means the envelope.
   */
  lengthPlan?: { writer: LengthSpec; gate: LengthSpec };
  /**
   * Called with each draft the moment it is handed to the grounding checker,
   * so the caller can prepare that draft's audio while the check runs. The
   * caller must use such work ONLY for the package this function finally
   * returns — a draft passed here may still be rejected.
   */
  onCheckStart?: (candidate: ContentPackage) => void;
  /**
   * Called with a draft the grounding check has approved, to find out whether the
   * RECORDED voice makes the finished video break the length ceiling. A problem comes
   * back as a rewrite brief, exactly like a gate failure: the hard limit is met by
   * cutting the script, not by failing the episode.
   */
  measureDraft?: (draft: ContentPackage) => Promise<{ brief: string; finalMessage: string; data: unknown } | null>;
}

export interface GenerateResult {
  pkg: ContentPackage;
  report: GroundingReport | null;
  revised: boolean;
  /** Word ranges repaired in code on the approved draft (see ./ranges). */
  rangeRepairs?: string[];
}

const MAX_REVISIONS: number = 2;

export interface LengthIssue {
  beats: number;
  words: number;
  problem: string;
  brief: string;
}

/**
 * The long-episode length gate: beat count and spoken word count inside the
 * spec. Null when the spec has no word range (a short episode) or the draft
 * fits. Pure, so it is tested without a model.
 */
export function checkLength(pkg: Pick<ContentPackage, "beats">, spec: LengthSpec): LengthIssue | null {
  if (spec.minWords === null || spec.maxWords === null) return null;
  const beats = pkg.beats.length;
  const words = spokenWordCount(pkg);
  const problems: string[] = [];
  if (beats < spec.minBeats || beats > spec.maxBeats) {
    problems.push(`${beats} beats, outside the ${spec.minBeats}–${spec.maxBeats} a ${spec.seconds.replace(/-/g, " ")} video needs`);
  }
  if (words < spec.minWords || words > spec.maxWords) {
    problems.push(`${words} spoken words, outside the ${spec.minWords}–${spec.maxWords} that make a ${spec.seconds.replace(/-/g, " ")} video`);
  }
  // Seconds depend on beats as well as words, and the limit is in seconds: a script
  // inside the word range can still predict past it.
  const predicted = expectedSeconds(words, beats);
  const overSeconds = spec.maxExpectedSeconds !== undefined && predicted > spec.maxExpectedSeconds;
  if (overSeconds) {
    problems.push(`${words} words in ${beats} beats, which would run about ${Math.round(predicted)} seconds against the ${VIDEO_MAX_SECONDS}-second limit`);
  }
  if (!problems.length) return null;
  const aim = spec.aimWords ?? Math.round((spec.minWords + spec.maxWords) / 2);
  const target = overSeconds && spec.maxExpectedSeconds !== undefined ? Math.min(aim, maxWordsFor(spec.maxExpectedSeconds - 3, beats)) : aim;
  return {
    beats,
    words,
    problem: `The script ran to ${problems.join(" and ")}`,
    brief:
      `A length check found this draft has ${problems.join(" and ")}. ` +
      (words > spec.maxWords || overSeconds
        ? `Cut it to about ${target} words: tighten every beat and drop anything that restates an earlier point. `
        : words < spec.minWords
          ? `Develop it to about ${target} words: go further into the book's own example or argument for this one idea — never pad, and never add a claim the page does not support. `
          : "") +
      `Keep between ${spec.minBeats} and ${spec.maxBeats} beats. Every other rule still applies.`,
  };
}

/**
 * Writes a script, then hands it to a SEPARATE, adversarial grounding pass
 * before anything is spoken. The grounding pass is a different model call
 * than the one that wrote the script, given the source page text and told to
 * find reasons to reject — asking the writer to grade its own work reliably
 * produces "looks good", which is why this is not a self-check (see
 * `./verify`'s doc comment on `GROUNDING_SYSTEM`).
 *
 * Two checks run BEFORE that model call, deterministically, on every draft
 * this function produces: `findAuthorMentions` (an unverified author must
 * never be named, or stood in for, and that must not depend on a checker
 * noticing) and `checkQuotationBudget` (the narration must not reproduce too
 * much of the page). Neither throws on a first offense: a model brushing the
 * quotation budget or naming the wrong author on a first draft is an
 * ordinary, correctable event — exactly the kind of thing a specific,
 * actionable brief fixes in one pass — not a reason to burn the whole run.
 * Both feed the SAME rewrite loop the grounding checker uses (`gateCheck`
 * below), sharing its `MAX_REVISIONS` budget, and only throw
 * `ContentRejectedError` once that ceiling is reached with the problem still
 * present. Every failing path — the gate ceiling, a rejected grounding
 * verdict, a CLI failure, anything — sits inside the same outer `try` that
 * wraps every model call, so all of them release the idea reservation. An
 * angle burned by a failed run is an angle no future episode of that book
 * could ever use.
 */
export async function generateContent(opts: GenerateContentOpts): Promise<GenerateResult> {
  const {
    bookId,
    bookTitle,
    author,
    authorVerified,
    archetype,
    rightsStatus,
    ideaKey,
    pages,
    provider,
    model,
    onStep,
    brief: ideaBrief,
    length = "short",
    onCheckStart,
  } = opts;
  const lengthSpec = length === "long" && opts.lengthPlan ? opts.lengthPlan.gate : LENGTHS[length];
  const pageLengths = new Map(pages.map((p) => [p.pageIndex, p.words.length]));
  /** Range repairs made on the draft that was finally approved (reset per draft). */
  let rangeRepairs: string[] = [];

  const previous = await prisma.usedHook.findMany({
    where: { bookId },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  const avoidHooks = previous.map((p) => p.hook);

  // The one text the quotation budget measures narration against.
  const sourceText = pages.map((p) => p.words.join(" ")).join(" ");

  // The writer and the checker are never handed an unverified name — the one
  // fact that must never disagree with itself is whether a name exists.
  const safeAuthor = authorVerified ? author : null;

  // Reserved BEFORE the script is written, not after — see idea.ts. A failure
  // here (IdeaTakenError) means nothing was reserved by this call, so there
  // is nothing to release.
  await reserveIdea(bookId, ideaKey);

  const write = async (extraAvoid: string[], brief?: string): Promise<ContentPackage> => {
    const input: GenerateInput = {
      bookTitle,
      author: safeAuthor,
      archetype,
      rightsStatus,
      ideaKey,
      pages,
      avoidHooks: [...avoidHooks, ...extraAvoid],
      // Spread so a short (photo) input carries neither key at all and is
      // exactly the object it always was.
      ...(ideaBrief ? { brief: ideaBrief } : {}),
      ...(length !== "short" ? { length } : {}),
      ...(length === "long" && opts.lengthPlan ? { spec: opts.lengthPlan.writer } : {}),
    };
    return generateWithCli(input, provider, model, brief);
  };

  const check = async (candidate: ContentPackage): Promise<GroundingReport> =>
    runCliJson<GroundingReport>(
      provider,
      GROUNDING_SYSTEM,
      // The model is handed the exact verified name (or null), not just a
      // yes/no, so it can catch a WRONG name — not only an absent one.
      buildGroundingPrompt(candidate, pages, avoidHooks, safeAuthor, bookTitle),
      GROUNDING_SCHEMA,
      model,
    );

  /**
   * `report.verdict` alone is not trusted to gate the loop: `indicesGrounded`
   * and `authorNamed` were split out into their own named fields precisely
   * so they could be checked on their own (review finding 5) rather than
   * relying on the model to have already folded them into `verdict`
   * consistently. `authorNamed` is only a problem when it's a problem GIVEN
   * verification state — a verified author being named is exactly what the
   * prompt allows, so that alone must not force a rewrite; the WRONG name is
   * caught deterministically by `gate` before this is ever reached, and
   * `authorNamed` here is the model's independent, second layer for the
   * unverified case (or a case `gate`'s regex missed).
   */
  const needsRevision = (r: GroundingReport): boolean =>
    r.verdict === "revise" || !r.indicesGrounded || (!authorVerified && r.authorNamed);

  /**
   * A gate failure that the SAME loop `needsRevision`/`revisionBrief` drive
   * for the grounding checker can also fix: a concrete, actionable brief for
   * the writer, plus the message to use if the problem is still present once
   * `MAX_REVISIONS` is exhausted (`gate` below never lets that ceiling
   * message escape early — see `MAX_REVISIONS` handling in the main loop).
   */
  interface GateIssue {
    kind: "author" | "quotation" | "length" | "ranges";
    /** Fed back to the writer exactly like `revisionBrief(report)` is. */
    brief: string;
    /** Used only once the rewrite ceiling is reached with this still failing. */
    finalMessage: string;
    data: unknown;
  }

  const rewriteNote = ` even after ${MAX_REVISIONS} rewrite${MAX_REVISIONS === 1 ? "" : "s"}, so no voiceover was recorded.`;

  /**
   * Concrete, actionable feedback — vague feedback wastes a rewrite. Names
   * the offending passage (`quotation.excerpt`), the exact numbers the draft
   * ran to versus the limit, and what to change. Also tells the model the
   * book's rights status, since that is what decides how tight the budget
   * actually is — a brief that omits it lets the model guess wrong about how
   * much room it has.
   */
  function quotationBrief(q: QuotationReport, rights: RightsStatus): string {
    const lines = [
      `A quotation-budget check found this draft reproduces too much of the source page verbatim.`,
      // The floor is the part a writer cannot guess. Told only "do not quote
      // too much", a model rewrites the one passage it thinks of as a quote
      // and leaves a dozen unnoticed five-word echoes exactly where they were.
      `WHAT COUNTS: any run of ${RUN_FLOOR} or more consecutive words matching the page, anywhere in the narration — not just passages you thought of as quotes. Ordinary phrasing you echoed without noticing counts exactly the same as a deliberate quote.`,
    ];
    if (q.excerpt && q.longestRun > MAX_QUOTE_WORDS) {
      lines.push(
        `The longest run is ${q.longestRun} words — over the ${MAX_QUOTE_WORDS}-word limit for a single quote: "${q.excerpt}"`,
      );
    }
    if (q.excerpts.length) {
      const shown = q.excerpts.slice(0, 12);
      lines.push(
        `The ${q.excerpts.length} run${q.excerpts.length === 1 ? "" : "s"} counted against you${
          shown.length < q.excerpts.length ? ` (the ${shown.length} longest shown)` : ""
        }:`,
        ...shown.map((e) => `  - "${e}"`),
      );
    }
    lines.push(
      `Overall about ${Math.round(q.verbatimShare * 100)}% of the narration is quoted verbatim from the page, against an ${Math.round(MAX_VERBATIM_SHARE * 100)}% limit for this book's rights status ("${rights}").`,
      `Rewrite the whole package: take the runs listed above one at a time and say each in different words — change the shape of the sentence, not just a synonym here and there, because a run stays a run if you only swap one word in the middle. Keep AT MOST ONE short quote (well under ${MAX_QUOTE_WORDS} words) and only where the exact wording is genuinely the point. Everything else must be your own commentary about the passage.`,
    );
    return lines.join("\n");
  }

  function authorBrief(mentions: string[], forAuthor: string | null): string {
    return forAuthor
      ? `An author-identity check found this draft named "${mentions[0]}", which does not match this book's verified author, "${forAuthor}". Rewrite the whole package: use "${forAuthor}" wherever the book's author is referenced, and remove every mention of any other name.`
      : `An author-identity check found this draft named or implied an author ("${mentions[0]}") for a book whose author has NOT been verified. Rewrite the whole package: remove that name and any stand-in for one ("the writer", "the author", "whoever wrote this") — refer only to "the page", "the passage", or "the book", never to a person.`;
  }

  /**
   * Deterministic gate run on every fresh draft, before it ever reaches the
   * model-based grounding check. Returns an issue instead of throwing — the
   * caller feeds it into the SAME rewrite loop the grounding checker drives,
   * so a first-draft slip is corrected rather than terminal (see the doc
   * comment on `generateContent`). Naming the wrong author is judged
   * correctable the same way: the model is simply told the right name and
   * asked to fix it, rather than the run being failed outright for a mistake
   * a rewrite reliably fixes.
   */
  const gate = (candidate: ContentPackage): GateIssue | null => {
    // Word ranges, checked in code: the most common reason drafts were sent
    // back, and one no model call is needed to see (see ./ranges).
    const ranges = checkRanges(candidate.beats, pageLengths);
    if (ranges.problems.length) {
      return {
        kind: "ranges",
        brief: [
          "A word-range check found problems before the grounding check ran:",
          ...ranges.problems.map((p) => `- ${p}`),
          "Rewrite the whole package with every range fixed. Every other rule still applies.",
        ].join("\n"),
        finalMessage: `The script's word ranges were still invalid (${ranges.problems[0]})${rewriteNote}`,
        data: ranges.problems,
      };
    }
    candidate.beats = ranges.beats;
    rangeRepairs.push(...ranges.repairs);

    const mentions = findAuthorMentions(candidate, safeAuthor);
    if (mentions.length) {
      // Two different fabrications, and the message must not conflate them:
      // naming someone when NO author was ever verified is one failure; naming
      // the WRONG person when an author WAS verified is a different one — the
      // "has not been established" wording is simply false in the second case,
      // and a message that misdescribes what actually went wrong is worse than
      // a generic one (same principle as `reserveIdea`'s error-naming comment).
      return {
        kind: "author",
        brief: authorBrief(mentions, safeAuthor),
        finalMessage:
          (safeAuthor
            ? `The script named an author (${mentions[0]}) that does not match this book's verified author (${safeAuthor})`
            : `The script named an author (${mentions[0]}) for a book whose author has not been established`) +
          rewriteNote,
        data: { authorNamed: true, mentions },
      };
    }

    const quotation = checkQuotationBudget(voScriptFromPackage(candidate), sourceText, rightsStatus);
    if (!quotation.withinBudget) {
      return {
        kind: "quotation",
        brief: quotationBrief(quotation, rightsStatus),
        finalMessage:
          // Only the limit that actually broke. Printing both unconditionally
          // reported "longest run 9 words vs the 25-word limit" for a draft
          // whose longest run was FINE, sending the operator after the wrong
          // number entirely.
          `The narration reproduces too much of the page (` +
          [
            quotation.longestRun > MAX_QUOTE_WORDS
              ? `longest quote ${quotation.longestRun} words vs the ${MAX_QUOTE_WORDS}-word limit`
              : null,
            quotation.verbatimShare > MAX_VERBATIM_SHARE
              ? `${Math.round(quotation.verbatimShare * 100)}% of the narration is verbatim against an ${Math.round(MAX_VERBATIM_SHARE * 100)}% limit — spread over ${quotation.excerpts.length} run${quotation.excerpts.length === 1 ? "" : "s"} of ${RUN_FLOOR}+ words, not one long quote`
              : null,
          ]
            .filter(Boolean)
            .join("; ") +
          `)` +
          rewriteNote +
          ` This book's rights status is "${rightsStatus}", which is what caps quotation at all — a public-domain or own-work book has no quotation budget. If you own this material or it is out of copyright, set that rights status on the book to remove this limit entirely.`,
        data: quotation,
      };
    }

    // Length, for a long episode only. After author and quotation on purpose:
    // those are legal and factual rails; this one is about fit, and a rewrite
    // aimed at fixing a quotation problem should not be spent on word counts.
    const lengthIssue = checkLength(candidate, lengthSpec);
    if (lengthIssue) {
      return {
        kind: "length",
        brief: lengthIssue.brief,
        finalMessage: `${lengthIssue.problem}${rewriteNote}`,
        data: lengthIssue,
      };
    }

    return null;
  };

  let pkg: ContentPackage;
  let report: GroundingReport | null = null;
  let revised = false;

  try {
    // Announced before the first draft, not only before a REWRITE. Without
    // this the whole first model call -- by far the most expensive step in the
    // run -- was still being reported under whatever step preceded it, so a
    // real episode showed "Reserving the idea" for four minutes and the step
    // named "Writing the script" only ever appeared when a rewrite happened.
    await onStep?.("Writing the script");
    pkg = await write([]);

    // Cheap local guard before spending a second model call: a hook too close
    // to a previous one is regenerated with that hook explicitly forbidden.
    const tooClose = avoidHooks.find((h) => similarity(h, pkg.hook) > 0.6);
    if (tooClose) {
      pkg = await write([pkg.hook]);
    }

    // One shared rewrite budget for every kind of fixable problem: the
    // deterministic gate (author identity, quotation budget) and the
    // model-based grounding check. Each round checks the gate first — no
    // point spending a second model call on grounding a draft the gate has
    // already rejected — and only reaches the grounding check once the gate
    // passes clean. Either kind of failure, on the final round, throws
    // `ContentRejectedError` instead of rewriting again; the budget and the
    // author gate are legal/factual safety rails and must never become
    // advisory just because a rewrite was available.
    for (let round = 0; ; round++) {
      rangeRepairs = [];
      const issue = gate(pkg);
      if (issue) {
        if (round >= MAX_REVISIONS) {
          throw new ContentRejectedError(issue.finalMessage, issue.data);
        }
        await onStep?.(
          issue.kind === "quotation"
            ? "Rewriting after the quotation-budget check"
            : issue.kind === "length"
              ? "Rewriting after the length check"
              : issue.kind === "ranges"
                ? "Rewriting after the word-range check"
                : "Rewriting after the author check",
        );
        pkg = await write([], issue.brief);
        revised = true;
        continue;
      }

      // Independent grounding check. Nothing is spoken until the script is
      // validated, so a blocker is rewritten and re-checked rather than shipped.
      await onStep?.("Checking the script against the page");
      onCheckStart?.(pkg);
      report = await check(pkg);
      if (!needsRevision(report)) {
        const over = await opts.measureDraft?.(pkg);
        if (!over) break;
        if (round >= MAX_REVISIONS) throw new ContentRejectedError(`${over.finalMessage}${rewriteNote}`, over.data);
        await onStep?.("Rewriting after the length check");
        pkg = await write([], over.brief);
        revised = true;
        continue;
      }

      if (round >= MAX_REVISIONS) {
        const blockers = report.issues.filter((i) => i.severity === "blocker");
        const detail = (blockers.length ? blockers : report.issues)
          .slice(0, 3)
          .map((i) => `${i.field}: ${i.problem}`)
          .join(" | ");
        throw new ContentRejectedError(
          `The grounding check rejected the script after ${MAX_REVISIONS} rewrites, so no voiceover was recorded. ${detail}`,
          report,
        );
      }

      await onStep?.(
        round === 0 ? "Rewriting after the grounding check" : "Rewriting after the grounding check (2 of 2)",
      );
      pkg = await write([], revisionBrief(report));
      revised = true;
    }

    // Inside the same protected region as everything else: a failure here
    // (review finding 3) would otherwise burn the idea reservation for a run
    // that produced no video at all, with no `catch` to hand it back.
    await prisma.usedHook.upsert({
      where: { hash: hookHash(bookId, pkg.hook) },
      create: { bookId, hook: pkg.hook, hash: hookHash(bookId, pkg.hook) },
      update: {},
    });
  } catch (err) {
    await releaseIdea(bookId, ideaKey);
    throw err;
  }

  return { pkg, report, revised, rangeRepairs };
}
