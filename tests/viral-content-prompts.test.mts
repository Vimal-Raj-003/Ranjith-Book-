import test from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_SYSTEM } from "../src/lib/analysis/candidates";
import { RANK_SYSTEM, WEIGHTS, weightedScore } from "../src/lib/analysis/rank";
import { buildSystemPrompt } from "../src/lib/content/prompt";
import { callKind } from "../src/lib/content/cli-metrics";
import { TITLE_RULE } from "../src/lib/content/metadata-rules";

test("PDF candidate finder and ranker preserve cli-metrics callKind classifications while enforcing viral topic lenses", () => {
  assert.equal(callKind(CANDIDATE_SYSTEM), "idea-finder");
  assert.equal(callKind(RANK_SYSTEM), "idea-ranker");

  // 5 viral topic lenses in PDF candidate extraction
  assert.match(CANDIDATE_SYSTEM, /Contrarian Myth-Buster/);
  assert.match(CANDIDATE_SYSTEM, /Pain-Mirror/);
  assert.match(CANDIDATE_SYSTEM, /Surprising Asymmetry/);
  assert.match(CANDIDATE_SYSTEM, /High-Stakes Human Moment/);
  assert.match(CANDIDATE_SYSTEM, /1-Step Practical Shift/);
  assert.match(CANDIDATE_SYSTEM, /modern conversational English/);
  assert.match(CANDIDATE_SYSTEM, /Save or Share/);

  // Ranking weights prioritize scroll-stopping hook, YouTube/Reels save-share suitability, emotion & uniqueness
  assert.ok(WEIGHTS.hookPotential >= 1.5, "hookPotential carries top weight");
  assert.ok(WEIGHTS.youtubeSuitability >= 1.5, "youtubeSuitability carries top weight");
  assert.ok(WEIGHTS.emotionalInterest >= 1.2, "emotionalInterest elevated for relatable tension");
  assert.ok(WEIGHTS.uniqueness >= 1.2, "uniqueness elevated to beat generic clichés");
  assert.equal(
    weightedScore({
      viewerUsefulness: 8,
      educationalValue: 8,
      hookPotential: 8,
      storyPotential: 8,
      practicalValue: 8,
      emotionalInterest: 8,
      uniqueness: 8,
      youtubeSuitability: 8,
      visualPotential: 8,
    }),
    8,
  );
  assert.match(RANK_SYSTEM, /Save[\s\S]*or Share/);
});

test("scriptwriter system prompt preserves script-writer callKind and enforces all viral retention & CTA rules", () => {
  for (const length of ["short", "long"] as const) {
    const prompt = buildSystemPrompt({ hasAuthor: false, length });
    assert.equal(callKind(prompt), "script-writer");

    // 5 hook archetypes + micro-punchline cadence + mid-video re-hook + plain-English translation + Save/Share/Comment CTA
    assert.match(prompt, /Contrarian Myth-Buster/);
    assert.match(prompt, /Pain-Mirror/);
    assert.match(prompt, /MICRO-PUNCHLINE CADENCE/);
    assert.match(prompt, /MID-VIDEO PATTERN INTERRUPT/);
    assert.match(prompt, /PLAIN-ENGLISH TRANSLATION/);
    assert.match(prompt, /kinetic motion-card headline/);
    assert.match(prompt, /Save trigger/);
    assert.match(prompt, /Share trigger/);
    assert.match(prompt, /Comment trigger/);
  }

  assert.match(TITLE_RULE, /scroll-stopping, curiosity-driven/);
});
