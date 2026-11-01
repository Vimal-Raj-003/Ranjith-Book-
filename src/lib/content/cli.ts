import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
import { callKind, recordCall } from "./cli-metrics";
import { abortOpts, wasCancelled, CancelledError } from "../cancel";
import { DEFAULT_GEMINI_MODEL_ID, GEMINI_MODELS, type GeminiModelId } from "../strings";

/**
 * Environment variables that redirect the Claude CLI away from its signed-in
 * desktop subscription (`~/.claude/.credentials.json`) toward an external API
 * key or local proxy (e.g. `ANTHROPIC_BASE_URL=http://localhost:11434/v1`,
 * `ANTHROPIC_API_KEY=ollama`, `ANTHROPIC_MODEL=qwen2.5-coder:7b`).
 *
 * Because `claude-cli` is explicitly the subscription-backed provider, any
 * ambient API-key / base-URL / model overrides in the parent shell must be
 * stripped before spawning `claude`. We also disable remote claude.ai MCP
 * servers (`ENABLE_CLAUDEAI_MCP_SERVERS=false`), which Claude Code v2.1+
 * otherwise connects to even under `--strict-mcp-config --tools ""`, injecting
 * hundreds of thousands of MCP tool tokens into headless calls.
 */
const STRIPPED_ANTHROPIC_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

export function cleanEnv(base: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of STRIPPED_ANTHROPIC_ENV_VARS) {
    delete env[key];
  }
  env.ENABLE_CLAUDEAI_MCP_SERVERS ??= "false";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= "1";
  return env as NodeJS.ProcessEnv;
}

/**
 * Run a command, optionally writing the prompt to stdin. Prompts carry a whole
 * README, so they go through stdin rather than argv.
 *
 * Exported so the vision-capable sibling in `./cli-vision` can reuse this
 * spawn/timeout/SIGKILL plumbing instead of forking a second copy of it.
 */
