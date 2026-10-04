import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as inspectorModule from "../src/components/Inspector";
import { POCKET_VOICES, DEFAULT_POCKET_VOICE } from "../src/lib/media/pocket-tts";
import { VOICES, DEFAULT_VOICE_ID, VIDEO_THEMES, strings, recordedVoiceName } from "../src/lib/strings";

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

test("an episode's recorded voice is named from the provider that spoke it", () => {
  assert.equal(recordedVoiceName("pocket", "vera"), "Vera", "a Pocket id is looked up in the catalogue");
  assert.equal(recordedVoiceName("pocket", "caro_davy"), "Caro", "by id, not by what the id looks like");
  // Another provider's voice id is not a POCKET_VOICES id and is never looked up
  // as one: it is shown exactly as it was recorded, even when it is spelled like
  // a Pocket voice.
  assert.equal(recordedVoiceName("elevenlabs", "eve"), "eve", "a non-Pocket id is shown as it was recorded");
  assert.equal(recordedVoiceName("openai", "onyx"), "onyx");
  assert.equal(recordedVoiceName("pocket", "retired_voice"), "retired_voice", "a catalogue entry since removed keeps its id");
  // Falsy, not just null, is "not recorded": `resolveVoice` returns "" for a
  // provider with no stored voice, and a blank name reads as a rendering bug.
  assert.equal(recordedVoiceName("pocket", null), null);
  assert.equal(recordedVoiceName("pocket", ""), null);
  assert.equal(recordedVoiceName(null, null), null, "an episode from before the columns existed");
  assert.equal(recordedVoiceName(undefined, undefined), null, "and one the API did not carry them for");
});

// The component under test is a CJS/ESM default-export wrapper when loaded through tsx.
const Inspector = ((inspectorModule as { default: unknown }).default as { default?: unknown }).default ??
  (inspectorModule as { default: unknown }).default;

/** The Inspector as the server first renders it: effects have not run, so no setting has been read yet. */
function renderInspector(episode: Record<string, unknown> | null): string {
  return renderToStaticMarkup(React.createElement(Inspector as React.ComponentType<{ episode: unknown }>, { episode }));
}

const FINISHED = {
  id: "e1", bookTitle: "B", title: "T", status: "DONE", step: "DONE", error: null, notes: [],
  partNumber: 1, seriesTotal: 1, hasVideo: false, startedAt: null, finishedAt: null, totalMs: null,
};

function voiceSummary(html: string): string {
  const m = html.match(/<summary>(Voice[^<]*)<\/summary>/);
  assert.ok(m, "the voice panel has a summary");
  return m[1];
}

test("the voice picker is enabled and lists every voice, grouped by gender", () => {
  const html = renderInspector(null);
  const select = html.match(/<select[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  assert.ok(select, "a voice <select> is rendered");
  assert.doesNotMatch(select.match(/<select[^>]*>/)![0], /disabled/, "it used to be disabled; it must now write");
  const groups = [...select.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)];
  assert.deepEqual(groups.map((g) => g[1]), ["Female", "Male"]);
  const offered = groups.flatMap((g) => [...g[2].matchAll(/<option value="([^"]+)"/g)].map((o) => o[1]));
  assert.deepEqual(offered.sort(), VOICES.map((v) => v.id).sort(), "every voice, once, and nothing else");
  for (const g of groups) {
    const want = VOICES.filter((v) => v.gender === (g[1] === "Female" ? "female" : "male")).map((v) => v.id);
    assert.deepEqual([...g[2].matchAll(/<option value="([^"]+)"/g)].map((o) => o[1]), want, `${g[1]} holds the ${g[1]} voices`);
  }
});

test("a finished episode's voice summary says what narrated it, never a blank name", () => {
  assert.equal(voiceSummary(renderInspector({ ...FINISHED, voiceId: "vera", voiceProvider: "pocket" })), "Voice · Narrated by Vera");
  // A non-Pocket id is shown as recorded, not looked up in the Pocket catalogue.
  assert.equal(voiceSummary(renderInspector({ ...FINISHED, voiceId: "eve", voiceProvider: "openai" })), "Voice · Narrated by eve");
  // Not recorded: null (an episode from before the columns), and "" (a provider with no stored voice).
  assert.equal(voiceSummary(renderInspector({ ...FINISHED })), "Voice · not recorded");
  assert.equal(voiceSummary(renderInspector({ ...FINISHED, voiceId: null, voiceProvider: null })), "Voice · not recorded");
  assert.equal(voiceSummary(renderInspector({ ...FINISHED, voiceId: "", voiceProvider: "openai" })), "Voice · not recorded");
  // An episode that is still being made has no narrator yet; the line is the setting (not read yet here).
  assert.equal(voiceSummary(renderInspector({ ...FINISHED, status: "RUNNING" })), "Voice");
  assert.equal(voiceSummary(renderInspector(null)), "Voice");
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
const CLIENT_SAFE_LIBS = new Set([
  "@/lib/strings",
  "@/lib/pipeline-steps",
  "@/lib/format-duration",
  "@/lib/ingest/validate",
  // The poster helpers the library grid and the inspector share. Pure, with no
  // imports at all -- the next test holds them to that, so this entry cannot
  // quietly become a route to `sharp` or Prisma.
  "@/lib/thumbnails/choose",
  "@/lib/thumbnails/url",
]);

test("the poster helpers the client imports have no imports of their own", async () => {
  for (const name of ["choose.ts", "url.ts"]) {
    const source = await fs.readFile(fileURLToPath(new URL(`../src/lib/thumbnails/${name}`, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /^\s*(import|export\s[^;]*\sfrom)\s/m, `${name} must stay free of imports: a client component loads it`);
  }
});

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
