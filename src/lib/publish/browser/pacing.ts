import type { EnvLike } from "../youtube/secrets";
import type { LocatorLike, PageLike } from "./engine";

/** Bounds for the shuffled per-video upload duration loop: 2m 45s to 3m 45s. */
export const MIN_UPLOAD_PACE_MS = 165_000;
export const MAX_UPLOAD_PACE_MS = 225_000;
export const DEFAULT_UPLOAD_PACE_MS = 180_000;

/**
 * Distinct per-video upload target durations spanning 2m 45s (165,000 ms) to 3m 45s (225,000 ms).
 * Cycled with coprime stride permutations across passes so consecutive videos always take
 * varied durations within [2m 45s, 3m 45s] and never repeat flatly.
 */
export const UPLOAD_PACE_RING_MS: readonly number[] = [
  180_000, // 3m 00s
  210_000, // 3m 30s
  175_000, // 2m 55s
  222_000, // 3m 42s
  165_000, // 2m 45s
  198_000, // 3m 18s
  171_000, // 2m 51s
  225_000, // 3m 45s
  188_000, // 3m 08s
  204_000, // 3m 24s
  168_000, // 2m 48s
  216_000, // 3m 36s
];

const COPRIME_STRIDES = [1, 5, 7, 11] as const;

interface PaceLoopState {
  step: number;
  lastMs: number | null;
}

const g = globalThis as unknown as { bookreelUploadPaceState?: PaceLoopState };
const loopState = (): PaceLoopState => (g.bookreelUploadPaceState ??= { step: 0, lastMs: null });

/** Pick the k-th duration from the shuffled 2m 45s – 3m 45s ring, permuting each full pass. */
export function shuffledRingDurationAt(step: number, previousMs: number | null = null): number {
  const n = UPLOAD_PACE_RING_MS.length;
  const safeStep = Math.max(0, Math.floor(step));
  const round = Math.floor(safeStep / n);
  const pos = safeStep % n;
  const stride = COPRIME_STRIDES[round % COPRIME_STRIDES.length];
  const baseOffset = (round * 3) % n;
  const firstOfRound = UPLOAD_PACE_RING_MS[baseOffset];
  const offset = pos === 0 && previousMs !== null && firstOfRound === previousMs ? (baseOffset + 1) % n : baseOffset;
  const idx = (offset + pos * stride) % n;
  return UPLOAD_PACE_RING_MS[idx];
}

export function resetUploadPaceLoopForTests(): void {
  const s = loopState();
  s.step = 0;
  s.lastMs = null;
}

export function formatPaceDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export interface PacingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultPacingClock: PacingClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/**
 * Check whether upload pacing is active without advancing the shuffled loop counter.
 */
export function targetUploadDurationMs(env: EnvLike = process.env, hasTestSeam = false): number {
  const raw = env.BOOKREEL_UPLOAD_PACE_MS?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if (raw === "loop" || raw === "shuffle") {
      const s = loopState();
      return shuffledRingDurationAt(s.step, s.lastMs);
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  }
  if (hasTestSeam || Boolean(process.env.BOOKREEL_TEST_DB_PID) || Boolean(process.env.NODE_TEST_CONTEXT)) {
    return 0;
  }
  const s = loopState();
  return shuffledRingDurationAt(s.step, s.lastMs);
}

/**
 * Advance the shuffled 2m 45s – 3m 45s loop once for a new video upload and return its target duration.
 */
export function nextUploadDurationMs(env: EnvLike = process.env, hasTestSeam = false): number {
  const raw = env.BOOKREEL_UPLOAD_PACE_MS?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if (raw === "loop" || raw === "shuffle") {
      const s = loopState();
      const chosen = shuffledRingDurationAt(s.step, s.lastMs);
      s.step += 1;
      s.lastMs = chosen;
      return chosen;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  }
  if (hasTestSeam || Boolean(process.env.BOOKREEL_TEST_DB_PID) || Boolean(process.env.NODE_TEST_CONTEXT)) {
    return 0;
  }
  const s = loopState();
  const chosen = shuffledRingDurationAt(s.step, s.lastMs);
  s.step += 1;
  s.lastMs = chosen;
  return chosen;
}

export function isUploadPacingEnabled(env: EnvLike = process.env, hasTestSeam = false): boolean {
  return targetUploadDurationMs(env, hasTestSeam) > 0;
}

function paceScaleForTarget(targetMs: number): number {
  if (targetMs <= 0) return 0;
  return Math.min(2, Math.max(0.1, targetMs / DEFAULT_UPLOAD_PACE_MS));
}

/** Deterministic stage pause scaled to the current video's upload pace; no-op when pacing is off. */
export async function pacedWait(
  clock: PacingClock,
  ms: number,
  env: EnvLike = process.env,
  hasTestSeam = false,
  targetMs?: number,
): Promise<number> {
  const resolvedTarget = targetMs ?? targetUploadDurationMs(env, hasTestSeam);
  const scale = paceScaleForTarget(resolvedTarget);
  if (scale <= 0 || ms <= 0) return 0;
  const duration = Math.max(50, Math.round(ms * scale));
  await clock.sleep(duration);
  return duration;
}

/**
 * Split text into deterministic word and newline tokens so fields populate progressively
 * word-by-word instead of pasting an entire paragraph in one millisecond.
 */
export function splitPacedTokens(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  const parts = value.split(/(\r?\n)/);
  for (const part of parts) {
    if (!part) continue;
    if (part === "\n" || part === "\r\n") {
      out.push("\n");
      continue;
    }
    const words = part.match(/\S+[ \t]*|[ \t]+/g);
    if (words) out.push(...words);
  }
  return out;
}

