import { runCliJson } from "./cli-provider";
import type { CliProvider } from "./cli";
import { voScriptFromPackage, type ContentPackage, type GenerateInput } from "./schema";
import {
  checkQuotationBudget,
  MAX_SUBFLOOR_SHARE,
  MAX_VERBATIM_SHARE,
  RUN_FLOOR,
  SUBFLOOR_RUN,
} from "./quotation";

function normalizeTokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function findOverlappingRuns(narration: string, sourceTokens: string[], floor: number): string[] {
  const n = normalizeTokens(narration);
  if (n.length === 0 || sourceTokens.length === 0) return [];
  const positions = new Map<string, number[]>();
  sourceTokens.forEach((tok, idx) => {
    const list = positions.get(tok);
    if (list) list.push(idx);
    else positions.set(tok, [idx]);
  });

  const runs: string[] = [];
  for (let i = 0; i < n.length; ) {
    let best = 0;
    for (const start of positions.get(n[i]) ?? []) {
      let len = 0;
      while (i + len < n.length && start + len < sourceTokens.length && n[i + len] === sourceTokens[start + len]) {
        len++;
      }
      if (len > best) best = len;
    }
    if (best >= floor) {
      runs.push(n.slice(i, i + best).join(" "));
      i += best;
    } else {
      i += 1;
    }
  }
  return runs;
}

function buildBeatPassages(draft: ContentPackage, source: string, sourceTokens: string[]): string[][] {
  const fullReport = checkQuotationBudget(voScriptFromPackage(draft), source, "in-copyright");
  const fullExcerpts = fullReport.excerpts;
  const needSubfloor = fullReport.subfloorShare > MAX_SUBFLOOR_SHARE * 0.85 || fullExcerpts.length === 0;

  const perBeat = draft.beats.map((b) => {
    const own = checkQuotationBudget(b.voiceover, source, "in-copyright").excerpts;
    const normBeat = normalizeTokens(b.voiceover).join(" ");
    // Catch cross-beat runs whose start or tail lands inside this beat.
    const crossBeat = fullExcerpts.filter((excerpt) => {
      if (own.includes(excerpt)) return false;
      const words = excerpt.split(/\s+/);
      if (words.length < 3) return false;
      const head = words.slice(0, Math.min(3, words.length)).join(" ");
      const tail = words.slice(Math.max(0, words.length - 3)).join(" ");
      return normBeat.includes(head) || normBeat.includes(tail);
    });
    const subfloor = needSubfloor ? findOverlappingRuns(b.voiceover, sourceTokens, SUBFLOOR_RUN + 1) : [];
    return [...new Set([...own, ...crossBeat, ...subfloor])];
  });

  if (perBeat.every((list) => list.length === 0)) {
    const fallback = fullExcerpts.length > 0
      ? fullExcerpts
      : findOverlappingRuns(voScriptFromPackage(draft), sourceTokens, SUBFLOOR_RUN);
    if (perBeat.length > 0 && fallback.length > 0) {
      perBeat[0] = fallback;
    }
  }

  return perBeat;
}

function coerceVoiceovers(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  let candidate = (raw as { voiceovers?: unknown }).voiceovers;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(candidate)) return null;
  const strings = candidate.map((s) => (typeof s === "string" ? s.trim() : ""));
  if (strings.some((s) => !s)) return null;
  return strings;
}

async function runSingleQuotationRepairPass(
  current: ContentPackage,
  source: string,
  sourceTokens: string[],
  provider: CliProvider,
  model?: string,
): Promise<ContentPackage> {
  const fullReport = checkQuotationBudget(voScriptFromPackage(current), source, "in-copyright");
  const beatPassages = buildBeatPassages(current, source, sourceTokens);
  // Deliberately omit raw `sourcePages`: smaller models (such as gemini-2.5-flash-lite)
  // lifted NEW 5–12 word phrases directly off `sourcePages` while rewriting old ones.
  const input = {
    title: current.title,
    forbiddenPhrases: fullReport.excerpts,
    beats: current.beats.map((b, index) => ({
      index,
      voiceover: b.voiceover,
      sourcePage: b.sourcePage,
      startWord: b.startWord,
      endWord: b.endWord,
      passagesToParaphrase: beatPassages[index],
    })),
  };
  const result = await runCliJson<{ voiceovers: string[] }>(
    provider,
    `You write paraphrased narration to repair excessive verbatim passages. Return one replacement voiceover per input beat, in the same order.
Paraphrase EVERY listed passage in passagesToParaphrase and forbiddenPhrases from its meaning, using a completely new sentence structure, fresh clause order, and everyday spoken wording. Aim for ZERO verbatim runs of ${RUN_FLOOR}+ words (and break up 4-word chains too); the final aggregate limit remains ${MAX_VERBATIM_SHARE * 100}%. Do not retain a short quote as a shortcut, and do not merely swap one synonym inside an existing phrase.
Keep the exact same factual meaning, numbers, beat purpose, and approximately the same spoken length as each beat's current voiceover. Never invent new claims, examples, or statistics not already present in the beat's voiceover, and never pad narration to dilute the percentage. Remove quotation marks and direct-quotation introductions when paraphrasing. Keep a clean closing request (such as "Follow BookReel...") unchanged. Do not change metadata, beat order or source references. The repaired narration will undergo the original quotation, length, author and grounding checks.`,
    JSON.stringify(input),
    {
      type: "object",
      required: ["voiceovers"],
      additionalProperties: false,
      properties: {
        voiceovers: {
          type: "array",
          minItems: current.beats.length,
          maxItems: current.beats.length,
          items: { type: "string" },
        },
      },
    },
    model,
  );

  // CLI JSON schemas are instructions, not runtime validation.
  const voiceovers = coerceVoiceovers(result);
  if (!voiceovers || voiceovers.length !== current.beats.length) {
    throw new Error("Quotation repair returned invalid narration; the draft was not accepted.");
  }
  return {
    ...current,
    beats: current.beats.map((b, i) => ({ ...b, voiceover: voiceovers[i] })),
  };
}

/** A constrained repair: the model can replace narration, never metadata or citations. */
export async function repairQuotation(
  draft: ContentPackage,
  pages: GenerateInput["pages"],
  provider: CliProvider,
  model?: string,
): Promise<ContentPackage> {
  const source = pages.map((p) => p.words.join(" ")).join(" ");
  const sourceTokens = normalizeTokens(source);

  const firstPass = await runSingleQuotationRepairPass(draft, source, sourceTokens, provider, model);
  const afterFirst = checkQuotationBudget(voScriptFromPackage(firstPass), source, "in-copyright");
  const changed = firstPass.beats.some((b, i) => b.voiceover.trim() !== draft.beats[i].voiceover.trim());

  // If the model made progress on pass 1 but left 1–2 lingering 5-word echoes,
  // run one targeted follow-up pass immediately before spending another outer gate round.
  if (!afterFirst.withinBudget && changed) {
    return runSingleQuotationRepairPass(firstPass, source, sourceTokens, provider, model);
  }
  return firstPass;
}
