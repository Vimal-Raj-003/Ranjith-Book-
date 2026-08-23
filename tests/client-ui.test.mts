import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POCKET_VOICES, DEFAULT_POCKET_VOICE } from "../src/lib/media/pocket-tts";
import { VOICES, DEFAULT_VOICE_ID, VIDEO_THEMES, strings } from "../src/lib/strings";

const COMPONENTS = fileURLToPath(new URL("../src/components/", import.meta.url));

async function componentFiles(): Promise<string[]> {
  const names = await fs.readdir(COMPONENTS);
  return names.filter((n) => n.endsWith(".tsx") || n.endsWith(".ts"));
}

/**
 * The voice list in `strings.ts` is a hand-copy of the one in `pocket-tts.ts`,
 * because `pocket-tts.ts` spawns a model server and can never be imported by a
 * `"use client"` component. A copy is only safe if something notices when it
 * drifts — that is this test.
 */
test("the voice catalogue in strings.ts matches the TTS catalogue", () => {
  assert.deepEqual(
    VOICES.map((v) => ({ id: v.id, label: v.label, gender: v.gender })),
    POCKET_VOICES.map((v) => ({ id: v.id, label: v.label, gender: v.gender })),
    "the UI voice list has drifted from POCKET_VOICES",
  );
});

test("the UI default voice is the pipeline's default voice", () => {
  assert.equal(DEFAULT_VOICE_ID, DEFAULT_POCKET_VOICE);
  assert.ok(
    VOICES.some((v) => v.id === DEFAULT_VOICE_ID),
    "the default voice must be one of the offered voices",
  );
});

/**
 * Only `marginalia` has a theme module. Every other theme the inspector names
 * must be marked unavailable, or the operator is offered a choice that
 * silently does nothing.
 */
test("only implemented themes are marked available", async () => {
  const dir = fileURLToPath(new URL("../src/lib/video/composition/themes/", import.meta.url));
  const built = new Set((await fs.readdir(dir)).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")));

  for (const theme of VIDEO_THEMES) {
    if (theme.available) {
      assert.ok(built.has(theme.id), `${theme.id} is offered as available but has no theme module`);
    }
  }
  assert.ok(
    VIDEO_THEMES.some((t) => t.available),
    "at least one theme must be usable",
  );
});

/**
 * The 500 this codebase already paid for once: a `"use client"` component that
 * transitively imports a server module (sharp, Prisma, ffmpeg, the CLI
 * spawner) breaks every route in the app, and a clean typecheck does not catch
 * it. Client components may only reach into `@/lib` for these leaf modules,
 * each of which is dependency-free or close to it.
 */
const CLIENT_SAFE_LIBS = new Set(["@/lib/strings", "@/lib/pipeline-steps", "@/lib/format-duration", "@/lib/ingest/validate"]);

test("client components import only dependency-free lib modules", async () => {
  const offenders: string[] = [];

  for (const name of await componentFiles()) {
    const source = await fs.readFile(path.join(COMPONENTS, name), "utf8");
    if (!/^\s*["']use client["']/m.test(source)) continue;
    for (const match of source.matchAll(/from\s+["'](@\/lib\/[^"']+)["']/g)) {
      if (!CLIENT_SAFE_LIBS.has(match[1])) offenders.push(`${name} -> ${match[1]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these client components reach into server-only modules and will 500 every route: ${offenders.join(", ")}`,
  );
});

/** No component may hardcode a colour: both themes are repainted by tokens. */
test("components use design tokens, never literal hex colours", async () => {
  const offenders: string[] = [];
  for (const name of await componentFiles()) {
    const source = await fs.readFile(path.join(COMPONENTS, name), "utf8");
    for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      // `#000` behind a letterboxed video is the absence of a colour, not a
      // theme choice — the video's own black bars.
      if (match[0] === "#000" || match[0] === "#fff") continue;
      offenders.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded colours break one of the two themes: ${offenders.join(", ")}`);
});

/** Every string the UI shows comes from `strings.ts`, including the new panes. */
test("the shell's copy is in the strings module", () => {
  assert.equal(typeof strings.nav.queue, "string");
  assert.equal(typeof strings.queue.body, "string");
  assert.equal(typeof strings.preview.none, "string");
  assert.equal(typeof strings.thumbnails.empty, "string");
});
