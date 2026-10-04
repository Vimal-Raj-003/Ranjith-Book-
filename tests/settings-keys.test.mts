import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isSettingKey, validateSetting, SETTING_FALLBACKS, SETTING_KEYS } from "../src/lib/settings/keys";
import { POCKET_VOICES } from "../src/lib/media/pocket-tts";
import { MOODS } from "../src/lib/media/moods";
import { MUSIC_MOODS } from "../src/lib/media/ffmpeg";

test("every key has a fallback", () => {
  for (const k of SETTING_KEYS) assert.equal(typeof SETTING_FALLBACKS[k], "string", `${k} needs a fallback`);
});

test("every fallback is itself a value the contract accepts", () => {
  // A fallback the validator would refuse is a default the operator could never
  // re-select once they had changed it — GET would report a value PUT rejects.
  for (const k of SETTING_KEYS) {
    assert.equal(validateSetting(k, SETTING_FALLBACKS[k]), SETTING_FALLBACKS[k], `${k} fallback must validate`);
  }
});

test("unknown keys are rejected", () => {
  assert.equal(isSettingKey("theme"), true);
  assert.equal(isSettingKey("voiceId"), true);
  assert.equal(isSettingKey("elevenLabsApiKey"), false, "secrets are not settable through this route");
  assert.equal(isSettingKey("__proto__"), false);
  assert.equal(isSettingKey(""), false);
});

test("neither provider secret is on the allow-list", () => {
  // tts.ts reads both through getSetting. If either ever became writable from
  // the browser, any signed-in session could replace the key the server bills.
  for (const secret of ["elevenLabsApiKey", "openaiApiKey"]) {
    assert.equal(isSettingKey(secret), false, `${secret} must not be settable`);
    assert.equal((SETTING_KEYS as readonly string[]).includes(secret), false);
  }
  // Inherited names are not keys either: `includes` on an array, not `in` on an object.
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(isSettingKey(inherited), false, `${inherited} must not be a key`);
  }
});

test("voiceId accepts every shipped Pocket voice and nothing else", () => {
  for (const v of POCKET_VOICES) assert.equal(validateSetting("voiceId", v.id), v.id);
  assert.equal(validateSetting("voiceId", "scarlett"), null);
  assert.equal(validateSetting("voiceId", ""), null);
  assert.equal(validateSetting("voiceId", 7), null);
});

test("musicIntensity accepts 0,1,2 as strings or numbers and nothing else", () => {
  assert.equal(validateSetting("musicIntensity", "1"), "1");
  assert.equal(validateSetting("musicIntensity", 2), "2");
  assert.equal(validateSetting("musicIntensity", "3"), null);
  assert.equal(validateSetting("musicIntensity", -1), null);
  assert.equal(validateSetting("musicIntensity", "1.5"), null);
});

test("a blank value is not a zero", () => {
  // Number("") and Number("  ") are both 0, so a cleared form field would have
  // been stored as "intensity 0" (music off) instead of refused.
  assert.equal(validateSetting("musicIntensity", ""), null);
  assert.equal(validateSetting("musicIntensity", "   "), null);
  assert.equal(validateSetting("musicLevel", ""), null);
});

test("non-finite and non-scalar numbers are refused", () => {
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, true, [], [1], {}]) {
    assert.equal(validateSetting("musicIntensity", bad), null, `intensity ${String(bad)}`);
    assert.equal(validateSetting("musicLevel", bad), null, `level ${String(bad)}`);
  }
});

test("musicLevel is bounded to -40..-6 dB", () => {
  assert.equal(validateSetting("musicLevel", "-22"), "-22");
  assert.equal(validateSetting("musicLevel", -6), "-6");
  assert.equal(validateSetting("musicLevel", -40), "-40");
  assert.equal(validateSetting("musicLevel", -41), null);
  assert.equal(validateSetting("musicLevel", -5), null);
  assert.equal(validateSetting("musicLevel", "loud"), null);
});

test("musicDuck and musicMood accept only their own vocabularies", () => {
  assert.equal(validateSetting("musicDuck", "normal"), "normal");
  assert.equal(validateSetting("musicDuck", "NORMAL"), null);
  assert.equal(validateSetting("musicMood", "auto"), "auto");
  assert.equal(validateSetting("musicMood", "terminal"), "terminal");
  assert.equal(validateSetting("musicMood", "jazz-funk"), null);
});

test("musicMood accepts 'auto' plus exactly the registered moods", () => {
  for (const id of Object.keys(MOODS)) assert.equal(validateSetting("musicMood", id), id);
  // Inherited Object.prototype names must not read as moods.
  for (const inherited of ["constructor", "toString", "__proto__"]) {
    assert.equal(validateSetting("musicMood", inherited), null, inherited);
  }
});

test("voiceProvider accepts the providers tts.ts dispatches on and nothing else", () => {
  for (const p of ["pocket", "elevenlabs", "openai", "system"]) assert.equal(validateSetting("voiceProvider", p), p);
  assert.equal(validateSetting("voiceProvider", "azure"), null);
});

test("theme validation is unchanged", () => {
  assert.equal(validateSetting("theme", "auto"), "auto");
  assert.equal(validateSetting("theme", "spotlight"), "spotlight");
  assert.equal(validateSetting("theme", "nonsense"), null);
});

// ---------------------------------------------------------------------------
// The mood registry has to stay importable from a "use client" component.
// ---------------------------------------------------------------------------

test("ffmpeg's MUSIC_MOODS is the registry moods.ts owns", () => {
  // Deep-equal rather than `===`: under tsx this .mts file loads moods.ts as ESM
  // while ffmpeg.ts (CJS) requires its own instance of it, so the two objects
  // are equal but never identical here. In the app there is one module graph
  // and ffmpeg.ts assigns `MUSIC_MOODS = MOODS` directly, so the bed generator
  // and the settings vocabulary cannot drift apart; this guards the re-export
  // and the four shipped moods.
  assert.deepEqual(MUSIC_MOODS, MOODS);
  assert.deepEqual(Object.keys(MOODS), ["terminal", "spotlight", "blueprint", "editorial"]);
});

test("moods.ts is client-safe: it imports nothing from node or ffmpeg", () => {
  // The same split pipeline-steps.ts makes for the pipeline rail. ffmpeg.ts
  // imports node:child_process, so a "use client" component that reached the
  // mood list through it would drag child_process into the browser bundle,
  // where it cannot resolve. Reading the source is the check because the
  // failure is a bundler error nobody sees until the page is built.
  const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "media", "moods.ts"), "utf8");
  const specifiers = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const s of specifiers) {
    assert.ok(!s.startsWith("node:"), `moods.ts must not import ${s}`);
    assert.ok(!/ffmpeg$/.test(s), `moods.ts must not import ${s}`);
  }
  // The one import it is allowed is a type, which is erased at build time.
  assert.ok(
    /import\s+type\s+\{\s*MusicMood\s*\}\s+from\s+["']\.\/music-synth["']/.test(src),
    "moods.ts should take MusicMood as a type-only import",
  );
});
