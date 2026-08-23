import { sameName } from "../ingest/names";
import { numberedWordLines } from "./prompt";
import type { ContentPackage, GenerateInput } from "./schema";

export interface GroundingIssue {
  field: string; // "hook" | "beats[2].voiceover" | "beats[1].wordRange" | ...
  severity: "blocker" | "note";
  problem: string;
}

export interface GroundingReport {
  verdict: "pass" | "revise";
  /** 0-100: how well the whole script is supported by the source pages. */
  groundedness: number;
  /** True whenever the script names — or stands in for — an author, verified
   *  or not. The caller only cares whether this is a problem, which depends
   *  on whether the author was actually verified; that decision is made by
   *  the deterministic `findAuthorMentions` pre-check below, not by this flag
   *  alone. */
  authorNamed: boolean;
  /**
   * Its own field, deliberately not folded into `issues`: a beat's
   * startWord/endWord can be in-bounds and forward-ordered — passing every
   * arithmetic check — while still pointing at the wrong sentence, because
   * the marker sweep and the voiceover disagree about which words are being
   * discussed. Only a reader that sees both the beat's text and the page's
   * numbered words can judge that, which is exactly what this pass is for.
   * Promoting it to a named boolean means the check has to be answered
   * explicitly rather than possibly never coming up.
   */
  indicesGrounded: boolean;
  issues: GroundingIssue[];
}

const GROUNDING_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "groundedness", "authorNamed", "indicesGrounded", "issues"],
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    groundedness: { type: "integer" },
    authorNamed: { type: "boolean" },
    indicesGrounded: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "severity", "problem"],
        properties: {
          field: { type: "string" },
          severity: { type: "string", enum: ["blocker", "note"] },
          problem: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * This pass did not write the script. It is a SEPARATE call given the source
 * page text and told to look for reasons to reject, precisely because asking
 * the same context that wrote a script to grade it reliably produces "looks
 * good" — see the doc comment on `generateContent` in `./index`.
 */
const SYSTEM = `You are an adversarial grounding checker for short-form book-video scripts. You did not write this script and have no stake in it defending itself. Your job is to find every reason it should not be spoken aloud and published.

Check each of these independently:

1. TRACEABILITY. Every claim in every beat's voiceover must trace to the source page text you were given. Flag anything the pages do not actually say.

2. NO INVENTION. No statistics, no named study, no biographical detail about the author, and no anecdote that is not printed on the page. If a beat asserts something the page never states, that is a blocker.

   ONE EXCEPTION, and it is important: the BOOK TITLE is supplied to you separately below. It came from the operator who photographed the pages, NOT from the model, and NOT from the page text. A book's title is almost never printed on a mid-chapter page, so its absence from the source pages proves nothing. The script naming the book by that title is correct and expected — never flag it as a fabricated or invented source. A DIFFERENT title, one that is neither the supplied title nor a trivial case or spelling variant of it, IS a fabrication and is a blocker.

3. WORD-INDEX GROUNDING — answer this SEPARATELY from everything else, in the "indicesGrounded" field. For every beat, read its voiceover, then read the page's numbered words at that beat's sourcePage between startWord and endWord. Ask: are these actually the words this beat is talking about? An index range can be in-bounds and forward-moving and still be wrong — it can point at the wrong sentence, a neighboring paragraph, or words several lines away from what the beat actually discusses. That mismatch is invisible to any check that only looks at the numbers; it is only visible to a reader who reads both the beat and the words. Set "indicesGrounded" to false if even one beat's range does not match what it is actually about, and name the beat in "issues" as a blocker. Also confirm ranges move forward across beats that share a page — a later beat pointing at earlier words than a beat before it is also a blocker here.

4. AUTHOR IDENTITY. You will be told whether an author is verified for this book, and if so, the exact verified name. If NO author is verified: the script must name no one, and must not stand in for one either — "the writer", "the author" used generically, "whoever wrote this", or any other construction that attributes belief, argument, or intent to a person behind the page is a blocker, set "authorNamed" true. If an author IS verified: that exact name may appear and is not a problem — but the WRONG name (anyone else, including a plausible-sounding but different real author) is exactly the same fabrication as naming someone when no author was ever verified, and is a blocker; set "authorNamed" true for that too. A generic unnamed stand-in is also still a blocker even when an author is verified, unless it is unambiguously referring to the verified person.

5. HOOK DISTINCTNESS. The hook must not repeat any of the previously used hooks supplied to you, in wording or in angle.

6. SPEAKABLE VOICEOVER. Every beat's voiceover is read aloud by a neural speech engine, one beat at a time: no markdown, no bracketed or parenthetical stage directions, no emoji, no URLs, no hashtags, nothing a speech engine would mangle.

Set verdict to "revise" if there is any blocker anywhere, including a false "indicesGrounded" or a true "authorNamed" that is actually a problem given the author-verification state you were told. Warnings ("note" severity) alone are still a "pass". Be specific in every issue: name the field ("beats[2].voiceover", "beats[1].wordRange", "hook") and say exactly what is wrong. Do not rewrite the script yourself. groundedness is 0-100 for how well the whole script is supported by the source pages.`;

function buildPrompt(
  pkg: ContentPackage,
  pages: GenerateInput["pages"],
  avoidHooks: string[],
  /** Null unless verified — the exact same value handed to `findAuthorMentions`
   *  and to the writer's prompt, so the model has the real name to compare
   *  against rather than just a yes/no. */
  verifiedAuthor: string | null,
  /**
   * The operator's own book title, as typed at upload.
   *
   * Without this the checker cannot tell an operator-supplied title from a
   * hallucinated one, and it reasonably assumes the worst: a real run was
   * rejected after two rewrites with "a fabricated source title" because the
   * description named the book, and the title does not appear anywhere in the
   * photographed pages. It almost never does — a page from the middle of a
   * chapter does not reprint the cover. Left unfixed this blocks a video for
   * most books whose script mentions them by name at all.
   */
  bookTitle: string,
): string {
  const pageText = pages
    .map((p) => {
      const heading = p.chapterHeading ? `Heading: ${p.chapterHeading}\n` : "";
      return `--- PAGE ${p.pageIndex} ---\n${heading}${numberedWordLines(p.words)}`;
    })
    .join("\n\n");

  return [
    `BOOK TITLE: ${
      bookTitle.trim()
        ? `"${bookTitle.trim()}" — supplied by the operator who photographed these pages. This is a GIVEN FACT, not something the script invented, and it is not expected to appear in the page text. Naming the book by this title is correct. A different book title is a fabrication.`
        : `not supplied — the script should not name a book.`
    }`,
    ``,
    `AUTHOR: ${
      verifiedAuthor
        ? `verified as "${verifiedAuthor}" — only this exact name may appear. Any other name, or a generic unnamed stand-in ("the writer", "the author", "whoever wrote this"), is a fabrication just like naming an author when none was verified.`
        : `NOT verified — the script must name no one, and no unnamed stand-in either.`
    }`,
    ``,
    `PREVIOUSLY USED HOOKS (the new hook must differ from all of these):`,
    avoidHooks.length ? avoidHooks.map((h) => `- ${h}`).join("\n") : "(none)",
    ``,
    `SOURCE PAGES, word-indexed exactly as the writer was shown them:`,
    pageText,
    ``,
    `GENERATED SCRIPT:`,
    JSON.stringify(pkg, null, 2),
  ].join("\n");
}

export const GROUNDING_SYSTEM = SYSTEM;
export const GROUNDING_SCHEMA = GROUNDING_REPORT_SCHEMA;
export { buildPrompt as buildGroundingPrompt };

/** Instructions fed back to the writer when the checker asks for a revision. */
export function revisionBrief(report: GroundingReport): string {
  const blockers = report.issues.filter((i) => i.severity === "blocker");
  const list = (blockers.length ? blockers : report.issues)
    .map((i) => `- ${i.field}: ${i.problem}`)
    .join("\n");
  return `A grounding check reviewed your previous draft and found problems that must be fixed. Rewrite the whole package, keeping everything that was correct and fixing exactly these:\n${list}`;
}

/**
 * "by <Capitalised Name>" — the shape a fabricated byline takes when it
 * names someone outright. Captures the name itself so it can be compared
 * against a verified author, rather than only detected as present.
 */
const BYLINE_PATTERN =
  /\b(?:by|written by|author(?:ed)? by|penned by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.]+)+)/g;

