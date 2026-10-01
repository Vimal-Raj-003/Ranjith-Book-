import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { run, resultEnvelope, CliError, CLAUDE_IDLE_MS, CLAUDE_CEILING_MS, WRITER_CEILING_MS, WRITER_IDLE_MS, ceilingFor, idleFor } from "../src/lib/content/cli";

/**
 * These drive `run()` with node itself as the child (a real executable, so
 * they behave the same on Windows, where the suite's script-based fake CLI
 * cannot even be spawned).
 *
 * The regression they pin: a fixed wall-clock kill cannot tell a dead
 * process from a slow one. A real script-writer call thought continuously
 * (3,275 streamed events) for ~400s before answering and was killed at 360s
 * as a "hang" — one idea failed three times running.
 */
const node = process.execPath;
const cwd = os.tmpdir();

test("a child that goes silent is killed after idleMs — long before the ceiling", async () => {
  const started = Date.now();
  await assert.rejects(
    run(node, ["-e", "console.log('hello'); setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 30_000, idleMs: 400 }),
    (err: Error) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /went silent for/);
      assert.match(err.message, /hello/, "the last output it produced is kept as forensics");
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "caught by the idle watchdog, not the 30s ceiling");
});

test("a child that produces nothing at all is also caught by the idle watchdog", async () => {
  await assert.rejects(
    run(node, ["-e", "setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 30_000, idleMs: 300 }),
    (err: Error) => /went silent/.test(err.message) && /no output was produced/.test(err.message),
  );
});

test("a slow child that keeps producing output is NOT killed, even after far longer than idleMs", async () => {
  // Emits a line every 100ms for ~1.5s: 3.75x idleMs of wall time, but never
  // silent for more than 100ms. This is exactly the extended-thinking case.
  const script = "let n = 0; const t = setInterval(() => { console.log('event ' + (++n)); if (n === 15) { clearInterval(t); console.log('done'); } }, 100)";
  const started = Date.now();
  const { stdout } = await run(node, ["-e", script], { cwd, timeoutMs: 30_000, idleMs: 400 });
  assert.ok(Date.now() - started > 1_200, "it really did run well past idleMs");
  assert.match(stdout, /done/);
});

test("stderr counts as activity too", async () => {
  const script = "let n = 0; const t = setInterval(() => { console.error('tick'); if (++n === 12) clearInterval(t); }, 100)";
  await run(node, ["-e", script], { cwd, timeoutMs: 30_000, idleMs: 400 });
});

test("the absolute ceiling still applies to a child that chatters forever", async () => {
  await assert.rejects(
    run(node, ["-e", "setInterval(() => console.log('still going'), 50)"], { cwd, timeoutMs: 900, idleMs: 400 }),
    (err: Error) => err instanceof CliError && /timed out after/.test(err.message),
  );
});

test("without idleMs the behaviour is exactly what it was: only the ceiling applies", async () => {
  await assert.rejects(
    run(node, ["-e", "setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 500 }),
    (err: Error) => /timed out after/.test(err.message) && !/went silent/.test(err.message),
  );
});

test("the watchdog thresholds: non-writer calls stay under reap.ts's 12-minute stale cutoff; the writer may run long enough to finish", () => {
  assert.ok(CLAUDE_CEILING_MS < 12 * 60_000, "an upload whose single call outlived 12 minutes would be reaped as dead");
  assert.ok(CLAUDE_IDLE_MS >= 60_000, "thinking pauses and API retries must not read as death");
  assert.ok(CLAUDE_CEILING_MS > 360_000, "a ~400s call must be allowed to finish");
  assert.ok(WRITER_CEILING_MS > 660_000, "the writer was still thinking at 660s on a real run and must not be killed there");
  assert.equal(ceilingFor("script-writer"), WRITER_CEILING_MS);
  for (const kind of ["grounding-check", "idea-finder", "idea-ranker", "page-reader", "other"]) {
    assert.equal(ceilingFor(kind), CLAUDE_CEILING_MS, kind);
  }
});

test("the writer may stay silent while Opus thinks (it streams no thinking); the short calls keep the tight watchdog", () => {
  // A real run was killed at 150 s of silence on its first writer call — Opus had opened an empty
  // thinking block and said nothing more while it worked. The writer's allowance covers that.
  assert.equal(idleFor("script-writer"), WRITER_IDLE_MS);
  assert.ok(WRITER_IDLE_MS >= 5 * 60_000, "well past the longest silent thinking seen on a real run");
  assert.ok(WRITER_IDLE_MS < WRITER_CEILING_MS, "a stalled writer is still caught before the ceiling");
  for (const kind of ["grounding-check", "scene-director", "idea-finder", "idea-ranker", "page-reader", "other"]) {
    assert.equal(idleFor(kind), CLAUDE_IDLE_MS, kind);
  }
});

// --- result parsing: both shapes -----------------------------------------------

test("resultEnvelope finds the terminal result line at the end of a stream-json run", () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}',
    '{"type":"assistant","message":{}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"{\\"ok\\":true}","usage":{"output_tokens":9}}',
  ].join("\n") + "\n";
  const env = resultEnvelope(stream);
  assert.equal(env?.result, '{"ok":true}');
  assert.equal(env?.is_error, false);
});

test("resultEnvelope still accepts the single-object envelope a plain json run (or the fake CLI) writes", () => {
  const env = resultEnvelope(JSON.stringify({ is_error: false, subtype: "success", result: "hello" }));
  assert.equal(env?.result, "hello");
});

test("resultEnvelope prefers the LAST result line, ignores torn lines, and returns null when there is none", () => {
  assert.equal(resultEnvelope('{"type":"result","result":"first"}\n{"type":"result","result":"second"}\n')?.result, "second");
  assert.equal(resultEnvelope('{"type":"result","result":"ok"}\n{"type":"result","resu')?.result, "ok");
  assert.equal(resultEnvelope('{"type":"system"}\n{"type":"assistant"}\n'), null);
  assert.equal(resultEnvelope(""), null);
  assert.equal(resultEnvelope("not json at all"), null);
});

// --- what the pipeline actually sends ---------------------------------------------

import { claudeArgs, cliEffort, cliModelFor, LEAN_FLAGS, PIPELINE_MODEL } from "../src/lib/content/cli";
import { callKind } from "../src/lib/content/cli-metrics";

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
// System prompts open with these; cli-metrics' callKind() classifies on them.
const WRITER = "You write scripts for short videos.";
const CHECKER = "You are an adversarial checker of scripts.";
const DIRECTOR = "You are the visual director for a 1-2 minute vertical video.";
const EDITOR = "You are a senior editor.";
const TRANSCRIBER = "You transcribe a page.";

test("the three calls that make up an episode are classified, the director included", () => {
  assert.equal(callKind(WRITER), "script-writer");
  assert.equal(callKind(CHECKER), "author-check");
  assert.equal(callKind("You are an adversarial grounding checker for scripts."), "grounding-check");
  assert.equal(callKind(DIRECTOR), "scene-director");
});

test("an episode's calls are pinned: Opus, high effort, and no inherited Claude Code setup", () => {
  // Measured: inheriting the operator's `sonnet` + `xhigh` + 15 plugins made the
  // writer ~313 s and the checker ~188 s; Opus at high is ~75 s and ~17 s with the
  // same checks caught. See the doc comment above WRITER_EFFORT_LEVELS in cli.ts.
  for (const [system, kind] of [[WRITER, "script-writer"], ["You are an adversarial grounding checker.", "grounding-check"], [DIRECTOR, "scene-director"]] as const) {
    const args = claudeArgs(system, { env: {} });
    assert.equal(flagValue(args, "--model"), PIPELINE_MODEL, kind);
    assert.equal(PIPELINE_MODEL, "opus");
    assert.equal(flagValue(args, "--effort"), "high", kind);
    assert.equal(flagValue(args, "--setting-sources"), "project", `${kind} does not load the operator's plugins and hooks`);
  }
});

test("calls outside an episode (book analysis, page reading, the rest) are left exactly as they were", () => {
  for (const system of [EDITOR, TRANSCRIBER, CHECKER, "Something else entirely."]) {
    const args = claudeArgs(system, { env: {} });
    assert.ok(!args.includes("--model"), system);
    assert.ok(!args.includes("--effort"), system);
    assert.ok(!args.includes("--setting-sources"), system);
  }
});

test("effort overrides are per kind, case-insensitive, and a typo falls back to the default rather than inheriting", () => {
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: "low" }), "low");
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: " Medium " }), "medium");
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: "xhigh" }), "xhigh");
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: "ludicrous" }), "high");
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: "" }), "high");
  assert.equal(cliEffort("script-writer", { BOOKREEL_WRITER_EFFORT: "inherit" }), null, "inherit asks for no --effort at all");
  assert.equal(cliEffort("grounding-check", { BOOKREEL_GROUNDING_CHECK_EFFORT: "xhigh" }), "xhigh");
  assert.equal(cliEffort("scene-director", { BOOKREEL_SCENE_DIRECTOR_EFFORT: "medium" }), "medium");
  assert.equal(flagValue(claudeArgs(WRITER, { env: { BOOKREEL_WRITER_EFFORT: "medium" } }), "--effort"), "medium");
});

