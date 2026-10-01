import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
import { callKind, recordCall } from "./cli-metrics";
import { abortOpts, wasCancelled, CancelledError } from "../cancel";

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
  opts: { cwd: string; input?: string; timeoutMs: number; idleMs?: number },
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

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
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
export type CliProvider = "claude-cli" | "codex-cli";

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

export class CliError extends Error {}

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
  const name = provider === "codex-cli" ? "codex" : "claude";
  const override =
    process.env[provider === "codex-cli" ? "CODEX_CLI_BIN" : "CLAUDE_CLI_BIN"]?.trim();
  if (override) return override;
  if (process.platform !== "win32") return name;

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ""), `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

/** Pull a JSON object out of model prose (fenced blocks, stray commentary). */
export function extractJson<T>(raw: string): T {
  const text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          return JSON.parse(trimmed.slice(first, last + 1)) as T;
        } catch {
          /* fall through to the next candidate */
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
  return env.BOOKREEL_CLI_ISOLATE === "0" || !EPISODE_KINDS.has(kind) ? [] : ["--setting-sources", "project"];
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

/** Codex in non-interactive mode, writing its final message to a file. */
async function runCodexCli(system: string, user: string, model?: string): Promise<string> {
  const cwd = await scratchDir();
  const outFile = path.join(cwd, "message.txt");
  try {
    // Codex reads the prompt from stdin when the argument is `-`.
    const args = ["exec", "--skip-git-repo-check", "-o", outFile];
    if (model) args.push("-c", `model="${model}"`);
    args.push("-");

    await run(cliBin("codex-cli"), args, {
      cwd,
      input: `${system}\n\n---\n\n${user}`,
      timeoutMs: TIMEOUT_MS,
    });

    return await fs.readFile(outFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|Unauthorized|not logged in/i.test(message)) {
      throw new CliError("Codex is not signed in. Run `codex login` in a terminal, then try again.");
    }
    throw new CliError(`Codex CLI failed: ${message.slice(0, 300)}`);
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
  return provider === "codex-cli"
    ? runCodexCli(system, user, model)
    : runClaudeCli(system, user, model);
}

export interface CliStatus {
  installed: boolean;
  signedIn: boolean;
  version: string | null;
  detail: string;
}

/** Cheap probe for the Settings screen: is this CLI present and usable? */
export async function probeCli(provider: CliProvider): Promise<CliStatus> {
  const bin = cliBin(provider);
  let version: string | null = null;

  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 20_000 });
    version = stdout.trim().split("\n")[0];
  } catch {
    return {
      installed: false,
      signedIn: false,
      version: null,
      detail:
        provider === "codex-cli"
          ? "Codex CLI is not installed."
          : "Claude Code CLI is not installed.",
    };
  }

  try {
    const reply = await runCli(provider, "Answer with one word.", "Reply with the word: ready");
    const ok = /ready/i.test(reply);
    return {
      installed: true,
      signedIn: ok,
      version,
      detail: ok ? "Signed in and responding." : "Responded, but not as expected.",
    };
  } catch (err) {
    return {
      installed: true,
      signedIn: false,
      version,
      detail:
        err instanceof CliError
          ? err.message
          : provider === "codex-cli"
            ? "Not signed in. Run `codex login`."
            : "Not signed in. Run `claude` once in a terminal.",
    };
  }
}
