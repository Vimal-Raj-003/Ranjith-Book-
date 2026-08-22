import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INGEST_STEPS, EPISODE_STEPS } from "../src/lib/pipeline";
import { STEPS } from "../src/lib/pipeline-steps";
import { STEPS as RAIL_STEPS } from "../src/components/PipelineRail";

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

// `pipeline-steps.ts` (the single source of truth) must itself agree with the
// pipeline module's own re-exports, and `PipelineRail.tsx` must import STEPS
// from it directly rather than through `@/lib/pipeline` — `pipeline.ts` pulls
// in sharp, Prisma, the CLI spawner and ffmpeg, none of which resolve in a
// client bundle. Importing through it would reintroduce the exact bug this
// split fixed, even though the values would still match today.
test("PipelineRail imports the same STEPS pipeline-steps.ts exports", () => {
  assert.deepEqual(RAIL_STEPS, STEPS, "the rail's STEPS must be the pipeline-steps module's STEPS, not a copy");
});

// Guards the guard: `STEPS` must be DERIVED from a dependency-free module,
// never a hand-copied literal array sitting in the component file, and it
// must not be imported from the server-only pipeline module. A future edit
// that reintroduces a literal array would still pass the tests above as long
// as the literal happens to match today's steps — this test fails the moment
// the source text itself regresses, before the arrays ever have a chance to
// drift apart again, and before the client bundle breaks again.
test("PipelineRail.tsx derives STEPS from pipeline-steps.ts rather than restating it", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../src/components/PipelineRail.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /import\s*\{[^}]*STEPS[^}]*\}\s*from\s*["']@\/lib\/pipeline-steps["']/,
    "STEPS must be imported from @/lib/pipeline-steps (dependency-free), not restated or pulled from @/lib/pipeline",
  );

  assert.doesNotMatch(
    source,
    /from\s*["']@\/lib\/pipeline["']/,
    "PipelineRail.tsx (a \"use client\" component) must never import from @/lib/pipeline — that module pulls in sharp, Prisma, the CLI spawner and ffmpeg, which cannot resolve in the browser bundle",
  );

  assert.doesNotMatch(
    source,
    /export const STEPS\s*=\s*\[\s*["']/,
    "STEPS must be derived, not a literal array of step-name strings",
  );
});
