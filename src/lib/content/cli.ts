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
  opts: { cwd: string; input?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  // The 360s hard timeout below is unconditional and unrelated to this: it
  // exists because the CLI itself can genuinely hang, with no cancellation in
  // play at all. `abortOpts()` is a SEPARATE, faster way out — an operator
  // cancelling the episode this call belongs to — and Node kills the same
  // child the same way (SIGKILL) the instant it fires, rather than waiting
  // out however much of the 360s is left.
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

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
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
      reject(
        new CliError(
          `${bin} timed out after ${Math.round(opts.timeoutMs / 1000)}s` +
            (collected ? ` (${collected})` : " (no output was produced before it was killed)"),
        ),
      );
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

export class CliError extends Error {}

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
 * removes the tools. Same model, same effort: nothing about the answer the
 * pipeline asked for changes, only what surrounds it.
 */
export const LEAN_FLAGS = [
  "--tools", "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

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
    // BOOKREEL_CLI_LEAN=0 restores the original invocation exactly — a
    // rollback switch, and the baseline the lean flags were measured against.
    const args =
      process.env.BOOKREEL_CLI_LEAN === "0"
        ? ["-p", "--output-format", "json", "--append-system-prompt", system, "--allowed-tools", "", "--permission-mode", "default"]
        : ["-p", "--output-format", "json", "--system-prompt", system, ...LEAN_FLAGS, "--permission-mode", "default"];
    if (model) args.push("--model", model);

    const { stdout } = await run(cliBin("claude-cli"), args, {
      cwd,
      input: user,
      timeoutMs: TIMEOUT_MS,
    });

    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new CliError(
        `Claude CLI did not return JSON. Run \`claude\` once in a terminal to confirm you are signed in.\n${stdout.slice(0, 200)}`,
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
