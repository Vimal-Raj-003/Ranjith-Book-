import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJson, CliError, run, cliBin, discardScratch, type CliProvider } from "./cli";
import { recordCall } from "./cli-metrics";

const TIMEOUT_MS = 6 * 60_000;

/**
 * A CLI call that can see images.
 *
 * The text path (`runCli` in `./cli`) deliberately runs with `--allowed-tools
 * ""` in a throwaway directory, so it cannot open a file at all. Reading a
 * photograph needs the Read tool, so this variant enables exactly that one
 * tool and nothing else, and copies the images into a scratch directory that
 * becomes the working directory — so the only files reachable by the enabled
 * tool are the pages we chose to show it.
 *
 * The process-spawn plumbing (timeout, SIGKILL, stdin/stdout wiring) is
 * `run()` from `./cli`, reused rather than copied — two divergent copies of
 * that logic would only rot in different directions.
 */
export async function runCliVisionJson<T>(
  provider: CliProvider,
  system: string,
  user: string,
  imagePaths: string[],
  schema: object,
  model?: string,
): Promise<T> {
  if (provider !== "claude-cli") {
    throw new CliError(
      "Reading book pages needs the Claude Code CLI. Choose it under Settings → Provider, or add an Anthropic API key.",
    );
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-vision-"));
  try {
    const names: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const ext = path.extname(imagePaths[i]) || ".jpg";
      const name = `page-${String(i).padStart(2, "0")}${ext}`;
      await fs.copyFile(imagePaths[i], path.join(cwd, name));
      names.push(name);
    }

    const contract =
      `\n\nRead these image files in this order: ${names.join(", ")}.` +
      `\n\nReturn ONLY a single JSON object — no prose, no markdown fence, no explanation before or after.` +
      ` It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;

    // Unlike the text path this keeps Claude Code's own system prompt (which
    // is what tells it how to use the Read tool) and offers exactly one tool,
    // Read — but still drops the MCP servers, skills and session files that
    // every call otherwise loads and pays for (see LEAN_FLAGS in ./cli).
    const args = [
      "-p",
      "--output-format", "json",
      "--append-system-prompt", system + contract,
      "--tools", "Read",
      "--allowed-tools", "Read",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode", "acceptEdits",
    ];
    if (model) args.push("--model", model);

    const t0 = Date.now();
    let envelope: { result?: string; subtype?: string } | null = null;
    try {
      const { stdout } = await run(cliBin(provider), args, {
        cwd,
        input: user,
        timeoutMs: TIMEOUT_MS,
      });

      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new CliError(
          `The Claude CLI did not return JSON while reading a page. Run \`claude\` once in a terminal to confirm you are signed in.\n${stdout.slice(0, 200)}`,
        );
      }

      if (typeof envelope!.result === "string" && envelope!.result.trim()) {
        await recordCall("page-reader", Date.now() - t0, envelope);
        return extractJson<T>(envelope!.result);
      }

      throw new CliError(
        `The Claude CLI read no content from the page (${envelope!.subtype ?? "unknown"}).`,
      );
    } catch (err) {
      await recordCall("page-reader", Date.now() - t0, envelope, err instanceof Error ? err.message : String(err));
      throw err;
    }
  } finally {
    await discardScratch(cwd);
  }
}
