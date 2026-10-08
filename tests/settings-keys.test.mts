import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isSettingKey,
  validateSetting,
  voiceProviders,
  POCKET_ONLY_CAPS,
  SETTING_FALLBACKS,
  SETTING_KEYS,
  type VoiceProviderCaps,
} from "../src/lib/settings/keys";
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

test("musicLevel is bounded to -40..-13 dB", () => {
  assert.equal(validateSetting("musicLevel", "-22"), "-22");
  assert.equal(validateSetting("musicLevel", -13), "-13");
  assert.equal(validateSetting("musicLevel", -40), "-40");
  assert.equal(validateSetting("musicLevel", -41), null);
  // -12 and above is where `levelAndFade`'s peak ceiling can hold some mood back
  // (momentum's upper tiers first engage it at about -12.0 to -12.2), so the slider
  // would not be telling the truth: the contract stops short of it.
  assert.equal(validateSetting("musicLevel", -12), null);
  assert.equal(validateSetting("musicLevel", -6), null);
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

// ---------------------------------------------------------------------------
// voiceProvider: a one-way door, because there is no selector for it.
//
// It used to accept all four providers `tts.ts` has code for. `resolveVoice`
// reads the setting verbatim while `voiceId` stays a Pocket id, so `system` off
// macOS and a keyless `elevenlabs`/`openai` all end in `synthSystem`'s throw --
// failing the narration step of every render after that. Ruling R2 ships no
// provider selector, so nothing in the app could set it back. The allow-list is
// therefore what this install can honour, not what the code can dispatch on.
// ---------------------------------------------------------------------------

const caps = (over: Partial<VoiceProviderCaps> = {}): VoiceProviderCaps => ({ ...POCKET_ONLY_CAPS, ...over });

test("voiceProvider accepts pocket always, and nothing else without the means to run it", () => {
  // Pocket is local and needs no key, so it is honourable everywhere.
  for (const c of [POCKET_ONLY_CAPS, caps({ platform: "darwin" }), caps({ elevenLabsKey: "k" })]) {
    assert.equal(validateSetting("voiceProvider", "pocket", c), "pocket");
  }

  // Nothing else, on a machine with no keys and no `say`.
  for (const p of ["elevenlabs", "openai", "system"]) {
    assert.equal(validateSetting("voiceProvider", p, POCKET_ONLY_CAPS), null, `${p} with nothing to run it on`);
  }

  // The omitted-capabilities default is Pocket-only, so forgetting to pass them
  // can only refuse a provider, never admit one this machine cannot run.
  assert.equal(validateSetting("voiceProvider", "pocket"), "pocket");
  for (const p of ["elevenlabs", "openai", "system"]) {
    assert.equal(validateSetting("voiceProvider", p), null, `${p} is not the safe default`);
  }

  // Each one, once it has what it needs -- and only that one.
  assert.equal(validateSetting("voiceProvider", "elevenlabs", caps({ elevenLabsKey: "sk-eleven" })), "elevenlabs");
  assert.equal(validateSetting("voiceProvider", "openai", caps({ elevenLabsKey: "sk-eleven" })), null, "the wrong key is no key");
  assert.equal(validateSetting("voiceProvider", "openai", caps({ openaiKey: "sk-openai" })), "openai");
  assert.equal(validateSetting("voiceProvider", "elevenlabs", caps({ openaiKey: "sk-openai" })), null);

  // `system` is macOS `say`: no key, and the platform is the whole gate.
  assert.equal(validateSetting("voiceProvider", "system", caps({ platform: "darwin" })), "system");
  for (const platform of ["win32", "linux", ""]) {
    assert.equal(validateSetting("voiceProvider", "system", caps({ platform })), null, `system on ${platform || "(unknown)"}`);
  }

  // A key that is only whitespace is not a key.
  assert.equal(validateSetting("voiceProvider", "elevenlabs", caps({ elevenLabsKey: "   " })), null);

  // And a provider this build has no code for at all, however well equipped.
  assert.equal(validateSetting("voiceProvider", "azure", caps({ elevenLabsKey: "k", openaiKey: "k", platform: "darwin" })), null);
  assert.equal(validateSetting("voiceProvider", "", caps({ platform: "darwin" })), null);
  assert.equal(validateSetting("voiceProvider", 7, caps({ platform: "darwin" })), null);
});

test("voiceProviders lists exactly what validateSetting will accept", () => {
  // The list is what a provider selector would offer, if one is ever added
  // (ruling R2 says not yet), so the two must not be able to disagree.
  const every = ["pocket", "elevenlabs", "openai", "system"];
  for (const c of [
    POCKET_ONLY_CAPS,
    caps({ platform: "darwin" }),
    caps({ elevenLabsKey: "k" }),
    caps({ openaiKey: "k" }),
    caps({ elevenLabsKey: "k", openaiKey: "k", platform: "darwin" }),
  ]) {
    const offered = voiceProviders(c);
    assert.equal(offered[0], "pocket", "pocket is always first and always there");
    for (const p of every) {
      assert.equal(validateSetting("voiceProvider", p, c) !== null, offered.includes(p), `${p} for ${JSON.stringify(c)}`);
    }
  }
});

test("the fallback is a provider every install can honour", () => {
  // Otherwise GET would report a default that PUT refuses, on the one setting
  // with no UI to change it back.
  assert.equal(SETTING_FALLBACKS.voiceProvider, "pocket");
  assert.equal(validateSetting("voiceProvider", SETTING_FALLBACKS.voiceProvider, POCKET_ONLY_CAPS), "pocket");
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
  assert.deepEqual(Object.keys(MOODS), [
    "terminal", "spotlight", "blueprint", "editorial", // the four that shipped, first and in this order
    "vista", "tension", "resolve", "nocturne", "momentum", "stark",
  ]);
});

test("the four moods that shipped are, value for value, what they were", () => {
  // The ids alone do not hold them: a mood whose progression, root or chord length
  // changed would keep its id and re-key every old episode that is rendered again.
  // These literals are the values at 9d60a66 (Task 4's move did not touch them,
  // and Task 7's six new moods are added beside them, never in place of them).
  // This is the half of acceptance criterion 19 that the audio comparison in
  // tests/music-moods.test.mts cannot see, because that renders whatever the
  // registry says -- including a registry that has changed.
  assert.deepEqual(
    Object.fromEntries(["terminal", "spotlight", "blueprint", "editorial"].map((id) => [id, MOODS[id]])),
    {
      terminal: {
        id: "terminal",
        progression: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],
        chordSeconds: 4,
        root: 130.81,
      },
      spotlight: {
        id: "spotlight",
        progression: [[0, 3, 7], [5, 8, 12], [10, 14, 17], [7, 10, 14]],
        chordSeconds: 3,
        root: 146.83,
      },
      blueprint: {
        id: "blueprint",
        progression: [[0, 5, 7], [2, 7, 9], [0, 5, 7], [-2, 3, 5]],
        chordSeconds: 5,
        root: 123.47,
      },
      editorial: {
        id: "editorial",
        progression: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
        chordSeconds: 4.5,
        root: 138.59,
      },
    },
  );
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
