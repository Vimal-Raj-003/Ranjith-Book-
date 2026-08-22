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

3. WORD-INDEX GROUNDING — answer this SEPARATELY from everything else, in the "indicesGrounded" field. For every beat, read its voiceover, then read the page's numbered words at that beat's sourcePage between startWord and endWord. Ask: are these actually the words this beat is talking about? An index range can be in-bounds and forward-moving and still be wrong — it can point at the wrong sentence, a neighboring paragraph, or words several lines away from what the beat actually discusses. That mismatch is invisible to any check that only looks at the numbers; it is only visible to a reader who reads both the beat and the words. Set "indicesGrounded" to false if even one beat's range does not match what it is actually about, and name the beat in "issues" as a blocker. Also confirm ranges move forward across beats that share a page — a later beat pointing at earlier words than a beat before it is also a blocker here.

4. NO AUTHOR NAMED. Set "authorNamed" to true if the script names an author, or stands in for one with any unnamed authorial figure — "the writer", "the author" used generically, "whoever wrote this", or any other construction that attributes belief, argument, or intent to a person behind the page. You will be told whether the author is verified. If the author is NOT verified, any such mention — named or unnamed — is a blocker. If the author IS verified, the verified name may appear and is not itself a problem, but a DIFFERENT name, or a generic unnamed stand-in, is still a blocker.

5. HOOK DISTINCTNESS. The hook must not repeat any of the previously used hooks supplied to you, in wording or in angle.

6. SPEAKABLE VOICEOVER. Every beat's voiceover is read aloud by a neural speech engine, one beat at a time: no markdown, no bracketed or parenthetical stage directions, no emoji, no URLs, no hashtags, nothing a speech engine would mangle.

Set verdict to "revise" if there is any blocker anywhere, including a false "indicesGrounded" or a true "authorNamed" on an unverified book. Warnings ("note" severity) alone are still a "pass". Be specific in every issue: name the field ("beats[2].voiceover", "beats[1].wordRange", "hook") and say exactly what is wrong. Do not rewrite the script yourself. groundedness is 0-100 for how well the whole script is supported by the source pages.`;

function buildPrompt(
  pkg: ContentPackage,
  pages: GenerateInput["pages"],
  avoidHooks: string[],
  authorVerified: boolean,
): string {
  const pageText = pages
    .map((p) => {
      const heading = p.chapterHeading ? `Heading: ${p.chapterHeading}\n` : "";
      return `--- PAGE ${p.pageIndex} ---\n${heading}${numberedWordLines(p.words)}`;
    })
    .join("\n\n");

  return [
    `AUTHOR VERIFIED: ${authorVerified ? "yes — the verified name may appear" : "no — the script must name no one, and no unnamed stand-in either"}`,
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
 * names someone outright.
 */
const BYLINE_PATTERN =
  /\b(?:by|written by|author(?:ed)? by|penned by)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.]+)+/g;

/**
 * The prompt (see `./prompt`'s no-author branch) forbids more than a name:
 * "the writer believes second chances matter" never names anyone, but it
 * still invents a person behind the page and asserts what they believe —
 * the same fabrication with the name filed off. This matches the exact
 * unnamed-authorial-figure constructions the prompt calls out: "the writer",
 * "the author" used as a generic stand-in, and "whoever wrote this/it/the
 * page/the book". Word-boundaries keep it from firing on "authority", which
 * contains "author" as a substring but is not a mention of one.
 */
const PERSONIFICATION_PATTERN =
  /\b(?:the\s+writer|the\s+author|whoever\s+wrote\s+(?:this|it|the\s+\w+))\b/gi;

/** Cheap, certain, and not a matter of model judgement. */
export function findAuthorMentions(pkg: ContentPackage, author: string | null): string[] {
  if (author) return [];
  const fields = [
    pkg.title,
    pkg.hook,
    pkg.cta,
    pkg.description,
    ...pkg.beats.flatMap((b) => [b.voiceover, b.onScreen]),
  ];
  return fields.flatMap((f) => [
    ...(f?.match(BYLINE_PATTERN) ?? []),
    ...(f?.match(PERSONIFICATION_PATTERN) ?? []),
  ]);
}
