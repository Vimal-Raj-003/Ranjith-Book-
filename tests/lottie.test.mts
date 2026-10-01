import test from "node:test";
import assert from "node:assert/strict";
import { lottieFor, LOTTIE_CATEGORIES, LOTTIE_DURATION_S, LOTTIE_FRAMES } from "../src/lib/video/scenes/lottie";
import type { EmphasisCategory } from "../src/lib/video/scenes/emphasis";

const ACCENT = "#d9531e";
const ALL_CATEGORIES: EmphasisCategory[] = ["time", "money", "growth", "problem", "solution", "people", "tech", "number"];

test("only the authored categories return a clip; everything else is null, not a guess", () => {
  for (const category of ALL_CATEGORIES) {
    const clip = lottieFor(category, ACCENT);
    if (LOTTIE_CATEGORIES.includes(category)) {
      assert.ok(clip, `${category} is an authored category and should return a clip`);
    } else {
      assert.equal(clip, null, `${category} is not authored yet and must stay null, not a mismatched shape`);
    }
  }
});

test("LOTTIE_CATEGORIES lists exactly the categories lottieFor actually answers for", () => {
  for (const category of LOTTIE_CATEGORIES) {
    assert.ok(lottieFor(category, ACCENT), `${category} is listed but lottieFor returned nothing for it`);
  }
});

test("the same category and colour produce byte-identical JSON on every call — deterministic, no model call, no randomness", () => {
  const a = JSON.stringify(lottieFor("growth", ACCENT));
  const b = JSON.stringify(lottieFor("growth", ACCENT));
  assert.equal(a, b);
});

test("a different theme accent produces a different fill colour, and nothing else about the shape changes", () => {
  const warm = lottieFor("money", "#d9531e");
  const cool = lottieFor("money", "#2f6fed");
  assert.notEqual(JSON.stringify(warm), JSON.stringify(cool));
  // Same geometry, same timing — only the fill colour should differ.
  assert.equal(warm!.op, cool!.op);
  assert.equal(warm!.layers.length, cool!.layers.length);
});

test("every authored clip is a structurally valid, minimal Lottie document", () => {
  for (const category of LOTTIE_CATEGORIES) {
    const clip = lottieFor(category, ACCENT)!;
    assert.equal(clip.ip, 0, `${category}: ip must be 0`);
    assert.ok(clip.op > clip.ip, `${category}: op must be after ip`);
    assert.equal(clip.op, LOTTIE_FRAMES, `${category}: op should match the exported frame count`);
    assert.ok(clip.fr > 0, `${category}: frame rate must be positive`);
    assert.ok(clip.w > 0 && clip.h > 0, `${category}: width/height must be positive`);
    assert.ok(Array.isArray(clip.layers) && clip.layers.length > 0, `${category}: must have at least one layer`);
    assert.equal(clip.assets.length, 0, `${category}: no external assets — everything is inline shapes`);
  }
});

test("every authored clip starts fully hidden — the seek-safety rest state lives inside the animation itself", () => {
  for (const category of LOTTIE_CATEGORIES) {
    const clip = lottieFor(category, ACCENT)!;
    const layer = clip.layers[0] as { ks: { o: { k: { t: number; s: number[] }[] }; s: { k: { t: number; s: number[] }[] } } };
    const firstOpacity = layer.ks.o.k[0];
    const firstScale = layer.ks.s.k[0];
    assert.equal(firstOpacity.t, 0);
    assert.equal(firstOpacity.s[0], 0, `${category}: frame 0 opacity must be 0 — a seek to before this clip's tween starts must show nothing`);
    assert.equal(firstScale.t, 0);
    assert.equal(firstScale.s[0], 0, `${category}: frame 0 scale must be 0, same reason`);
  }
});

test("the clip duration matches what render.ts's tween is told to run for", () => {
  // Guards against the two files drifting apart — render.ts imports
  // LOTTIE_DURATION_S rather than restating 1.1 itself for exactly this.
  assert.equal(Math.round(LOTTIE_DURATION_S * 30), LOTTIE_FRAMES);
});

test("an unrecognisable accent colour still returns a usable clip rather than throwing", () => {
  assert.doesNotThrow(() => lottieFor("growth", "not-a-colour"));
  const clip = lottieFor("growth", "not-a-colour");
  assert.ok(clip);
});

test("every animated (a:1) keyframe carries bezier easing — lottie-web does not fall back to linear without it", () => {
  // A real, load-bearing regression guard, not a style preference: measured
  // directly against lottie-web, an animated keyframe pair with no `i`/`o`
  // does not interpolate at all — the shape it drives renders as an empty
  // <path> with no `d` attribute at every frame, present in the DOM and
  // completely invisible, with no thrown error anywhere a unit test would
  // see it. Only a real browser rendering a real frame caught this the
  // first time (scripts/verify-lottie.mjs) — this test exists so the next
  // regression of the same mistake is caught here instead.
  function walk(node: unknown, path: string, problems: string[]): void {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.a === 1 && Array.isArray(obj.k)) {
      const keyframes = obj.k as Record<string, unknown>[];
      for (let i = 0; i < keyframes.length - 1; i++) {
        // The convention this file follows: the first keyframe carries
        // both o (outgoing) and i (incoming); later non-terminal keyframes
        // would need the same, though nothing here currently has more than
        // two keyframes on one property.
        if (i === 0 && (!keyframes[i].o || !keyframes[i].i)) {
          problems.push(`${path}: animated keyframe ${i} is missing i/o easing`);
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) walk(value, `${path}.${key}`, problems);
  }

  for (const category of LOTTIE_CATEGORIES) {
    const clip = lottieFor(category, ACCENT)!;
    const problems: string[] = [];
    walk(clip, category, problems);
    assert.deepEqual(problems, []);
  }
});
