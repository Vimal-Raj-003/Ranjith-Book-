import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INGEST_STEPS, EPISODE_STEPS } from "../src/lib/pipeline";
import { STEPS } from "../src/components/PipelineRail";

test("every pipeline stage is known to the rail", () => {
  const known = new Set(STEPS);
  const missing = [...INGEST_STEPS, ...EPISODE_STEPS].filter((s) => !known.has(s));

  assert.deepEqual(
    missing,
    [],
    `the rail does not know ${missing.join(", ")} — findIndex returns -1 and the rail renders as though nothing has started`,
  );
});

test("the rail lists no stage the pipeline never runs", () => {
  const real = new Set([...INGEST_STEPS, ...EPISODE_STEPS]);
  const phantom = STEPS.filter((s) => !real.has(s));
  assert.deepEqual(phantom, [], `the rail waits forever on ${phantom.join(", ")}`);
});

test("the stages are in pipeline order in the rail", () => {
  const ordered = [...INGEST_STEPS, ...EPISODE_STEPS];
  assert.deepEqual(STEPS, ordered, "the rail's order is the order the operator watches");
});

// Guards the guard: `STEPS` must be DERIVED from the pipeline module, never a
// hand-copied literal array sitting in the component file. A future edit that
// reintroduces a literal array would still pass the three tests above as long
// as the literal happens to match today's steps — this test fails the moment
// the source text itself regresses, before the arrays ever have a chance to
// drift apart again.
test("PipelineRail.tsx derives STEPS from the pipeline rather than restating it", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../src/components/PipelineRail.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /import\s*\{[^}]*INGEST_STEPS[^}]*EPISODE_STEPS[^}]*\}\s*from\s*["']@\/lib\/pipeline["']|import\s*\{[^}]*EPISODE_STEPS[^}]*INGEST_STEPS[^}]*\}\s*from\s*["']@\/lib\/pipeline["']/,
    "STEPS must import INGEST_STEPS and EPISODE_STEPS from @/lib/pipeline",
  );

  assert.doesNotMatch(
    source,
    /export const STEPS\s*=\s*\[\s*["']/,
    "STEPS must be derived (e.g. [...INGEST_STEPS, ...EPISODE_STEPS]), not a literal array of step-name strings",
  );
});
