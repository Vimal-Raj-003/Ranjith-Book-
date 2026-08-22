import { runCliVisionJson } from "../content/cli-vision";
import type { CliProvider } from "../content/cli";

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
  const raw = await runCliVisionJson<Omit<PageText, "pageIndex">>(
    provider,
    SYSTEM,
    `Transcribe this page.`,
    [imagePath],
    PAGE_TEXT_SCHEMA,
    model,
  );

  return {
    pageIndex,
    chapterHeading: raw.chapterHeading ?? null,
    paragraphs: Array.isArray(raw.paragraphs) ? raw.paragraphs : [],
    legible: raw.legible !== false,
    note: raw.note ?? null,
  };
}