test("an override for one kind does not leak onto another", () => {
  assert.equal(cliEffort("grounding-check", { BOOKREEL_WRITER_EFFORT: "max" }), "high");
  assert.equal(cliEffort("idea-finder", { BOOKREEL_WRITER_EFFORT: "max" }), null);
  assert.equal(flagValue(claudeArgs(CHECKER.replace("checker of", "grounding checker for"), { env: { BOOKREEL_WRITER_EFFORT: "max" } }), "--effort"), "high");
});

test("model precedence: the app setting, then the kind's variable, then the shared one, then the pin; inherit restores the old default", () => {
  assert.equal(cliModelFor("script-writer", "claude-sonnet-4-6", { BOOKREEL_SCRIPT_WRITER_MODEL: "sonnet" }), "claude-sonnet-4-6");
  assert.equal(cliModelFor("script-writer", undefined, { BOOKREEL_SCRIPT_WRITER_MODEL: "sonnet", BOOKREEL_CLI_MODEL: "haiku" }), "sonnet");
  assert.equal(cliModelFor("grounding-check", undefined, { BOOKREEL_SCRIPT_WRITER_MODEL: "sonnet", BOOKREEL_CLI_MODEL: "haiku" }), "haiku");
  assert.equal(cliModelFor("grounding-check", undefined, {}), "opus");
  assert.equal(cliModelFor("scene-director", undefined, { BOOKREEL_CLI_MODEL: "inherit" }), undefined);
  assert.equal(cliModelFor("idea-finder", undefined, {}), undefined, "analysis calls are not pinned");
});