/** Deterministic pause after typing a single token, scaled to the current video's pace. */
export function tokenPauseMs(
  token: string,
  env: EnvLike = process.env,
  hasTestSeam = false,
  targetMs?: number,
): number {
  const resolvedTarget = targetMs ?? targetUploadDurationMs(env, hasTestSeam);
  const scale = paceScaleForTarget(resolvedTarget);
  if (scale <= 0) return 0;
  if (token === "\n") return Math.round(650 * scale);
  const trimmed = token.trim();
  if (!trimmed) return Math.round(180 * scale);
  const base = 260 + Math.min(240, trimmed.length * 26);
  const punctuationBonus = /[.!?:;,]$/.test(trimmed) ? 420 : 0;
  return Math.round((base + punctuationBonus) * scale);
}

const squashText = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

async function readFieldCurrentText(field: LocatorLike, timeoutMs: number): Promise<string> {
  const inputVal = await field.inputValue({ timeout: Math.min(3_000, timeoutMs) }).catch(() => null);
  if (inputVal !== null && inputVal !== "") return inputVal;
  const inner = await field.innerText({ timeout: Math.min(3_000, timeoutMs) }).catch(() => "");
  return inner || (inputVal ?? "");
}

/**
 * Populate a form field calmly word-by-word when upload pacing is enabled,
 * then verify the full text is present cleanly. When pacing is disabled (unit tests),
 * performs a single direct `fill`.
 */
export async function pacedFillField(options: {
  page: PageLike;
  selector: string;
  value: string;
  clock?: PacingClock;
  env?: EnvLike;
  hasTestSeam?: boolean;
  targetMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const {
    page,
    selector,
    value,
    clock = defaultPacingClock,
    env = process.env,
    hasTestSeam = false,
    targetMs,
    timeoutMs = 20_000,
  } = options;
  const resolvedTarget = targetMs ?? targetUploadDurationMs(env, hasTestSeam);
  const field = page.locator(selector).first();
  if (resolvedTarget <= 0 || value.length === 0) {
    await field.fill(value, { timeout: timeoutMs });
    return;
  }

  await field.click({ timeout: timeoutMs }).catch(() => {});
  await pacedWait(clock, 750, env, hasTestSeam, resolvedTarget);
  await field.fill("", { timeout: timeoutMs });
  await pacedWait(clock, 350, env, hasTestSeam, resolvedTarget);

  const tokens = splitPacedTokens(value);
  const kb = page.keyboard as unknown as {
    press(key: string): Promise<unknown>;
    insertText?: (text: string) => Promise<unknown>;
  };

  if (typeof kb.insertText === "function") {
    for (const token of tokens) {
      if (token === "\n") {
        await kb.press("Shift+Enter");
      } else {
        await kb.insertText(token);
      }
      const waitMs = tokenPauseMs(token, env, hasTestSeam, resolvedTarget);
      if (waitMs > 0) await clock.sleep(waitMs);
    }
    const after = await readFieldCurrentText(field, timeoutMs);
    if (squashText(after) !== squashText(value)) {
      await field.fill(value, { timeout: timeoutMs });
    }
  } else {
    let progressive = "";
    for (const token of tokens) {
      progressive += token;
      await field.fill(progressive, { timeout: timeoutMs });
      const waitMs = tokenPauseMs(token, env, hasTestSeam, resolvedTarget);
      if (waitMs > 0) await clock.sleep(waitMs);
    }
  }

  await pacedWait(clock, 850, env, hasTestSeam, resolvedTarget);
}

/**
 * Ensure the overall single-video upload & form-filling flow spans this video's
 * chosen target duration (from the 2m 45s – 3m 45s shuffled loop) before clicking
 * the final Schedule / Publish / Share button, while respecting any schedule lead cutoff.
 */
export async function ensureUploadDuration(options: {
  clock?: PacingClock;
  startedAtMs: number;
  env?: EnvLike;
  hasTestSeam?: boolean;
  targetMs?: number;
  platformLabel: string;
  log?: (message: string) => void;
  scheduledAt?: Date | null;
  minScheduleLeadMs?: number;
}): Promise<number> {
  const {
    clock = defaultPacingClock,
    startedAtMs,
    env = process.env,
    hasTestSeam = false,
    targetMs,
    platformLabel,
    log,
    scheduledAt = null,
    minScheduleLeadMs = 0,
  } = options;

  const resolvedTarget = targetMs ?? nextUploadDurationMs(env, hasTestSeam);
  if (resolvedTarget <= 0) return 0;

  const nowMs = clock.now();
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  let remainingMs = Math.max(0, resolvedTarget - elapsedMs);

  if (scheduledAt && Number.isFinite(scheduledAt.getTime()) && minScheduleLeadMs > 0) {
    const safeLeadMarginMs = minScheduleLeadMs + 60_000;
    const maxSafeWaitMs = Math.max(0, scheduledAt.getTime() - nowMs - safeLeadMarginMs);
    remainingMs = Math.min(remainingMs, maxSafeWaitMs);
  }

  if (remainingMs <= 0) return 0;

  log?.(
    `${platformLabel}: reviewing filled form details for ${Math.ceil(remainingMs / 1000)}s to reach this video's ${formatPaceDuration(resolvedTarget)} upload pace before submitting`,
  );

  let waited = 0;
  let left = remainingMs;
  while (left > 0) {
    const step = Math.min(left, 5_000);
    await clock.sleep(step);
    waited += step;
    left -= step;
  }
  return waited;
}
