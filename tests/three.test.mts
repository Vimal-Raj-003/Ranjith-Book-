import test from "node:test";
import assert from "node:assert/strict";
import { shapeForIcon, type ThreeShapeKind } from "../src/lib/video/scenes/three-shapes";
import type { SceneIcon } from "../src/lib/video/scenes/types";

const icon = (name: string, query = ""): SceneIcon => ({ name, paths: "<path/>", query, score: 0.5 });

test("each shape keyword group is reachable by an icon name alone", () => {
  assert.equal(shapeForIcon(icon("chart-line")), "tetrahedron");
  assert.equal(shapeForIcon(icon("coin")), "sphere");
  assert.equal(shapeForIcon(icon("clock")), "torus");
  assert.equal(shapeForIcon(icon("bulb")), "octahedron");
});

test("an icon that matches nothing falls back to icosahedron, not an exception", () => {
  assert.equal(shapeForIcon(icon("umbrella")), "icosahedron");
  assert.equal(shapeForIcon(icon("chair")), "icosahedron");
});

test("a multi-word, dash-joined keyword matches the whole slug, not a split fragment", () => {
  // Neither "credit" nor "card" alone is a keyword — only "credit-card" is —
  // so this only passes if the classifier checks the slug whole as well as
  // split, the fix `tokensFor` exists for.
  assert.equal(shapeForIcon(icon("credit-card")), "sphere");
  assert.equal(shapeForIcon(icon("arrow-up-right")), "tetrahedron");
});

test("the query text alone can also decide the shape, when the icon's own name is generic", () => {
  assert.equal(shapeForIcon(icon("device", "a rising chart of growth")), "tetrahedron");
  assert.equal(shapeForIcon(icon("device", "coins and a wallet")), "sphere");
});

test("the same icon always resolves to the same shape — no randomness, no model call", () => {
  const a = shapeForIcon(icon("rocket", "climbing fast"));
  const b = shapeForIcon(icon("rocket", "climbing fast"));
  assert.equal(a, b);
});

test("every declared shape kind is one of the five single-group Three.js primitives this module builds", () => {
  // Deliberately not cone/cylinder — see three-shapes.ts's own module doc:
  // both are multi-group geometries, and CylinderGeometry specifically
  // captured as blank in a real hyperframes render where these five did not.
  const kinds: ThreeShapeKind[] = ["tetrahedron", "sphere", "torus", "octahedron", "icosahedron"];
  for (const name of ["chart-line", "coin", "clock", "bulb", "chair"]) {
    assert.ok(kinds.includes(shapeForIcon(icon(name))));
  }
});