test("BOOKREEL_CLI_ISOLATE=0 puts the operator's own plugins and hooks back", () => {
  const args = claudeArgs(WRITER, { env: { BOOKREEL_CLI_ISOLATE: "0" } });
  assert.ok(!args.includes("--setting-sources"));
  assert.equal(flagValue(args, "--model"), "opus", "isolation is independent of the model pin");
});

test("the lean invocation streams, is tool-less, and replaces the system prompt", () => {
  const args = claudeArgs("SYSTEM TEXT", { env: {} });
  assert.equal(flagValue(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--verbose") && args.includes("--include-partial-messages"), "stream-json needs --verbose; partials keep thinking visible as activity");
  assert.equal(flagValue(args, "--system-prompt"), "SYSTEM TEXT");
  for (const f of LEAN_FLAGS) assert.ok(args.includes(f), `${f} is still present`);
});

test("BOOKREEL_CLI_LEAN=0 restores the original flags — pins and isolation included — and still streams", () => {
  const args = claudeArgs(WRITER, { env: { BOOKREEL_CLI_LEAN: "0", BOOKREEL_WRITER_EFFORT: "low" } });
  assert.ok(args.includes("--append-system-prompt"));
  assert.ok(!args.includes("--system-prompt"));
  assert.ok(!args.includes("--effort"), "the rollback baseline is the original invocation");
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--setting-sources"));
  assert.equal(flagValue(args, "--output-format"), "stream-json");
});

test("a model, when given, is passed through", () => {
  assert.equal(flagValue(claudeArgs("s", { env: {}, model: "claude-sonnet-4-6" }), "--model"), "claude-sonnet-4-6");
  assert.ok(!claudeArgs("s", { env: {} }).includes("--model"));
  assert.equal(flagValue(claudeArgs(WRITER, { env: {}, model: "claude-sonnet-4-6" }), "--model"), "claude-sonnet-4-6", "the app's cliModel setting beats the pin");
});
