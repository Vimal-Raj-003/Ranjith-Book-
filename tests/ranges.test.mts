import test from "node:test";
import assert from "node:assert/strict";
import { checkRanges } from "../src/lib/content/ranges";
import type { Beat } from "../src/lib/content/schema";

const beat = (sourcePage: number, startWord: number, endWord: number, id = "b"): Beat => ({ id, voiceover: "v", onScreen: "", sourcePage, startWord, endWord });
const pages = new Map([[5, 300], [6, 250]]);

test("valid forward ranges pass untouched, and sharing one boundary word is allowed", () => {
  const r = checkRanges([beat(5, 10, 40), beat(5, 40, 80), beat(6, 0, 20), beat(6, 20, 20)], pages);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.repairs, []);
});

test("a call to action that re-uses the previous beat's range is moved to rest where that beat ended", () => {
  // Measured: "beats[7] (CTA) duplicates b7's range exactly (168-175)".
  const r = checkRanges([beat(5, 100, 160), beat(5, 168, 175), beat(5, 168, 175, "cta")], pages);
  assert.deepEqual(r.problems, []);
  assert.deepEqual([r.beats[2].startWord, r.beats[2].endWord], [175, 175]);
  assert.equal(r.repairs.length, 1);
});

test("a content beat that only overlaps the previous one is trimmed to where that one ended — never widened", () => {
  // Measured: "b3 starts at word 148, which is BEFORE b2's endWord (149)".
  const r = checkRanges([beat(5, 120, 149), beat(5, 148, 155), beat(5, 160, 170, "cta")], pages);
  assert.deepEqual(r.problems, []);
  assert.deepEqual([r.beats[1].startWord, r.beats[1].endWord], [149, 155], "shrunk to the words only it covers");
  assert.ok(r.beats[1].startWord >= 148 && r.beats[1].endWord <= 155, "inside the words the writer chose");
});

test("a beat wholly behind the previous one is sent back to the writer, not guessed at", () => {
  const r = checkRanges([beat(5, 120, 160), beat(5, 100, 130), beat(5, 170, 175, "cta")], pages);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /beats\[1\].*wholly at or before the previous beat's range/);
});

test("out-of-bounds and inverted ranges, and unknown pages, are problems", () => {
  assert.match(checkRanges([beat(5, 10, 300)], pages).problems[0], /runs 0–299/);
  assert.match(checkRanges([beat(5, 20, 10)], pages).problems[0], /startWord must be ≤ endWord/);
  assert.match(checkRanges([beat(9, 0, 1)], pages).problems[0], /not one of the pages/);
});

test("beats on different pages are not compared, and the input is not mutated", () => {
  const input = [beat(5, 200, 250), beat(6, 0, 30), beat(6, 10, 40, "cta")];
  const r = checkRanges(input, pages);
  assert.deepEqual(r.problems, []);
  assert.deepEqual([r.beats[2].startWord, r.beats[2].endWord], [30, 40]);
  assert.equal(input[2].startWord, 10, "the caller's beats are untouched");
});

test("a content beat covering only the previous beat's last word is a problem; the call to action may rest there", () => {
  // Measured: "beats[6] uses startWord 175 and endWord 175 … the same word beats[5] already ends on".
  const r = checkRanges([beat(5, 150, 175), beat(5, 175, 175), beat(5, 180, 190, "cta")], pages);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /covers only the last word of the previous beat's range/);
  assert.deepEqual(checkRanges([beat(5, 150, 175), beat(5, 175, 175, "cta")], pages).problems, []);
});
