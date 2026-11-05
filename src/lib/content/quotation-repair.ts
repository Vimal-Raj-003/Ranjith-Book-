import { runCliJson } from "./cli-provider";
import type { CliProvider } from "./cli";
import type { ContentPackage, GenerateInput } from "./schema";
import { checkQuotationBudget, MAX_VERBATIM_SHARE, RUN_FLOOR } from "./quotation";

/** A constrained repair: the model can replace narration, never metadata or citations. */
export async function repairQuotation(
  draft: ContentPackage,
  pages: GenerateInput["pages"],
  provider: CliProvider,
  model?: string,
): Promise<ContentPackage> {
  const source = pages.map((p) => p.words.join(" ")).join(" ");
  const input = {
    title: draft.title,
    sourcePages: pages,
    beats: draft.beats.map((b, index) => ({
      index, voiceover: b.voiceover, sourcePage: b.sourcePage,
      startWord: b.startWord, endWord: b.endWord,
      passagesToParaphrase: checkQuotationBudget(b.voiceover, source, "in-copyright").excerpts,
    })),
  };
  const result = await runCliJson<{ voiceovers: string[] }>(provider,
    `You write paraphrased narration to repair excessive verbatim passages. Return one replacement voiceover per input beat, in the same order.
Paraphrase EVERY listed passage from its meaning, using a new sentence structure. Aim for ZERO verbatim runs of ${RUN_FLOOR}+ words; the final aggregate limit remains ${MAX_VERBATIM_SHARE * 100}%. Do not retain a short quote as a shortcut.
Keep the same factual meaning, beat purpose, and approximately the same spoken length. Use only the supplied source. Never add claims or pad narration to dilute the percentage. Remove quotation marks and direct-quotation introductions when paraphrasing. Keep a clean closing request unchanged. Do not change metadata, beat order or source references. The repaired narration will undergo the original quotation, length, author and grounding checks.`,
    JSON.stringify(input), {
      type: "object", required: ["voiceovers"], additionalProperties: false,
      properties: { voiceovers: { type: "array", minItems: draft.beats.length, maxItems: draft.beats.length, items: { type: "string" } } },
    }, model);
  // CLI JSON schemas are instructions, not runtime validation.
  if (!Array.isArray(result?.voiceovers) || result.voiceovers.length !== draft.beats.length ||
      result.voiceovers.some((s) => typeof s !== "string" || !s.trim())) {
    throw new Error("Quotation repair returned invalid narration; the draft was not accepted.");
  }
  return { ...draft, beats: draft.beats.map((b, i) => ({ ...b, voiceover: result.voiceovers[i] })) };
}
