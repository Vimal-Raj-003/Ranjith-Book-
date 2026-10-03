#!/usr/bin/env node
/**
 * How well does each way of describing a hero rank the labelled sentences?
 *   node --import tsx scripts/hero-bench.mjs
 *
 * NON-GATING: it prints a table and always exits 0. It exists so the numbers
 * behind the choices in src/lib/video/scenes/heroes.ts (the two-description form
 * and the similarity floor) can be regenerated, e.g. after Task 2 adds
 * heroes, instead of being trusted from a comment.
 *
 * READ THE RESULT FOR WHAT IT IS. The sentences in tests/fixtures/hero-labels.json
 * were written and labelled by the ranker's author, deliberately without the
 * catalogue's keywords (so the keyword matcher is handicapped by construction),
 * and the shipped formula was picked on this same set (so gains between formulas
 * are in-sample). It shows DIRECTION, not magnitude. It is not an accuracy
 * figure and not evidence of a real-world improvement.
 */
import fs from "node:fs";
import { HERO_IDS, HERO_GUIDE, MIN_HERO_SCORE, heroForTextSync, heroMatch, heroRanker } from "../src/lib/video/scenes/heroes.ts";
import { cosine, lexicalEmbedder, transformersEmbedder } from "../src/lib/analysis/embed.ts";

const fixture = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/hero-labels.json", import.meta.url), "utf8"));
const labelled = fixture.labelled;
const offTopic = fixture.offTopic;
const SPECIFIC = HERO_IDS.filter((h) => h !== "orb");
const G = HERO_GUIDE;

const useWords = (id) => `${G[id].use}. ${G[id].words.join(", ")}`;
/** Each formula describes a hero as one or more texts; a hero scores as the best of them. */
const FORMULAS = {
  "blended: shows + use + words, one text": (id) => [`${G[id].shows}. Use for: ${G[id].use}. ${G[id].words.join(", ")}`],
  "SHIPPED: use + words only": (id) => [useWords(id)],
  "shows only": (id) => [G[id].shows],
  "best of [shows, use + words] (shipped first)": (id) => [G[id].shows, useWords(id)],
};
const SHIPPED = "SHIPPED: use + words only";

/** Per sentence: the heroes with their score, best first, under one formula and embedder. */
async function rankAll(embedder, formula, texts) {
  const parts = SPECIFIC.map(formula);
  const flat = await embedder.embed(parts.flat());
  let k = 0;
  const heroVecs = parts.map((p) => p.map(() => flat[k++]));
  // One text at a time, exactly as heroRanker asks. The q8-quantised model's vectors shift a little with
  // batch composition (the sentences ranked right moved by up to 3 of 56 when embedded as one batch).
  const queries = [];
  for (const t of texts) queries.push((await embedder.embed([t]))[0]);
  return queries.map((q) =>
    SPECIFIC.map((id, i) => ({ id, s: Math.max(...heroVecs[i].map((v) => cosine(q, v))) })).sort((a, b) => b.s - a.s),
  );
}

const pct = (n, d) => `${n}/${d}`;

async function section(name, embedder) {
  console.log(`\n=== ${name} (${embedder.id}) ===`);
  const texts = labelled.map((x) => x.text);
  console.log("formula".padEnd(44), "top-1".padEnd(8), "top-3");
  const shippedRanks = {};
  for (const [label, f] of Object.entries(FORMULAS)) {
    const ranks = await rankAll(embedder, f, texts);
    if (label === SHIPPED) shippedRanks.v = ranks;
    const t1 = ranks.filter((r, i) => r[0].id === labelled[i].hero).length;
    const t3 = ranks.filter((r, i) => r.slice(0, 3).some((x) => x.id === labelled[i].hero)).length;
    console.log(label.padEnd(44), pct(t1, labelled.length).padEnd(8), pct(t3, labelled.length));
  }

  // Floor sweep, for the shipped formula: what each floor would keep, drop and send to the orb.
  const ranks = shippedRanks.v;
  const off = (await rankAll(embedder, FORMULAS[SHIPPED], offTopic)).map((r) => r[0].s);
  const right = ranks.filter((r, i) => r[0].id === labelled[i].hero).map((r) => r[0].s);
  const wrong = ranks.filter((r, i) => r[0].id !== labelled[i].hero).map((r) => r[0].s);
  const grid = [0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28];
  const shipped = MIN_HERO_SCORE;
  console.log(`\nfloor sweep (shipped formula; right = top-1 is the label: ${right.length}, wrong: ${wrong.length}, off-topic: ${off.length})`);
  for (const f of grid) {
    console.log(
      `  floor ${f.toFixed(2)}${f === shipped ? " <- shipped" : "          "}  right kept ${pct(right.filter((s) => s >= f).length, right.length)}   wrong -> orb ${pct(wrong.filter((s) => s < f).length, wrong.length)}   off-topic -> orb ${pct(off.filter((s) => s < f).length, off.length)}`,
    );
  }
  const range = (a) => (a.length ? `${Math.min(...a).toFixed(2)} to ${Math.max(...a).toFixed(2)}` : "none");
  console.log(`  best-score ranges: right ${range(right)}, wrong ${range(wrong)}, off-topic ${range(off)}`);

  // The ranker as shipped, floor included: a below-floor text is the orb, which counts as not-the-label.
  const ranker = await heroRanker(embedder);
  const picks = [];
  for (const x of labelled) picks.push(await ranker.pick(x.text));
  console.log(
    `\nheroRanker.pick as shipped (floor ${shipped}, source ${ranker.source}): top-1 ${pct(picks.filter((p, i) => p === labelled[i].hero).length, labelled.length)}, orb ${picks.filter((p) => p === "orb").length}`,
  );
}

const kwRight = labelled.filter((x) => heroForTextSync(x.text) === x.hero).length;
const kwMatching = labelled.filter((x) => heroMatch(x.text) > 0).length;
console.log(`${labelled.length} author-labelled sentences, ${offTopic.length} off-topic; catalogue of ${SPECIFIC.length} heroes.`);
console.log(`keyword matcher (heroForTextSync): top-1 ${pct(kwRight, labelled.length)}; ${labelled.length - kwMatching} sentences match no keyword at all, ${kwMatching} still match at least one.`);
console.log("Author-labelled, keyword-free by design, formula chosen on this set: direction, not magnitude.");

try {
  await section("semantic", transformersEmbedder);
} catch (err) {
  console.log(`\n=== semantic: skipped, the model is not available (${err instanceof Error ? err.message : err}) ===`);
}

// Degraded mode (no model, or the lexical embedder asked for): the ranker is the keyword matcher itself.
// The bag-of-words embedder was measured as a fallback and ranked about at chance, below the keyword matcher.
const degraded = await heroRanker(lexicalEmbedder);
const degradedPicks = [];
for (const x of labelled) degradedPicks.push(await degraded.pick(x.text));
console.log(`\n=== degraded mode (source ${degraded.source}): heroRanker(lexicalEmbedder) ===`);
console.log(`top-1 ${pct(degradedPicks.filter((p, i) => p === labelled[i].hero).length, labelled.length)}, orb ${degradedPicks.filter((p) => p === "orb").length}; identical to heroForTextSync on every sentence: ${degradedPicks.every((p, i) => p === heroForTextSync(labelled[i].text))}`);
