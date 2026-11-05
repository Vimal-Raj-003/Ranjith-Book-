#!/usr/bin/env node
// Fake `claude` CLI, used only by tests/generate-content.test.mts via
// CLAUDE_CLI_BIN, to exercise generateContent's orchestration (release-on-
// failure, the deterministic gate, the split verdict/indicesGrounded/
// authorNamed enforcement) without a real subscription or network call.
//
// The scenario for a call is read out of the PROMPT CONTENT itself — a
// "SCENARIO:xxx" marker embedded in `bookTitle` for the writer call, and
// carried forward into the replied script's `title` field so the grounding
// call (which only sees the script, not the original bookTitle) can find the
// same marker. This avoids any shared, order-dependent process state (an env
// var flipped per test would race if tests ever ran concurrently); each
// invocation decides its own behavior purely from its own stdin.
import fs from "node:fs";

const args = process.argv.slice(2);
// Both spellings, because the real CLI is invoked with either: `claudeArgs`
// uses `--append-system-prompt` only on the legacy BOOKREEL_CLI_LEAN=0 path and
// `--system-prompt` on the lean path that is now the default. Reading only the
// first one left `system` empty on every modern call, so `isGrounding` below was
// always false and this fixture answered a GROUNDING request with a writer's
// script — which then arrived at `revisionBrief` as a report with no `issues`
// and crashed. The flag the CLI is actually given is the only thing that can be
// trusted here.
const idx = Math.max(args.indexOf("--append-system-prompt"), args.indexOf("--system-prompt"));
const system = idx >= 0 ? args[idx + 1] : "";

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch {
  /* no stdin */
}

const scenarioMatch = input.match(/SCENARIO:([A-Za-z0-9_-]+)/);
const scenario = scenarioMatch ? scenarioMatch[1] : "clean-pass";

function envelope(resultObj) {
  return JSON.stringify({ is_error: false, subtype: "success", result: JSON.stringify(resultObj) });
}

if (scenario === "cli-failure") {
  process.stderr.write("simulated CLI crash\n");
  process.exit(1);
}

const isGrounding = /adversarial grounding checker/.test(system);

if (/You write paraphrased narration/.test(system)) {
  const request = JSON.parse(input);
  if (!request.beats.some((b) => b.passagesToParaphrase.length)) throw new Error("Missing exact passages to repair");
  process.stdout.write(envelope({ voiceovers: request.beats.map((b, i) =>
    scenario === "quotation-budget" ? b.voiceover :
    i === 0 ? "The passage contrasts fleeting enthusiasm with a commitment that endures." : b.voiceover) }));
  process.exit(0);
}

function cleanScript(tag) {
  return {
    title: `Test title SCENARIO:${tag}`,
    hook: `Test hook ${tag} ${Math.random().toString(36).slice(2)}`,
    ideaKey: "test-idea",
    beats: [
      {
        id: "hook",
        voiceover: "The page draws a line between wanting to act and deciding to.",
        onScreen: "Label",
        sourcePage: 0,
        startWord: 0,
        endWord: 5,
      },
      {
        id: "cta",
        voiceover: "Follow for part two.",
        onScreen: "Part two",
        sourcePage: 0,
        startWord: 6,
        endWord: 8,
      },
    ],
    cta: "Follow for part two.",
    description: "A description.",
    hashtags: ["books", "reading", "focus"],
    takeaway: ["One idea.", "Another idea."],
  };
}