/**
 * Attributing verbs — the shape that turns a bare noun into an assertion
 * about what a person behind the page believes, argues, or intends. Review
 * finding 4: a bare "the author" / "the writer" also matches ordinary,
 * unrelated prose — "she is the author of her own life" is a legitimate
 * line about self-determination, not a fabricated byline — and a
 * deterministic pre-check that can't tell those apart silently blocks a
 * good run with no actionable reason. Requiring the verb is what the
 * widened prompt actually forbids: "the writer believes...", not "the
 * writer" appearing at all.
 */
const ATTRIBUTION_VERBS =
  "believes?|argues?|thinks?|claims?|insists?|suggests?|contends?|says?|" +
  "wrote|writes?|means?|intends?|maintains?|holds?|feels?|reasons?|" +
  "disagrees?|agrees?|explains?";

/**
 * "the writer believes second chances matter" never names anyone, but it
 * still invents a person behind the page and asserts what they believe —
 * the same fabrication with the name filed off. Matches the unnamed
 * authorial-figure noun ("the writer" / "the author" / "whoever wrote
 * this/it/the X") followed, within a short gap, by an attributing verb.
 * Word-boundaries keep "the author" from firing on "authority", which
 * contains it as a substring but is not a mention of one; requiring the
 * verb keeps it from firing on a bare, unattributed use of the noun.
 */
const PERSONIFICATION_PATTERN = new RegExp(
  `\\b(?:the\\s+writer|the\\s+author|whoever\\s+wrote\\s+(?:this|it|the\\s+\\w+))\\b` +
    `(?:'s)?(?:\\s+[a-zA-Z']+){0,3}?\\s+(?:${ATTRIBUTION_VERBS})\\b`,
  "gi",
);

function bylineNames(text: string): { full: string; name: string }[] {
  return [...text.matchAll(BYLINE_PATTERN)].map((m) => ({ full: m[0], name: m[1] }));
}

/**
 * Cheap, certain, and not a matter of model judgement.
 *
 * `author` is null unless verified. When it IS verified, a byline naming
 * that exact person is fine — the writer was told it may name them — but a
 * byline naming anyone ELSE is exactly the same fabrication as naming an
 * author when none was ever verified (review finding 1: a wrong name is not
 * a lesser problem than no name). `sameName` (case, initials, diacritics)
 * decides the match, not string equality.
 */
export function findAuthorMentions(pkg: ContentPackage, author: string | null): string[] {
  const fields = [
    pkg.title,
    pkg.hook,
    pkg.cta,
    pkg.description,
    ...pkg.beats.flatMap((b) => [b.voiceover, b.onScreen]),
  ];

  const bylines = fields.flatMap((f) => (f ? bylineNames(f) : []));

  if (author) {
    return bylines.filter((b) => !sameName(b.name, author)).map((b) => b.full);
  }

  // No verified author: any named byline, plus any construction that stands
  // in for one, is forbidden.
  const personifications = fields.flatMap((f) => f?.match(PERSONIFICATION_PATTERN) ?? []);
  return [...bylines.map((b) => b.full), ...personifications];
}
