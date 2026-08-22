import { runCliVisionJson } from "../content/cli-vision";
import { CliError, type CliProvider } from "../content/cli";

export interface PageText {
  pageIndex: number;
  chapterHeading: string | null;
  paragraphs: string[];
  legible: boolean;
  /** Why a page could not be read, when `legible` is false. */
  note: string | null;
}

export const PAGE_TEXT_SCHEMA = {
  type: "object",
  required: ["chapterHeading", "paragraphs", "legible", "note"],
  additionalProperties: false,
  properties: {
    chapterHeading: { type: ["string", "null"] },
    paragraphs: { type: "array", items: { type: "string" }, minItems: 0 },
    legible: { type: "boolean" },
    note: { type: ["string", "null"] },
  },
} as const;

const SYSTEM = `You transcribe a photographed page of a printed book.

Transcribe the body text exactly as printed, paragraph by paragraph, in
reading order. Do not summarise, correct, modernise or improve the wording.

Rules:
- Running heads, page numbers and footnote markers are not body text. Leave them out.
- A chapter or section heading goes in chapterHeading, never in paragraphs.
- When a word is split across a printed line by a hyphen, reproduce it exactly
  as it appears on the page: the first fragment, a hyphen, an ACTUAL newline
  character, then the second fragment (for example "con-\\ntration"). Do not
  join the fragments into one unbroken word and do not drop the hyphen.
- If the photograph is too blurred, cropped or dark to read with confidence,
  set legible to false and say why in note rather than guessing at the words.`;

/**
 * `words` is DERIVED here rather than asked for, so the token stream is a pure
 * function of the transcription. Asking the model for both invites the two to
 * disagree, and every downstream index — the alignment, the highlight, the
 * sweep timing — is an index into this array.
 */
export function wordsOf(text: PageText): string[] {
  return text.paragraphs
    .flatMap((p) =>
      p
        // A hyphen at a line break is a typesetting artefact, not part of the
        // word. Left in, the marker sweeps half a word and stops.
        .replace(/-\s*\n\s*/g, "")
        .split(/\s+/),
    )
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * A hyphenated line break ("con-\ntration") and an ordinary compound word
 * ("well-known") are structurally identical once the model drops the
 * newline — the newline is the only signal that distinguishes them, so a
 * dropped one cannot be repaired, only flagged. Rewriting every "x-y" token
 * would silently mangle real compounds ("mother-in-law", "twenty-two"), which
 * is worse than doing nothing.
 *
 * So this only detects a paragraph that has no line break in it at all but
 * still contains a lowercase-hyphen-lowercase token — the shape a genuine
 * mid-word break would have taken had the newline survived. It cannot tell a
 * false alarm (a real compound) from a real miss, which is exactly why it
 * surfaces as an advisory `note` rather than an automatic rewrite: a wrong
 * transcription that announces itself is recoverable, a silent one is not.
 */
function suspiciousHyphens(paragraphs: string[]): string[] {
  const found = new Set<string>();
  for (const p of paragraphs) {
    if (p.includes("\n")) continue; // already carries a recorded line break
    for (const m of p.matchAll(/\b[a-z]+-[a-z]+\b/g)) found.add(m[0]);
  }
  return [...found];
}

/**
 * Validates the model's raw parsed reply and turns it into a `PageText`, or
 * throws a named `CliError` describing exactly what was wrong. Kept separate
 * from `readPage` (which makes the actual CLI call) so it is testable without
 * spending a real CLI turn.
 *
 * Two failure shapes matter differently:
 * - No `paragraphs` key at all is a protocol failure — the model did not even
 *   attempt the contract, so this throws rather than defaulting to `[]`,
 *   which would make a garbage reply indistinguishable from a blank page.
 * - An empty `paragraphs` array is a legitimate reading of a blank page and
 *   is returned as-is, not treated as an error.
 * A non-string element anywhere in `paragraphs` also throws by name, instead
 * of surviving into `wordsOf` where `p.replace` would crash on it unnamed.
 */
export function parsePageText(raw: unknown, pageIndex: number): PageText {
  if (raw === null || typeof raw !== "object") {
    throw new CliError(
      `The page-reading reply was not a JSON object (got ${raw === null ? "null" : typeof raw}).`,
    );
  }
  const obj = raw as Record<string, unknown>;

  if (!("paragraphs" in obj)) {
    throw new CliError(
      "The page-reading reply had no `paragraphs` key at all — that looks like a protocol failure, not a blank page.",
    );
  }
  if (!Array.isArray(obj.paragraphs)) {
    throw new CliError(
      `The page-reading reply's \`paragraphs\` was not an array (got ${typeof obj.paragraphs}).`,
    );
  }
  const paragraphs = obj.paragraphs.map((p, i) => {
    if (typeof p !== "string") {
      throw new CliError(
        `The page-reading reply's paragraph ${i} was not a string (got ${typeof p}).`,
      );
    }
    return p;
  });

  const chapterHeading = typeof obj.chapterHeading === "string" ? obj.chapterHeading : null;
  const legible = obj.legible !== false;
  const modelNote = typeof obj.note === "string" ? obj.note : null;

  const suspects = suspiciousHyphens(paragraphs);
  const anomaly =
    suspects.length > 0
      ? `Possible lost line-break hyphen(s), unverifiable against the photograph: ${suspects.join(", ")}.`
      : null;

  return {
    pageIndex,
    chapterHeading,
    paragraphs,
    legible,
    note: [modelNote, anomaly].filter(Boolean).join(" ") || null,
  };
}

/**
 * Reads one page photograph with the vision-capable CLI path.
 *
 * `imagePath` is expected to be the 1600px `derivedPath` produced at upload,
 * not the full-resolution original: the model downsamples anything past
 * ~1568px on the long edge anyway, so passing the original buys no accuracy
 * and costs a much larger copy into the scratch directory per page. `readPage`
 * itself does not care which path it is given — this is a note for the
 * pipeline call site, not a constraint enforced here.
 */
export async function readPage(
  imagePath: string,
  pageIndex: number,
  provider: CliProvider,
  model?: string,
): Promise<PageText> {
  const raw = await runCliVisionJson<unknown>(
    provider,
    SYSTEM,
    `Transcribe this page.`,
    [imagePath],
    PAGE_TEXT_SCHEMA,
    model,
  );

  return parsePageText(raw, pageIndex);
}
