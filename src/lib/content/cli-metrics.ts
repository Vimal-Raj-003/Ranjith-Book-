/**
 * What every model call cost: wall time, time inside the API, tokens in and
 * out, and which episode and step it belonged to.
 *
 * Written because "script generation is slow" had no numbers behind it. The
 * CLI reports all of this in its JSON envelope; it was being thrown away.
 * Profiling it showed where the minutes go — not process start-up, not
 * reading the pages, but the model's reasoning: ~95% of a writer call's output
 * tokens are thinking. Each call is appended to
 * `.bookreel/logs/model-calls.jsonl`; `scripts/profile-model-calls.mjs`
 * summarises it.
 *
 * The episode and step come from `callContext` (AsyncLocalStorage), set by
 * the pipeline around its work, so no call signature had to change.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "../paths";

export interface CallContext {
  episodeId?: string;
  uploadId?: string;
  step?: string;
}

export const callContext = new AsyncLocalStorage<CallContext>();

export const METRICS_FILE = path.join(WORK_ROOT, "logs", "model-calls.jsonl");

export interface CallMetrics {
  at: string;
  kind: string;
  episodeId?: string;
  uploadId?: string;
  step?: string;
  ok: boolean;
  wallMs: number;
  apiMs: number | null;
  inputTokens: number | null;
  cacheCreateTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  /** Characters of the answer actually returned — output tokens beyond it are reasoning. */
  resultChars: number;
  costUsd: number | null;
  models: string[];
  error?: string;
}

/** Which of the pipeline's prompts this is, from the system prompt's opening. */
export function callKind(system: string): string {
  const s = system.trimStart();
  if (s.startsWith("You write")) return "script-writer";
  if (s.startsWith("You are an adversarial checker")) return "author-check";
  if (/adversarial|grounding|fact-check/i.test(s.slice(0, 400))) return "grounding-check";
  if (s.startsWith("You transcribe")) return "page-reader";
  if (s.startsWith("You are a senior editor")) return "idea-finder";
  if (s.startsWith("You are the commissioning editor")) return "idea-ranker";
  if (s.startsWith("You split")) return "episode-planner";
  return "other";
}

interface Envelope {
  result?: string;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/** Best-effort: a metrics write that fails must never fail the call it describes. */
export async function recordCall(kind: string, wallMs: number, envelope: Envelope | null, error?: string): Promise<void> {
  const ctx = callContext.getStore() ?? {};
  const u = envelope?.usage ?? {};
  const m: CallMetrics = {
    at: new Date().toISOString(),
    kind,
    ...ctx,
    ok: !error,
    wallMs,
    apiMs: envelope?.duration_api_ms ?? null,
    inputTokens: u.input_tokens ?? null,
    cacheCreateTokens: u.cache_creation_input_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    resultChars: typeof envelope?.result === "string" ? envelope.result.length : 0,
    costUsd: envelope?.total_cost_usd ?? null,
    models: Object.keys(envelope?.modelUsage ?? {}),
    ...(error ? { error: error.slice(0, 300) } : {}),
  };
  try {
    await fs.mkdir(path.dirname(METRICS_FILE), { recursive: true });
    await fs.appendFile(METRICS_FILE, JSON.stringify(m) + "\n");
  } catch {
    /* see doc comment */
  }
}