export function run(
  bin: string,
  args: string[],
  opts: { cwd: string; input?: string; timeoutMs: number; idleMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  // `timeoutMs` below is a hard ceiling on the WHOLE call, unconditional and
  // unrelated to cancellation: `abortOpts()` is a SEPARATE, faster way out —
  // an operator cancelling the episode this call belongs to — and Node kills
  // the same child the same way (SIGKILL) the instant it fires, rather than
  // waiting out however much of the ceiling is left.
  //
  // `idleMs`, when given, is the other watchdog: kill the child once it has
  // written NOTHING (stdout or stderr) for that long. A wall-clock ceiling
  // alone cannot tell a dead process from a slow one — and a call that
  // buffers its whole answer until the end (`--output-format json`) looks
  // identical in both cases. A streaming caller can, which is why this exists.
  const cancel = abortOpts();
  if (cancel.signal?.aborted) return Promise.reject(new CancelledError());

  // A "binary" that is really a JavaScript file is run through this very Node.
  // POSIX makes such a file spawnable with a `#!/usr/bin/env node` shebang and
  // the execute bit; Windows honours neither, and `spawn` fails with the rather
  // unhelpful `EFTYPE`. That is not hypothetical — the generate-content tests
  // point CLAUDE_CLI_BIN at a .mjs fixture, which worked on POSIX and failed
  // every one of those tests on Windows. Resolving it here, at the single spawn
  // site, keeps the override portable for any caller that wants to name a JS
  // wrapper, the same spirit as `cliBin`'s existing .cmd/.exe handling below.
  if (/\.[cm]?js$/i.test(bin)) {
    args = [bin, ...args];
    bin = process.execPath;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      // See `hf()` in video/render.ts: without this the CLI flashes a console
      // window onto the desktop on every call, rewrites included.
      windowsHide: true,
      ...cancel,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastActivity = Date.now();
    let idleTimer: ReturnType<typeof setInterval> | null = null;

    const giveUp = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      child.kill("SIGKILL");
      // Whatever the process had written before it was killed is the only
      // forensic trail a hang leaves — previously discarded, so a timeout and
      // a process that produced literally nothing looked identical in the
      // logs. Tail-truncated (not head) because a JSON-mode reply, if any
      // ever started, would have its most telling content — the cutoff point
      // — at the end.
      const tail = (s: string, n = 500) => (s.length > n ? `…${s.slice(-n)}` : s);
      const collected = [
        stdout.trim() ? `stdout: ${tail(stdout.trim())}` : null,
        stderr.trim() ? `stderr: ${tail(stderr.trim())}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      reject(new CliError(`${bin} ${reason}` + (collected ? ` (${collected})` : " (no output was produced before it was killed)")));
    };

    const timer = setTimeout(() => giveUp(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);

    if (opts.idleMs) {
      const idleMs = opts.idleMs;
      idleTimer = setInterval(() => {
        if (Date.now() - lastActivity >= idleMs) giveUp(`went silent for ${Math.round(idleMs / 1000)}s`);
      }, Math.max(20, Math.min(2000, Math.floor(idleMs / 4))));
    }

    child.stdout.on("data", (d) => {
      lastActivity = Date.now();
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now();
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      // Node kills the child and emits this the instant `cancel.signal`
      // aborts — before `close`, so this is the reliable place to catch it
      // rather than trying to tell a real spawn failure apart from a kill by
      // exit code alone.
      reject(wasCancelled() ? new CancelledError() : new CliError(`${bin} could not be started: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      // A non-zero exit is not always a failure: the Claude CLI exits 1 when it
      // stops on a turn limit even though it already produced a full answer.
      // Let the caller inspect stdout before deciding. `wasCancelled()` first,
      // in case a SIGKILL from the abort reached `close` before `error` did.
      if (wasCancelled()) reject(new CancelledError());
      else if (code === 0 || stdout.trim()) resolve({ stdout, stderr });
      else reject(new CliError(`${bin} exited with code ${code}: ${stderr.slice(-400) || "no output"}`));
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Subscription-backed providers. These shell out to the Claude Code or Codex
 * CLI, which authenticate with the desktop login rather than an API key — so the
 * app works with no key at all, as long as one of those CLIs is signed in.
 */
export type CliProvider = "claude-cli" | "codex-cli" | "gemini";
export const CLI_PROVIDERS: readonly CliProvider[] = ["claude-cli", "codex-cli", "gemini"];

/** Strictly parse a provider name (accepting both canonical IDs and short aliases). */
export function parseProvider(raw: unknown): CliProvider | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "claude-cli" || v === "claude") return "claude-cli";
  if (v === "codex-cli" || v === "codex") return "codex-cli";
  if (v === "gemini" || v === "gemini-cli") return "gemini";
  return null;
}

/** Resolve any stored or environment provider value to a valid CliProvider (defaults to server default or claude-cli). */
export function resolveProvider(raw?: unknown): CliProvider {
  return parseProvider(raw) ?? parseProvider(process.env.BOOKREEL_CLI_PROVIDER) ?? "claude-cli";
}

const TIMEOUT_MS = 6 * 60_000;

/**
 * Claude's watchdogs, and why they are not one fixed 6-minute clock.
 *
 * The script writer runs with extended thinking, and how long that thinking
 * lasts varies enormously by prompt: 22 successful writer calls in
 * `model-calls.jsonl` finished in 150–200s, while one captured with streaming
 * events on thought continuously (3,275 events) for ~400s before writing a
 * word of its answer — and the same prompt was still thinking at 660s on
 * another run. A fixed 360s kill took those calls — alive and progressing —
 * for hangs, and reported "no output was produced" only because
 * `--output-format json` buffers everything until the end. Real episodes
 * failed this way ~1 time in 5, one idea four times in a row.
 *
 * So the call streams events, and `CLAUDE_IDLE_MS` — silence, not elapsed
 * time — is what proves it dead: thinking emits several events a second, so
 * 150s without ANY byte is a stalled connection, now caught in 150s instead
 * of 360s. The absolute ceiling remains only as a backstop for a call that is
 * alive but never finishes, and it differs by kind for a reason:
 *
 *  - the WRITER gets `WRITER_CEILING_MS`. Its depth is what keeps a draft
 *    inside the page (see `WRITER_EFFORT_LEVELS`), so it must be allowed to
 *    finish. It only ever runs inside an episode, and `reap.ts` leaves an
 *    episode this process is still running alone however long it takes.
 *  - everything else keeps `CLAUDE_CEILING_MS`, under `reap.ts`'s 12-minute
 *    stale cutoff: book analysis runs its calls inside an upload, and the
 *    upload branch of the reaper does not exempt a live run, so a single
 *    call outliving that cutoff would have its upload closed out as dead.
 */
export const CLAUDE_IDLE_MS = 150_000;
export const CLAUDE_CEILING_MS = 11 * 60_000;
export const WRITER_CEILING_MS = 25 * 60_000;
/**
 * The writer's silence allowance. Opus (the model episode calls are pinned to) does
 * NOT stream its thinking: the stream shows an empty `thinking` block opening and then
 * nothing until the answer begins. A writer call that thinks for three minutes is
 * therefore silent for three minutes while perfectly alive — a real 90-second-tier
 * run was killed at 150 s of silence on its first writer call, after 1.5 s to the
 * first token, and the episode failed for it. Calls that are short by nature (the
 * checker and the director run 15–35 s) keep the tight watchdog.
 */
export const WRITER_IDLE_MS = 8 * 60_000;

/** How long a call of this kind may be silent before it is taken for dead. */
export function idleFor(kind: string): number {
  return kind === "script-writer" ? WRITER_IDLE_MS : CLAUDE_IDLE_MS;
}

/** The hard ceiling for one call of this kind. */
export function ceilingFor(kind: string): number {
  return kind === "script-writer" ? WRITER_CEILING_MS : CLAUDE_CEILING_MS;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    // Without this every CliError reported itself as a plain "Error" in logs
    // and in `recordCall`, which defeats the point of having the class at all.
    this.name = "CliError";
  }
}

/**
 * Is this a CliError? By name, not by `instanceof` — see `isAppError` in
 * lib/errors.ts for why class identity cannot be trusted across module graphs.
 */
export function isCliError(err: unknown): err is CliError {
  return err instanceof Error && err.name === "CliError";
}

/**
 * The terminal result of a Claude run, from either output shape: the
 * `{"type":"result",...}` line that ends a `stream-json` run (found scanning
 * from the end, since thousands of event lines precede it), or the single
 * envelope object a plain `json` run — and the test suite's fake CLI, which
 * ignores `--output-format` — writes. Null when neither is there.
 */
export function resultEnvelope(stdout: string): { is_error?: boolean; result?: string; subtype?: string } | null {
  const lines = stdout.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.includes('"type":"result"')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* a torn line — keep looking */
    }
  }
  try {
    const whole = JSON.parse(stdout);
    return whole && typeof whole === "object" && !Array.isArray(whole) ? whole : null;
  } catch {
    return null;
  }
}

