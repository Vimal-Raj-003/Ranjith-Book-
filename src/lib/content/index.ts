import crypto from "node:crypto";
import { prisma } from "../db";
import { ContentRejectedError } from "../errors";
import { reserveIdea, releaseIdea } from "./idea";
import type { Archetype, ContentPackage, GenerateInput } from "./schema";
import { voScriptFromPackage } from "./schema";
import { generateWithCli, runCliJson } from "./cli-provider";
import type { CliProvider } from "./cli";
import { checkQuotationBudget, type RightsStatus } from "./quotation";
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

const MAX_REVISIONS = 2;

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
 * much of the page). Both throw `ContentRejectedError` inside the same `try`
 * that wraps the model calls, so every failing path — the author gate, the
 * quotation budget, a rejected verdict, a CLI failure, anything — releases
 * the idea reservation. An angle burned by a failed run is an angle no
 * future episode of that book could ever use.
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
      buildGroundingPrompt(candidate, pages, avoidHooks, safeAuthor),
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
   * Deterministic gate run on every fresh draft, before it ever reaches the
   * model-based grounding check — both throws sit inside the caller's `try`,
   * so the idea reservation is always released on rejection.
   */
  const gate = (candidate: ContentPackage): void => {
    const mentions = findAuthorMentions(candidate, safeAuthor);
    if (mentions.length) {
      throw new ContentRejectedError(
        `The script named an author (${mentions[0]}) for a book whose author has not been established.`,
        { authorNamed: true, mentions },
      );
    }

    const quotation = checkQuotationBudget(voScriptFromPackage(candidate), sourceText, rightsStatus);
    if (!quotation.withinBudget) {
      throw new ContentRejectedError(
        `The narration reproduces too much of the page (longest run ${quotation.longestRun} words, ${Math.round(quotation.verbatimShare * 100)}% verbatim).`,
        quotation,
      );
    }
  };

  let pkg: ContentPackage;
  let report: GroundingReport | null = null;
  let revised = false;

  try {
    pkg = await write([]);
    gate(pkg);

    // Cheap local guard before spending a second model call: a hook too close
    // to a previous one is regenerated with that hook explicitly forbidden.
    const tooClose = avoidHooks.find((h) => similarity(h, pkg.hook) > 0.6);
    if (tooClose) {
      pkg = await write([pkg.hook]);
      gate(pkg);
    }

    // Independent grounding check. Nothing is spoken until the script is
    // validated, so a blocker is rewritten and re-checked rather than shipped.
    await onStep?.("Checking the script against the page");
    report = await check(pkg);

    for (let round = 0; round < MAX_REVISIONS && needsRevision(report); round++) {
      await onStep?.(
        round === 0 ? "Rewriting after the grounding check" : "Rewriting after the grounding check (2 of 2)",
      );
      pkg = await write([], revisionBrief(report));
      revised = true;
      gate(pkg);
      await onStep?.("Checking the script against the page");
      report = await check(pkg);
    }

    if (needsRevision(report)) {
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