if (isGrounding) {
  if (scenario === "grounding-range-cta" || scenario === "grounding-factual-cta") {
    const script = JSON.parse(input.split("GENERATED SCRIPT:\n")[1]);
    const rangeCorrect = script.beats[0].startWord === 183 && script.beats[0].endWord === 198;
    const allowedRequest = /CLOSING REQUEST EXCEPTION/.test(system) && scenario !== "grounding-factual-cta";
    const pass = rangeCorrect && allowedRequest;
    process.stdout.write(envelope({ verdict: pass ? "pass" : "revise", groundedness: pass ? 100 : 50,
      authorNamed: false, indicesGrounded: rangeCorrect,
      issues: pass ? [] : [{ field: "beats[1].voiceover", severity: "blocker", problem: "Unsupported factual memory claim" }] }));
    process.exit(0);
  }
  if (scenario === "always-revise-flags-indices") {
    process.stdout.write(
      envelope({
        verdict: "pass", // deliberately inconsistent with indicesGrounded — finding 5
        groundedness: 80,
        authorNamed: false,
        indicesGrounded: false,
        issues: [{ field: "beats[0].wordRange", severity: "blocker", problem: "indices point at the wrong sentence" }],
      }),
    );
    process.exit(0);
  }
  if (scenario === "always-revise-flags-author") {
    process.stdout.write(
      envelope({
        verdict: "pass", // deliberately inconsistent with authorNamed — finding 5
        groundedness: 80,
        authorNamed: true,
        indicesGrounded: true,
        issues: [{ field: "hook", severity: "blocker", problem: "names an unverified author" }],
      }),
    );
    process.exit(0);
  }
  if (scenario === "verified-author-ok") {
    // The verified author IS named — authorNamed:true here is correct and
    // must not, on its own, force a rewrite.
    process.stdout.write(
      envelope({ verdict: "pass", groundedness: 90, authorNamed: true, indicesGrounded: true, issues: [] }),
    );
    process.exit(0);
  }
  process.stdout.write(
    envelope({ verdict: "pass", groundedness: 90, authorNamed: false, indicesGrounded: true, issues: [] }),
  );
  process.exit(0);
}

// The writer call.
if (scenario === "grounding-range-cta" || scenario === "grounding-factual-cta") {
  const pkg = cleanScript(scenario);
  pkg.beats[0] = { ...pkg.beats[0], sourcePage: 52, startWord: 190, endWord: 198,
    voiceover: "Whatever once occupies an active, intense mind to the exclusion of everything else is never forgotten." };
  pkg.beats[1] = { ...pkg.beats[1], sourcePage: 52, startWord: 198, endWord: 198,
    voiceover: scenario === "grounding-range-cta" ? "Follow BookReel." : "Follow BookReel because this method doubles your memory." };
  process.stdout.write(envelope(pkg));
  process.exit(0);
}
if (scenario === "author-mismatch") {
  const pkg = cleanScript(scenario);
  pkg.beats[0].voiceover = "A passage by James Clear on staying disciplined when nobody is watching.";
  process.stdout.write(envelope(pkg));
  process.exit(0);
}

if (scenario === "quotation-budget") {
  const pkg = cleanScript(scenario);
  pkg.beats[0].voiceover =
    "Discipline is not the same as motivation. Motivation is a feeling and feelings " +
    "are weather. Discipline is a decision you made once and keep. The page argues " +
    "that starting smaller than feels useful is the only reliable way through the " +
    "first fortnight of any new habit whatsoever.";
  process.stdout.write(envelope(pkg));
  process.exit(0);
}

// Same over-budget first draft as "quotation-budget" above, but this one
// listens for the revision brief the gate now feeds back (the same shape a
// grounding-check brief takes — "The checker rejected your previous draft.
// Fix this:" — see buildUserPrompt) and returns a clean, paraphrased draft
// once it sees one. Used to prove the quotation budget joins the SAME
// rewrite loop instead of throwing on the first over-budget draft.
if (scenario === "quotation-budget-recovers") {
  if (/rejected your previous draft/.test(input)) {
    process.stdout.write(envelope(cleanScript(scenario)));
    process.exit(0);
  }
  const pkg = cleanScript(scenario);
  pkg.beats[0].voiceover =
    "Discipline is not the same as motivation. Motivation is a feeling and feelings " +
    "are weather. Discipline is a decision you made once and keep. The page argues " +
    "that starting smaller than feels useful is the only reliable way through the " +
    "first fortnight of any new habit whatsoever.";
  process.stdout.write(envelope(pkg));
  process.exit(0);
}

// clean-pass / verified-author-ok / always-revise-flags-* / usedhook-fail /
// anything else — a clean, unproblematic script.
process.stdout.write(envelope(cleanScript(scenario)));
process.exit(0);