/**
 * Which executable backs a provider.
 *
 * `CLAUDE_CLI_BIN` / `CODEX_CLI_BIN` win, matching how FFMPEG_PATH and
 * POCKET_TTS_BIN are overridden elsewhere. Otherwise the bare name is right on
 * macOS and Linux, but on Windows npm installs these CLIs as a `.cmd` shim and
 * Node 18.20+ will not spawn a `.cmd` without a shell — so the real `.exe` has
 * to be found on PATH instead, or named through the env var when (as with
 * Codex) the binary lives inside the wrapper package rather than on PATH.
 *
 * Exported so the vision-capable sibling in `./cli-vision` resolves the same
 * binary the same way, instead of a second, Windows-blind `|| "claude"` guess.
 */
export function cliBin(provider: CliProvider): string {
  const name = provider === "codex-cli" ? "codex" : provider === "gemini" ? "gemini" : "claude";
  const envKey = provider === "codex-cli" ? "CODEX_CLI_BIN" : provider === "gemini" ? "GEMINI_CLI_BIN" : "CLAUDE_CLI_BIN";
  const override = process.env[envKey]?.trim();


  if (override) return override;
  if (process.platform !== "win32") return name;

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const cleanDir = dir.replace(/^"|"$/g, "");
    const candidate = path.join(cleanDir, `${name}.exe`);
    if (existsSync(candidate)) return candidate;
    const cmdCandidate = path.join(cleanDir, `${name}.cmd`);
    if (existsSync(cmdCandidate)) {
      try {
        const shim = readFileSync(cmdCandidate, "utf8");
        const m = shim.match(/node_modules[\\/][^\r\n"']*?\.[cm]?js/i);
        if (m && existsSync(path.join(cleanDir, m[0]))) return path.join(cleanDir, m[0]);
      } catch {
        /* ignore unreadable shim */
      }
    }
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function escapeControlCharsInJsonStrings(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Pull a JSON object out of model prose (fenced blocks, stray commentary). */
export function extractJson<T>(raw: string): T {
  const text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    for (const variant of [trimmed, escapeControlCharsInJsonStrings(trimmed)]) {
      try {
        return JSON.parse(variant) as T;
      } catch {
        const first = variant.indexOf("{");
        const last = variant.lastIndexOf("}");
        if (first !== -1 && last > first) {
          try {
            return JSON.parse(variant.slice(first, last + 1)) as T;
          } catch {
            /* fall through */
          }
        }
      }
    }
  }

  throw new CliError(
    `Could not read JSON from the CLI response. First 300 characters:\n${text.slice(0, 300)}`,
  );
}

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "reporeel-cli-"));
}

/**
 * Remove a scratch directory, and never fail the call because of it.
 *
 * On Windows the CLI's own process can still hold a handle on its working
 * directory for a moment after it exits, and `fs.rm` then throws EBUSY. In a
 * `finally` that rejection REPLACES the successful return — a model call that
 * produced a perfectly good answer was reported as a failure, which is exactly
 * how a real visual-director call was lost ("Visual planning failed (EBUSY:
 * resource busy or locked, rmdir ...)"). One retry after a short pause clears
 * the usual case; anything still locked is left for the operating system's own
 * temp cleanup, which is a leaked directory of a few kilobytes rather than a
 * lost minute of model work.
 */
export async function discardScratch(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 120));
    }
  }
}

/**
 * The flags that make a headless call a plain model call rather than a coding
 * agent. Measured (see `cli-metrics.ts`): with only `--append-system-prompt`
 * and `--allowed-tools ""`, every call still carried ~30,000 tokens of Claude
 * Code's own system prompt, tool definitions, MCP servers and skills — none of
 * it relevant to writing or checking a script, and ~50x the cost of the call
 * it rode on. `--allowed-tools` only governs permission; `--tools ""` is what
 * removes the tools. Same model: nothing about the answer the pipeline asked
 * for changes, only what surrounds it. (Reasoning effort is pinned separately,
 * below, and deliberately — see `DEFAULT_CLI_EFFORT`.)
 */
