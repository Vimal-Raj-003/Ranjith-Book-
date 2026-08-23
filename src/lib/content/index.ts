import crypto from "node:crypto";
import { prisma } from "../db";
import { ContentRejectedError } from "../errors";
import { reserveIdea, releaseIdea } from "./idea";
import type { Archetype, ContentPackage, GenerateInput } from "./schema";
import { voScriptFromPackage } from "./schema";
import { generateWithCli, runCliJson } from "./cli-provider";
import type { CliProvider } from "./cli";
import {
  checkQuotationBudget,
  MAX_QUOTE_WORDS,
  MAX_VERBATIM_SHARE,
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
}

export interface GenerateResult {
  pkg: ContentPackage;
  report: GroundingReport | null;
  revised: boolean;
}

const MAX_REVISIONS: number = 2;

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
  } = opts;

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
    kind: "author" | "quotation";
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
    ];
    if (q.excerpt) {
      lines.push(
        q.longestRun > MAX_QUOTE_WORDS
          ? `The longest verbatim run is ${q.longestRun} words — over the ${MAX_QUOTE_WORDS}-word limit for a single quote: "${q.excerpt}"`
          : `The longest verbatim run (${q.longestRun} words, within the per-quote limit) is: "${q.excerpt}"`,
      );
    }
    lines.push(
      `Overall about ${Math.round(q.verbatimShare * 100)}% of the narration is quoted verbatim from the page, against an ${Math.round(MAX_VERBATIM_SHARE * 100)}% limit for this book's rights status ("${rights}").`,
      `Rewrite the whole package: paraphrase that passage in your own words instead of quoting it, keep AT MOST ONE short quote (well under ${MAX_QUOTE_WORDS} words) only if a quote is truly essential, and make sure every other sentence is your own commentary — not the page's phrasing — so the total quoted share drops well under the limit.`,
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
          `The narration reproduces too much of the page (longest run ${quotation.longestRun} words vs the ${MAX_QUOTE_WORDS}-word limit, ${Math.round(quotation.verbatimShare * 100)}% verbatim vs the ${Math.round(MAX_VERBATIM_SHARE * 100)}% limit)` +
          rewriteNote +
          ` This book's rights status is "${rightsStatus}", which is what caps quotation at all — a public-domain or own-work book has no quotation budget. If you own this material or it is out of copyright, set that rights status on the book to remove this limit entirely.`,
        data: quotation,
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
      const issue = gate(pkg);
      if (issue) {
        if (round >= MAX_REVISIONS) {
          throw new ContentRejectedError(issue.finalMessage, issue.data);
        }
        await onStep?.(
          issue.kind === "quotation"
            ? "Rewriting after the quotation-budget check"
            : "Rewriting after the author check",
        );
        pkg = await write([], issue.brief);
        revised = true;
        continue;
      }

      // Independent grounding check. Nothing is spoken until the script is
      // validated, so a blocker is rewritten and re-checked rather than shipped.
      await onStep?.("Checking the script against the page");
      report = await check(pkg);
      if (!needsRevision(report)) break;

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

  return { pkg, report, revised };
}
