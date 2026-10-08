import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as inspectorModule from "../src/components/Inspector";
import { POCKET_VOICES, DEFAULT_POCKET_VOICE } from "../src/lib/media/pocket-tts";
import {
  VOICES,
  DEFAULT_VOICE_ID,
  VIDEO_THEMES,
  strings,
  recordedVoiceName,
  AUTO_MUSIC_MOOD,
  MUSIC_MOOD_OPTIONS,
  MUSIC_INTENSITIES,
  MUSIC_DUCKS,
  MUSIC_LEVEL_RANGE,
} from "../src/lib/strings";

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

test("the voice picker has a Preview button, and the cold-start wait is explained beside it", () => {
  const html = renderInspector(null);
  const button = html.match(/<button[^>]*>\s*Preview\s*<\/button>/)?.[0] ?? "";
  assert.ok(button, "a Preview button is rendered");
  // aria-disabled, never disabled: a button that disables itself while it waits drops keyboard
  // focus, and the slow first preview is exactly when someone is sitting on it.
  assert.doesNotMatch(button, /\sdisabled[\s=>]/, "it must not use the disabled attribute");
  assert.match(button, /aria-disabled="true"/, "and until the setting is read there is no voice to play");
  const hintId = button.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(hintId, "the button points at its hint");
  const hint = html.match(new RegExp(`<p class="hint" id="${hintId}">([^<]*)</p>`))?.[1] ?? "";
  assert.match(hint, /twenty-five seconds/, "the hint says the first preview is slow, and why");
  assert.match(hint, /model loads/);
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

/** The music panel's markup: from its own `<details>` to the one that follows it. */
function musicPanel(html: string): string {
  const m = html.match(/<details[^>]*><summary>Music[^<]*<\/summary>[\s\S]*?<\/details>/);
  assert.ok(m, "the music panel is rendered");
  return m[0];
}

test("the music panel writes: a mood picker, three layers, a level slider and a duck picker", () => {
  const panel = musicPanel(renderInspector(null));
  // Not read-only any more: nothing here may be the old StatRow rows.
  assert.doesNotMatch(panel, /there is nothing to choose separately/);

  const selects = [...panel.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(selects.length, 2, "a mood select and a duck select");
  for (const s of selects) assert.doesNotMatch(s[0].match(/<select[^>]*>/)![0], /disabled/, "a select that disables itself drops keyboard focus");

  const options = (select: string) => [...select.matchAll(/<option value="([^"]*)"/g)].map((o) => o[1]).filter(Boolean);
  assert.deepEqual(options(selects[0][1]), [AUTO_MUSIC_MOOD.id, ...MUSIC_MOOD_OPTIONS.map((m) => m.id)], "Follows the theme first, then every mood");
  assert.deepEqual(options(selects[1][1]), MUSIC_DUCKS.map((d) => d.id));
  // Until the settings are read neither has a value, and says so rather than naming a default.
  assert.match(selects[0][1], /<option value="" disabled="" selected="">Choose a mood<\/option>/);
});

test("every control in the music panel is described by a hint a screen reader can reach", () => {
  const panel = musicPanel(renderInspector(null));
  // The mood and duck selects point at the panel's hint; without that, a screen-reader
  // user never hears what the panel says about when a change applies and what the
  // level means. (The voice select does the same with its hint.)
  const selects = [...panel.matchAll(/<select[^>]*>/g)].map((m) => m[0]);
  assert.equal(selects.length, 2);
  const hintId = selects[0].match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(hintId, "the mood select names a hint");
  assert.equal(selects[1].match(/aria-describedby="([^"]+)"/)?.[1], hintId, "and the duck select names the same one");
  const hint = panel.match(new RegExp(`<p class="hint" id="${hintId}">([^<]*)</p>`))?.[1];
  assert.ok(hint, "which exists, with that id");
  assert.equal(hint.replace(/&#x27;/g, "'"), strings.musicPanel.hint, "and says the panel's hint, whole");
  // The layers group is described by the note for the tier it is on; the slider by its own value text.
  const group = panel.match(/<div role="group"[^>]*aria-describedby="([^"]+)"/)?.[1];
  assert.ok(group && panel.includes(`id="${group}"`), "the layers group names a note that exists");
});

test("the layers control is a labelled group of three toggle buttons", () => {
  const panel = musicPanel(renderInspector(null));
  const group = panel.match(/<div role="group" aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(group, "a role=group");
  assert.match(panel, new RegExp(`id="${group[1]}">Layers<`), "named by its visible label");
  const buttons = [...group[2].matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*><span class="truncate">([^<]*)<\/span><\/button>/g)];
  assert.deepEqual(buttons.map((b) => b[2]), MUSIC_INTENSITIES.map((o) => o.label));
  assert.ok(buttons.every((b) => b[1] === "false"), "none pressed until the setting is read");
  for (const b of group[2].matchAll(/<button[^>]*>/g)) assert.doesNotMatch(b[0], /\sdisabled[\s=>]/);
});

test("the level slider spans the dB range the setting accepts and waits for a value", () => {
  const panel = musicPanel(renderInspector(null));
  const slider = panel.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? "";
  assert.ok(slider, "a range input");
  assert.match(slider, new RegExp(`min="${MUSIC_LEVEL_RANGE.min}"`));
  assert.match(slider, new RegExp(`max="${MUSIC_LEVEL_RANGE.max}"`));
  assert.match(slider, /step="1"/, "whole dB: the server refuses a fraction");
  assert.match(slider, /disabled=""/, "no thumb position is claimed before the setting is read");
  const id = slider.match(/id="([^"]+)"/)![1];
  assert.match(panel, new RegExp(`<label[^>]*for="${id}">Bed level</label>`), "and it has a label");
});

test("a music summary names what a render will use, and says nothing before it is known", () => {
  // Effects have not run in a server render, so no setting has been read.
  assert.match(renderInspector(null), /<summary>Music<\/summary>/);
  assert.equal(strings.musicPanel.summary(AUTO_MUSIC_MOOD.label), "Music · Follows the theme");
  assert.equal(strings.musicPanel.summary("Vista"), "Music · Vista");
});

test("the level reading says where the bed sits against the narration", () => {
  assert.equal(strings.musicPanel.levelValue(-22), "−22 dB · about 6 dB under the narration");
  assert.equal(strings.musicPanel.levelValue(-16), "−16 dB · level with the narration");
  assert.equal(strings.musicPanel.levelValue(-10), "−10 dB · about 6 dB over the narration");
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
  // The state machine behind the inspector's optimistic setting writes. Pure, and
  // held to having no imports by the test below, for the same reason.
  "@/lib/setting-writes",
  // Which cover sizes exist and the URL a book card asks for. Pure, and held to
  // having no imports by `tests/covers.test.mts` -- the derivation (sharp, the
  // work root) is `@/lib/covers/derive`, which no component may import.
  "@/lib/covers/sizes",
  // The Publish Center's three: the platform limits and status vocabulary, the
  // readiness verdict, and the wire shape of `GET .../publish`. All three are
  // pure, and `tests/publish.test.mts` holds the whole folder-minus-three to
  // having no node, Prisma or `@/lib` imports -- so none of these can quietly
  // become a route to `state.ts`, which DOES import Prisma and the work root
  // and which no component may ever import.
  "@/lib/publish/limits",
  "@/lib/publish/readiness",
  "@/lib/publish/view",
  // The connection card's fourth: the wire shape of a platform OAuth grant and
  // the words said about it. Import-free, and held to that by
  // `tests/publish-youtube.test.mts` -- which also proves it has no field a
  // token could be put in, so nothing in `youtube/` (Prisma, node:crypto, the
  // client secret) can reach the browser through it.
  "@/lib/publish/connect",
]);

test("the poster helpers the client imports have no imports of their own", async () => {
  for (const name of ["choose.ts", "url.ts"]) {
    const source = await fs.readFile(fileURLToPath(new URL(`../src/lib/thumbnails/${name}`, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /^\s*(import|export\s[^;]*\sfrom)\s/m, `${name} must stay free of imports: a client component loads it`);
  }
});

test("the setting-write state machine has no imports of its own", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/lib/setting-writes.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /^\s*(import|export\s[^;]*\sfrom)\s/m, "setting-writes.ts must stay free of imports: Inspector loads it in the browser");
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