export const LEAN_FLAGS = [
  "--tools", "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

/**
 * What an episode's model calls run on: PINNED, because inheriting the
 * operator's own Claude Code setup was the main reason a video took half an hour.
 *
 * A `claude -p` child loads the settings of whoever runs it. On the machine this
 * was profiled on that was the model `sonnet` (Sonnet 4.6) at `xhigh` effort, 15
 * plugins and 8 SessionStart hooks (~30 KB of unrelated instructions on every
 * call). Over 230 recorded calls the writer spent ~93% of its output on hidden
 * reasoning (a median 13.8k tokens for ~1k of script, at ~79 tokens/s):
 *
 *     Sonnet 4.6, xhigh    writer median 313 s (1,171 s on a rewrite), checker 188 s, director 108 s
 *     Opus, isolated       writer  61-162 s,                           checker  17-51 s, director  60-74 s
 *
 * Through the real writer and checker, Opus with isolation:
 *     writer   xhigh  4/6 drafts passed the code gate, 74-162 s
 *              high   5/6 passed, 61-158 s                       <- the default
 *              medium answered in 26 s but cited a page it was never given
 *              (every failure of the others was a word count a few % over the cap)
 *     checker  scored on drafts with a defect injected (an invented modern detail,
 *              an invented statistic, a word range moved to unrelated words, a vague
 *              unsupported claim) and on the clean drafts:
 *              Opus high 7/8 caught, 2/2 clean passed, median 17 s
 *              Opus xhigh 7/8, 2/2, 26 s;  Sonnet xhigh (the old setup) 7/8, 2/2, 97 s
 *              Opus medium 4/8 caught, so it is not used.
 * Same detections, same verdicts on clean drafts, a fraction of the time, and
 * fewer rewrites in the recorded history (first draft accepted 4 of 5 on Opus
 * against 5 of 9 on Sonnet 4.6). Effort is still a cliff, not a dial: depth is
 * what keeps a draft inside the page, so `high` is the floor.
 *
 * Every knob is overridable per call kind, and "inherit" restores the old behaviour:
 *   BOOKREEL_CLI_MODEL / BOOKREEL_<KIND>_MODEL   (KIND = SCRIPT_WRITER, GROUNDING_CHECK, SCENE_DIRECTOR)
 *   BOOKREEL_WRITER_EFFORT / BOOKREEL_<KIND>_EFFORT   (low | medium | high | xhigh | max | inherit)
 *   BOOKREEL_CLI_ISOLATE=0
 */
export const WRITER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORTS = new Set<string>(WRITER_EFFORT_LEVELS);

/** The calls that make up one episode. Everything else (book analysis, page reading) is left exactly as it was. */
const EPISODE_KINDS = new Set(["script-writer", "grounding-check", "scene-director"]);

/** Effort pinned by default, per call kind. */
const DEFAULT_EFFORT: Record<string, string> = {
  "script-writer": "high",
  "grounding-check": "high",
  "scene-director": "high",
};

/** `script-writer` -> `BOOKREEL_WRITER_EFFORT`; any other kind -> `BOOKREEL_<KIND>_EFFORT`. */
function effortVar(kind: string): string {
  return kind === "script-writer" ? "BOOKREEL_WRITER_EFFORT" : `BOOKREEL_${kind.toUpperCase().replace(/-/g, "_")}_EFFORT`;
}

/** The `--effort` to pass for a call of this kind, or null to inherit. */
export function cliEffort(kind: string, env: Record<string, string | undefined> = process.env): string | null {
  const asked = env[effortVar(kind)]?.trim().toLowerCase();
  if (asked === "inherit") return null;
  if (asked && EFFORTS.has(asked)) return asked;
  return DEFAULT_EFFORT[kind] ?? null;
}

/** The model alias an episode's calls run on unless told otherwise (the CLI resolves it to the latest Opus). */
export const PIPELINE_MODEL = "opus";

/**
 * The model for a call of this kind. An explicit model (the app's `cliModel`
 * setting) wins; then `BOOKREEL_<KIND>_MODEL`, then `BOOKREEL_CLI_MODEL`
 * ("inherit" restores the operator's own default); then PIPELINE_MODEL for the
 * kinds that make up an episode. Other kinds inherit.
 */
export function cliModelFor(kind: string, explicit?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (explicit) return explicit;
  const own = env[`BOOKREEL_${kind.toUpperCase().replace(/-/g, "_")}_MODEL`]?.trim();
  const shared = env.BOOKREEL_CLI_MODEL?.trim();
  const asked = own || shared;
  if (asked) return asked === "inherit" ? undefined : asked;
  return EPISODE_KINDS.has(kind) ? PIPELINE_MODEL : undefined;
}

/**
 * Keeps the operator's interactive Claude Code setup out of an episode's calls.
 * A headless child loads the settings of whoever runs it: 15 plugins and 8
 * SessionStart hooks here, injecting ~30 KB of unrelated instructions (a
 * framework's docs, "you MUST invoke a skill before ANY response") into every
 * writer, checker and director call: 6,596 input tokens for a one-word prompt
 * against 181 without them, 7.1 s wall against 1.6 s. Sign-in is not a setting,
 * so `project` (an empty scratch folder here, so nothing at all) keeps it.
 * BOOKREEL_CLI_ISOLATE=0 restores inheriting everything.
 */
function isolationFlags(kind: string, env: Record<string, string | undefined>): string[] {
  return env.BOOKREEL_CLI_ISOLATE === "0" ? [] : ["--setting-sources", "project"];
}

/**
 * The full argument list for one Claude run. Pure, so what the pipeline
 * actually sends is testable without spawning anything.
 *
 * BOOKREEL_CLI_LEAN=0 restores the original FLAGS exactly — a rollback
 * switch, and the baseline the lean flags were measured against — including
 * inheriting the operator's effort for every kind, as this always did. The output format is independent of that:
 * both shapes stream (see `CLAUDE_IDLE_MS`), because a buffered reply is what
 * made a slow call indistinguishable from a dead one.
 */
function effortFlag(kind: string, env: Record<string, string | undefined>): string[] {
  const effort = cliEffort(kind, env);
  return effort ? ["--effort", effort] : [];
}

export function claudeArgs(system: string, opts: { model?: string; env?: Record<string, string | undefined> } = {}): string[] {
  const env = opts.env ?? process.env;
  const STREAM = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  const args =
    env.BOOKREEL_CLI_LEAN === "0"
      ? ["-p", ...STREAM, "--append-system-prompt", system, "--allowed-tools", "", "--permission-mode", "default"]
      : ["-p", ...STREAM, "--system-prompt", system, ...LEAN_FLAGS, ...isolationFlags(callKind(system), env), ...effortFlag(callKind(system), env), "--permission-mode", "default"];
  const model = env.BOOKREEL_CLI_LEAN === "0" ? opts.model : cliModelFor(callKind(system), opts.model, env);
  if (model) args.push("--model", model);
  return args;
}

/**
 * Claude Code in headless mode, as a plain model call: our system prompt
 * REPLACES Claude Code's (it is complete on its own), no tools, no MCP
 * servers, no skills, in a throwaway folder — so the run can only produce
 * text, and pays only for the prompt it was actually given.
 */
async function runClaudeCli(system: string, user: string, model?: string): Promise<string> {
  const cwd = await scratchDir();
  const kind = callKind(system);
  const t0 = Date.now();
  let envelope: { is_error?: boolean; result?: string; subtype?: string } | null = null;
  try {
    const args = claudeArgs(system, { model });

    const { stdout } = await run(cliBin("claude-cli"), args, {
      cwd,
      input: user,
      timeoutMs: ceilingFor(kind),
      idleMs: idleFor(kind),
    });

    envelope = resultEnvelope(stdout);
    if (!envelope) {
      throw new CliError(
        `Claude CLI did not return a result. Run \`claude\` once in a terminal to confirm you are signed in.\n${stdout.slice(-200)}`,
      );
    }

    // Accept any run that produced text, even one flagged as an error: a turn
    // limit still yields a complete answer.
    if (envelope!.is_error && envelope!.subtype !== "error_max_turns") {
      const detail =
        typeof envelope!.result === "string" && envelope!.result.trim()
          ? envelope!.result.trim()
          : `Claude CLI failed (${envelope!.subtype ?? "error"}).`;
      throw new CliError(detail);
    }
    if (typeof envelope!.result === "string" && envelope!.result.trim()) {
      await recordCall(kind, Date.now() - t0, envelope);
      return envelope!.result;
    }

    throw new CliError(
      `Claude CLI returned no content (${envelope!.subtype ?? "unknown"}). Run \`claude\` once in a terminal to confirm you are signed in.`,
    );
  } catch (err) {
    await recordCall(kind, Date.now() - t0, envelope, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await discardScratch(cwd);
  }
}

async function execBin(
  bin: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  if (/\.[cm]?js$/i.test(bin)) {
    return exec(process.execPath, [bin, ...args], { ...opts, windowsHide: true });
  }
  return exec(bin, args, { ...opts, windowsHide: true });
}

async function readStoredSecret(key: string): Promise<string | null> {
  try {
    const { prisma } = await import("../db");
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGeminiApiKey(): Promise<string | null> {
  const envKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (envKey) return envKey;
  return readStoredSecret("geminiApiKey");
}

export async function resolveCodexApiKey(): Promise<string | null> {
  const envKey = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  return readStoredSecret("codexApiKey");
}

function isForeignModelForCodex(model?: string): boolean {
  if (!model) return true;
  return /^(claude|sonnet|opus|haiku|gemini|inherit)/i.test(model.trim());
}

/** Codex in non-interactive mode, writing its final message to a file. */
export async function runCodexCli(
  system: string,
  user: string,
  model?: string,
  imagePaths?: string[],
): Promise<string> {
  const cwd = await scratchDir();
  const outFile = path.join(cwd, "message.txt");
  const kind = imagePaths?.length ? "page-reader" : callKind(system);
  const t0 = Date.now();
  const codexModel = (!isForeignModelForCodex(model) ? model?.trim() : null) || process.env.CODEX_MODEL?.trim() || undefined;
  try {
    const apiKey = await resolveCodexApiKey();
    const env = cleanEnv();
    if (apiKey) env.OPENAI_API_KEY = apiKey;

    const args = ["exec", "--skip-git-repo-check", "-o", outFile];
    if (codexModel) args.push("-c", `model="${codexModel}"`);
    if (imagePaths?.length) {
      for (const img of imagePaths) args.push("-i", img);
    }
    args.push("-");

    const { stdout, stderr } = await run(cliBin("codex-cli"), args, {
      cwd,
      input: `${system}\n\n---\n\n${user}`,
      timeoutMs: ceilingFor(kind),
      idleMs: idleFor(kind),
      env,
    });

    if (!existsSync(outFile)) {
      const detail = `${stderr}\n${stdout}`.trim();
      if (/401|unauthorized|not logged in|login|auth/i.test(detail)) {
        throw new CliError("Codex is not signed in. Run `codex login` in a terminal or add an OpenAI API key in Settings, then try again.");
      }
      throw new CliError(`Codex CLI produced no output${detail ? `: ${detail.slice(0, 300)}` : "."}`);
    }

    const text = await fs.readFile(outFile, "utf8");
    if (!text.trim()) {
      throw new CliError("Codex CLI returned an empty response.");
    }
    await recordCall(kind, Date.now() - t0, { result: text, modelUsage: { [codexModel ?? "codex"]: {} } });
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCall(kind, Date.now() - t0, null, message);
    if (isCliError(err) && /not signed in|not installed/i.test(err.message)) throw err;
    if (/ENOENT|could not be started/i.test(message)) {
      throw new CliError("Codex CLI is not installed. Install `@openai/codex` and run `codex login`, then try again.");
    }
    if (/401|Unauthorized|not logged in|login required/i.test(message)) {
      throw new CliError("Codex is not signed in. Run `codex login` in a terminal or add an OpenAI API key in Settings, then try again.");
    }
    throw new CliError(`Codex CLI failed: ${message.slice(0, 300)}`);
  } finally {
    await discardScratch(cwd);
  }
}

const VALID_GEMINI_MODEL_IDS = new Set<string>(GEMINI_MODELS.map((m) => m.id));

export function parseGeminiModel(raw: unknown): GeminiModelId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (VALID_GEMINI_MODEL_IDS.has(trimmed)) return trimmed as GeminiModelId;
  return null;
}

export async function resolveGeminiModel(model?: string): Promise<string> {
  if (model && /^(gemini-|gemma-)/i.test(model.trim())) return model.trim();
  const stored = await readStoredSecret("geminiModel");
  if (stored && (parseGeminiModel(stored) || /^(gemini-|gemma-)/i.test(stored))) return stored;
  const envModel = process.env.GEMINI_MODEL?.trim() || process.env.BOOKREEL_CLI_MODEL?.trim();
  if (envModel && /^(gemini-|gemma-)/i.test(envModel)) return envModel;
  return DEFAULT_GEMINI_MODEL_ID;
}

function imageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

export const GEMINI_HTTP_ATTEMPT_TIMEOUT_MS = 45_000;

export const GEMINI_MODEL_POOL: readonly string[] = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-4-argon",
  "gemini-3.1-pro-preview",
];

const exhaustedGeminiModels = new Map<string, number>();
let lastGeminiApiKey: string | null = null;

export function resetGeminiModelCooldowns(): void {
  exhaustedGeminiModels.clear();
}

function orderedGeminiCandidates(primaryModel: string, apiKey: string): string[] {
  if (lastGeminiApiKey !== apiKey) {
    exhaustedGeminiModels.clear();
    lastGeminiApiKey = apiKey;
  }
  const now = Date.now();
  for (const [m, until] of exhaustedGeminiModels.entries()) {
    if (until <= now) exhaustedGeminiModels.delete(m);
  }
  const all = [primaryModel, ...GEMINI_MODEL_POOL.filter((m) => m !== primaryModel)];
  const active = all.filter((m) => !exhaustedGeminiModels.has(m));
  const cooled = all.filter((m) => exhaustedGeminiModels.has(m));
  return [...active, ...cooled];
}

/**
 * Google Gemini provider.
 * Uses the official Google Gemini REST API (`generativelanguage.googleapis.com`)
 * when a Gemini API key is configured (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, or
 * Settings), or the official `gemini` CLI when installed. Never falls back to
 * Claude, Codex, or Ollama.
 */
export async function runGemini(
  system: string,
  user: string,
  model?: string,
  imagePaths?: string[],
): Promise<string> {
  const kind = imagePaths?.length ? "page-reader" : callKind(system);
  const geminiModel = await resolveGeminiModel(model);
  const t0 = Date.now();
  const apiKey = await resolveGeminiApiKey();

  if (apiKey) {
    try {
      const cancel = abortOpts();
      if (cancel.signal?.aborted) throw new CancelledError();

      const parts: Array<Record<string, unknown>> = [];
      if (imagePaths?.length) {
        for (const imgPath of imagePaths) {
          const buf = await fs.readFile(imgPath);
          parts.push({
            inlineData: {
              mimeType: imageMimeType(imgPath),
              data: buf.toString("base64"),
            },
          });
        }
      }
      parts.push({ text: user });

      const wantsJson = Boolean(imagePaths?.length) || /JSON|json-schema|Respond with ONLY a JSON/i.test(system);
      const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
      const candidateModels = orderedGeminiCandidates(geminiModel, apiKey);
      let lastError: Error | null = null;

      for (const candidateModel of candidateModels) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (cancel.signal?.aborted || wasCancelled()) throw new CancelledError();

          const url = `${baseUrl}/models/${encodeURIComponent(candidateModel)}:generateContent`;
          const timeoutSignal = AbortSignal.timeout(Math.min(ceilingFor(kind), GEMINI_HTTP_ATTEMPT_TIMEOUT_MS));
          const signal = cancel.signal ? AbortSignal.any([cancel.signal, timeoutSignal]) : timeoutSignal;

          let res: Response;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: "user", parts }],
                generationConfig: {
                  temperature: 0.2,
                  maxOutputTokens: 8192,
                  ...(wantsJson ? { responseMimeType: "application/json" } : {}),
                },
              }),
              signal,
            });
          } catch (netErr) {
            if (wasCancelled() || netErr instanceof CancelledError) throw new CancelledError();
            const netMsg = netErr instanceof Error ? netErr.message : String(netErr);
            const stalledAttempt = timeoutSignal.aborted || /timeout|aborted/i.test(netMsg);
            lastError = new CliError(`Gemini request failed (${candidateModel}): ${netMsg.slice(0, 300)}`);
            if (stalledAttempt) {
              exhaustedGeminiModels.set(candidateModel, Date.now() + 15 * 60_000);
              break;
            }
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
            exhaustedGeminiModels.set(candidateModel, Date.now() + 60_000);
            break;
          }

          const rawBody = await res.text();
          let parsedBody: {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
            error?: { code?: number; message?: string; status?: string };
          } | null = null;
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            /* handled below */
          }

          if (!res.ok) {
            const errDetail = parsedBody?.error?.message || rawBody.slice(0, 240) || res.statusText;
            if (res.status === 400 || res.status === 401 || res.status === 403) {
              throw new CliError(`Gemini authentication failed (${res.status}): ${errDetail}`);
            }
            lastError = new CliError(`Gemini API failed (${res.status}): ${errDetail}`);
            if (res.status === 429 || res.status === 404) {
              const isDailyOrNotFound =
                res.status === 404 || /per day|free_tier_requests|Please retry in \d+h/i.test(errDetail);
              exhaustedGeminiModels.set(
                candidateModel,
                Date.now() + (isDailyOrNotFound ? 15 * 60_000 : 60_000),
              );
              break;
            }
            if (res.status >= 500) {
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 500));
                continue;
              }
              exhaustedGeminiModels.set(candidateModel, Date.now() + 60_000);
              break;
            }
            throw lastError;
          }

          const text = (parsedBody?.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("")
            .trim();

          if (!text) {
            const reason = parsedBody?.candidates?.[0]?.finishReason ?? "empty response";
            lastError = new CliError(`Gemini returned no content (${reason}).`);
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
            break;
          }

          if (wantsJson) {
            try {
              extractJson(text);
            } catch (jsonErr) {
              lastError =
                jsonErr instanceof Error
                  ? jsonErr
                  : new CliError(`Gemini returned malformed JSON (${parsedBody?.candidates?.[0]?.finishReason ?? "truncated"}).`);
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 400));
                continue;
              }
              break;
            }
          }

          await recordCall(kind, Date.now() - t0, {
            result: text,
            usage: {
              input_tokens: parsedBody?.usageMetadata?.promptTokenCount,
              output_tokens: parsedBody?.usageMetadata?.candidatesTokenCount,
            },
            modelUsage: { [candidateModel]: {} },
          });
          return text;
        }
      }

      throw lastError ?? new CliError("Gemini API failed across all available Gemini models.");
    } catch (err) {
      if (wasCancelled() || err instanceof CancelledError) {
        await recordCall(kind, Date.now() - t0, null, "Cancelled");
        throw new CancelledError();
      }
      const message = err instanceof Error ? err.message : String(err);
      await recordCall(kind, Date.now() - t0, null, message);
      if (isCliError(err)) throw err;
      throw new CliError(`Gemini request failed: ${message.slice(0, 300)}`);
    }
  }

  // Fallback within Gemini ONLY: check if the official Gemini CLI (`gemini`) is installed AND signed in.
  const hasGeminiCliAuth =
    Boolean(process.env.GEMINI_CLI_BIN?.trim()) ||
    existsSync(path.join(os.homedir(), ".gemini", "oauth_creds.json"));
  if (!hasGeminiCliAuth) {
    const msg =
      "Gemini is not connected. Add a Gemini API key in Settings (or set GEMINI_API_KEY in .env.local), or run `gemini` in a terminal to sign in.";
    await recordCall(kind, Date.now() - t0, null, msg);
    throw new CliError(msg);
  }
  const bin = cliBin("gemini");
  const cwd = await scratchDir();
  try {
    const args = ["-p", `${system}\n\n---\n\n${user}`, "--output-format", "json"];
    if (geminiModel) args.push("-m", geminiModel);
    const { stdout } = await run(bin, args, {
      cwd,
      input: "n\n",
      timeoutMs: ceilingFor(kind),
      idleMs: idleFor(kind),
    });
    if (/Opening authentication page in your browser/i.test(stdout)) {
      throw new CliError(
        "Gemini CLI is not signed in. Run `gemini` in a terminal to sign in, or add a Gemini API key in Settings.",
      );
    }
    let text = stdout.trim();
    try {
      const envObj = JSON.parse(text) as { response?: string; result?: string };
      if (typeof envObj.response === "string" && envObj.response.trim()) text = envObj.response.trim();
      else if (typeof envObj.result === "string" && envObj.result.trim()) text = envObj.result.trim();
    } catch {
      /* plain text output */
    }
    if (!text) {
      throw new CliError("Gemini CLI returned no content. Sign in with `gemini` or configure a Gemini API key in Settings.");
    }
    await recordCall(kind, Date.now() - t0, { result: text, modelUsage: { [geminiModel]: {} } });
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCall(kind, Date.now() - t0, null, message);
    if (/ENOENT|could not be started/i.test(message)) {
      throw new CliError(
        "Gemini is not connected. Add a Gemini API key in Settings (or set GEMINI_API_KEY in .env.local), or install and sign in to the official Gemini CLI.",
      );
    }
    if (isCliError(err)) throw err;
    throw new CliError(`Gemini CLI failed: ${message.slice(0, 300)}`);
  } finally {
    await discardScratch(cwd);
  }
}

export async function runCli(
  provider: CliProvider,
  system: string,
  user: string,
  model?: string,
): Promise<string> {
  const resolved = resolveProvider(provider);
  if (resolved === "codex-cli") return runCodexCli(system, user, model);
  if (resolved === "gemini") return runGemini(system, user, model);
  return runClaudeCli(system, user, model);
}

export interface CliStatus {
  installed: boolean;
  signedIn: boolean;
  version: string | null;
  detail: string;
  authMethod?: "cli" | "api-key" | "none";
}

/** Fast readiness check for Settings and the Engine Selector modal. */
export async function probeCli(provider: CliProvider): Promise<CliStatus> {
  const resolved = resolveProvider(provider);

  if (resolved === "gemini") {
    const apiKey = await resolveGeminiApiKey();
    const geminiModel = await resolveGeminiModel();
    if (apiKey) {
      const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
      try {
        const res = await fetch(`${baseUrl}/models/${encodeURIComponent(geminiModel)}`, {
          method: "GET",
          headers: { "x-goog-api-key": apiKey },
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          return {
            installed: true,
            signedIn: true,
            version: geminiModel,
            detail: `Connected via Gemini API (${geminiModel}).`,
            authMethod: "api-key",
          };
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          return {
            installed: true,
            signedIn: false,
            version: geminiModel,
            detail: "Gemini API key was rejected by Google. Check your key in Settings.",
            authMethod: "none",
          };
        }
      } catch {
        // Network unreachable in offline test environment: treat non-empty key as configured.
      }
      return {
        installed: true,
        signedIn: true,
        version: geminiModel,
        detail: `Gemini API key configured (${geminiModel}).`,
        authMethod: "api-key",
      };
    }

    const bin = cliBin("gemini");
    try {
      const { stdout } = await execBin(bin, ["--version"], { timeout: 10_000, env: cleanEnv() });
      const version = stdout.trim().split("\n")[0] || "gemini-cli";
      const hasOAuth = existsSync(path.join(os.homedir(), ".gemini", "oauth_creds.json"));
      if (!hasOAuth && !process.env.GEMINI_CLI_BIN?.trim()) {
        return {
          installed: true,
          signedIn: false,
          version,
          detail: `Gemini CLI (${version}) is installed but not signed in. Add a Gemini API key in Settings or run \`gemini\` in a terminal to sign in.`,
          authMethod: "none",
        };
      }
      return {
        installed: true,
        signedIn: true,
        version,
        detail: `Connected via Gemini CLI (${version}).`,
        authMethod: "cli",
      };
    } catch {
      return {
        installed: false,
        signedIn: false,
        version: null,
        detail: "Not connected. Add a Gemini API key in Settings (or set GEMINI_API_KEY in .env.local).",
        authMethod: "none",
      };
    }
  }

  const bin = cliBin(resolved);
  let version: string | null = null;

  try {
    const { stdout } = await execBin(bin, ["--version"], { timeout: 15_000, env: cleanEnv() });
    version = stdout.trim().split("\n")[0];
  } catch {
    return {
      installed: false,
      signedIn: false,
      version: null,
      detail:
        resolved === "codex-cli"
          ? "Codex CLI is not installed. Install `@openai/codex` and run `codex login`."
          : "Claude Code CLI is not installed. Install Claude Code CLI and run `claude login`.",
      authMethod: "none",
    };
  }

  if (resolved === "codex-cli") {
    const apiKey = await resolveCodexApiKey();
    if (apiKey) {
      return {
        installed: true,
        signedIn: true,
        version,
        detail: `Connected via OpenAI API key (${version ?? "Codex CLI"}).`,
        authMethod: "api-key",
      };
    }
    try {
      const { stdout, stderr } = await execBin(bin, ["login", "status"], { timeout: 10_000, env: cleanEnv() });
      const out = `${stdout}\n${stderr}`.trim();
      const ok = !/not logged in/i.test(out);
      return {
        installed: true,
        signedIn: ok,
        version,
        detail: ok
          ? `Connected via Codex CLI (${out.split("\n")[0] || version}).`
          : "Codex CLI is installed but not signed in. Run `codex login` in a terminal or add an OpenAI API key in Settings.",
        authMethod: ok ? "cli" : "none",
      };
    } catch {
      return {
        installed: true,
        signedIn: false,
        version,
        detail: "Codex CLI is installed but not signed in. Run `codex login` in a terminal or add an OpenAI API key in Settings.",
        authMethod: "none",
      };
    }
  }

  // claude-cli: try fast `claude auth status` first
  try {
    const { stdout } = await execBin(bin, ["auth", "status"], { timeout: 10_000, env: cleanEnv() });
    const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (typeof status.loggedIn === "boolean") {
      if (status.loggedIn) {
        const sub = status.subscriptionType ? ` · ${status.subscriptionType}` : "";
        return {
          installed: true,
          signedIn: true,
          version,
          detail: `Connected via Claude CLI (${status.authMethod ?? "signed in"}${sub}).`,
          authMethod: "cli",
        };
      }
      return {
        installed: true,
        signedIn: false,
        version,
        detail: "Claude CLI is installed but not signed in. Run `claude login` in a terminal.",
        authMethod: "none",
      };
    }
  } catch {
    // Fallback for older Claude CLI or test fixtures without `auth status`
  }

  try {
    const reply = await runCli(resolved, "Answer with one word.", "Reply with the word: ready");
    const ok = /ready/i.test(reply);
    return {
      installed: true,
      signedIn: ok,
      version,
      detail: ok ? "Signed in and responding." : "Responded, but not as expected.",
      authMethod: ok ? "cli" : "none",
    };
  } catch (err) {
    return {
      installed: true,
      signedIn: false,
      version,
      detail: isCliError(err) ? err.message : "Not signed in. Run `claude` once in a terminal.",
      authMethod: "none",
    };
  }
}
