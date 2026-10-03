#!/usr/bin/env node
/**
 * How well does each way of describing a hero rank the labelled sentences?
 *   node --import tsx scripts/hero-bench.mjs            the tables
 *   node --import tsx scripts/hero-bench.mjs --detail   ...and every sentence the shipped form gets wrong
 *
 * NON-GATING: it prints a table and always exits 0. It exists so the numbers
 * behind the choices in src/lib/video/scenes/heroes.ts (how a hero is described
 * for the embedder, which is its `use` and `words`, and the similarity floor) can
 * be regenerated, e.g. after the catalogue changes, instead of being trusted from
 * a comment.
 *
 * READ THE RESULT FOR WHAT IT IS. Three kinds of evidence, in falling order of weakness:
 *  - `labelled` (tests/fixtures/hero-labels.json): written and labelled by the ranker's
 *    author. The first 56 deliberately avoid the catalogue's keywords (so the keyword
 *    matcher is handicapped by construction); the last 28 are plain narration that often
 *    uses a hero's own word. The formula was picked, and the newest heroes' descriptions
 *    tuned, on this same set: every figure on it is IN-SAMPLE. It shows direction, not
 *    magnitude, and the two groups measure different regimes, so they are reported apart.
 *  - `heldOut` (same file): written by the same author AFTER the descriptions of the new
 *    heroes existed, from the same vocabulary (the bench counts how many use one of their
 *    hero's own words). Not tuned against, but not independent.
 *  - the real scenes (tests/fixtures/real-scenes.json): narration from rendered projects,
 *    hand-labelled with the heroes a viewer would accept. The closest thing to independent
 *    evidence here, with one labeller; its own readme says how it was and was not used.
 */
import fs from "node:fs";
import { HERO_IDS, HERO_GUIDE, MIN_HERO_SCORE, heroForTextSync, heroMatch, heroRanker, heroScores } from "../src/lib/video/scenes/heroes.ts";
import { cosine, lexicalEmbedder, transformersEmbedder } from "../src/lib/analysis/embed.ts";

const fixture = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/hero-labels.json", import.meta.url), "utf8"));
const labelled = fixture.labelled;
const offTopic = fixture.offTopic;
const heldOut = fixture.heldOut ?? [];
/** Index ranges of `labelled`: the sentences written to avoid keywords, and the ones written as plain narration. */
const GROUPS = fixture.groups ?? { keywordFree: [0, labelled.length], plain: [labelled.length, labelled.length] };
const realFile = new URL("../tests/fixtures/real-scenes.json", import.meta.url);
const real = fs.existsSync(realFile) ? JSON.parse(fs.readFileSync(realFile, "utf8")).scenes : [];
const DETAIL = process.argv.includes("--detail");
const SPECIFIC = HERO_IDS.filter((h) => h !== "orb");
/** The seven heroes the second task added (mind, storm, rest, dialogue, wall, heart, loop): what "without them" means below. */
const ADDED = ["mind", "storm", "rest", "dialogue", "wall", "heart", "loop"];
const ORIGINAL = SPECIFIC.filter((h) => !ADDED.includes(h));
const G = HERO_GUIDE;

const heroText = (id) => `${G[id].use}. ${G[id].words.join(", ")}`;
/** Each formula describes a hero as one or more texts; a hero scores as the best of them. */
const FORMULAS = {
  "blended: shows + use + words, one text": (id) => [`${G[id].shows}. Use for: ${G[id].use}. ${G[id].words.join(", ")}`],
  "SHIPPED: use + words only": (id) => [heroText(id)],
  "shows only": (id) => [G[id].shows],
  "best of [shows, use + words] (first tried)": (id) => [G[id].shows, heroText(id)],
};
const SHIPPED = "SHIPPED: use + words only";

/** Per sentence: the heroes (`ids`, in catalogue order) with their score, best first, under one formula and embedder. */
async function rankAll(embedder, formula, texts, ids = SPECIFIC) {
  const parts = ids.map(formula);
  const flat = await embedder.embed(parts.flat());
  let k = 0;
  const heroVecs = parts.map((p) => p.map(() => flat[k++]));
  // One text at a time, exactly as heroRanker asks. The q8-quantised model's vectors shift a little with
  // batch composition, and the hero descriptions are one batch too: describing ONE hero differently moves the others.
  const queries = [];
  for (const t of texts) queries.push((await embedder.embed([t]))[0]);
  return queries.map((q) =>
    ids.map((id, i) => ({ id, s: Math.max(...heroVecs[i].map((v) => cosine(q, v))) })).sort((a, b) => b.s - a.s),
  );
}

const pct = (n, d) => `${n}/${d}`;
const top1 = (ranks, items) => ranks.filter((r, i) => r[0].id === items[i].hero).length;
const top3 = (ranks, items) => ranks.filter((r, i) => r.slice(0, 3).some((x) => x.id === items[i].hero)).length;
const show = (r) => r.slice(0, 3).map((x) => `${x.id} ${x.s.toFixed(2)}`).join(", ");
const slice = (a, [from, to]) => a.slice(from, to);
/** Whether a sentence contains a word from its own hero's keyword list (heroScores is the keyword matcher's own count). */
const usesOwnWord = (x) => heroScores(x.text)[x.hero] > 0;

/** Real-scene outcome of picking `pick` (a hero id or "orb") for a scene: "ok" if accepted, else "orb" (generic where a hero was wanted) or "wrong". */
const outcome = (x, pick) => (x.accept.includes(pick) ? "ok" : pick === "orb" ? "orb" : "wrong");
const tally = (xs, picks) => {
  const t = { ok: 0, wrong: 0, orb: 0 };
  xs.forEach((x, i) => t[outcome(x, picks[i])]++);
  return `ok ${t.ok}, wrong hero ${t.wrong}, generic orb where a hero was wanted ${t.orb}`;
};

async function section(name, embedder) {
  const grid = [0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28, 0.3];
  const shipped = MIN_HERO_SCORE;
  console.log(`\n=== ${name} (${embedder.id}) ===`);
  const texts = labelled.map((x) => x.text);
  const kf = slice(labelled, GROUPS.keywordFree), pl = slice(labelled, GROUPS.plain);
  console.log("formula".padEnd(44), `top-1 on the ${kf.length} keyword-free`.padEnd(30), `on the ${pl.length} plain`.padEnd(16), "all", " top-3 (all)");
  const shippedRanks = {};
  for (const [label, f] of Object.entries(FORMULAS)) {
    const ranks = await rankAll(embedder, f, texts);
    if (label === SHIPPED) shippedRanks.v = ranks;
    const a = slice(ranks, GROUPS.keywordFree), b = slice(ranks, GROUPS.plain);
    console.log(label.padEnd(44), pct(top1(a, kf), kf.length).padEnd(30), pct(top1(b, pl), pl.length).padEnd(16), pct(top1(ranks, labelled), labelled.length).padEnd(5), pct(top3(ranks, labelled), labelled.length));
  }
  console.log(`  (the plain ${pl.length}: ${pl.filter(usesOwnWord).length} contain a word from their own hero's list, the keyword-free ${kf.length}: ${kf.filter(usesOwnWord).length})`);

  // The same shipped formula over the first group with and without the seven added heroes: what adding them did to the heroes that were already there.
  const without = await rankAll(embedder, FORMULAS[SHIPPED], kf.map((x) => x.text), ORIGINAL);
  console.log(`  the ${kf.length} keyword-free, catalogue without the seven added heroes (${ORIGINAL.length}, their current wording): top-1 ${pct(top1(without, kf), kf.length)}; with all ${SPECIFIC.length}: ${pct(top1(slice(shippedRanks.v, GROUPS.keywordFree), kf), kf.length)}`);

  // Per hero, for the shipped formula: where the catalogue is strong and where a hero's sentences go elsewhere.
  const ranks = shippedRanks.v;
  console.log("\nper hero, shipped formula (top-1 / top-3 of that hero's labelled sentences; where its misses went)");
  for (const id of SPECIFIC) {
    const mine = labelled.map((x, i) => ({ x, r: ranks[i] })).filter(({ x }) => x.hero === id);
    if (!mine.length) continue;
    const went = mine.filter(({ r }) => r[0].id !== id).map(({ r }) => r[0].id);
    console.log(`  ${id.padEnd(11)} ${pct(mine.filter(({ r }) => r[0].id === id).length, mine.length)} / ${pct(mine.filter(({ r }) => r.slice(0, 3).some((y) => y.id === id)).length, mine.length)}${went.length ? `   misses -> ${went.join(", ")}` : ""}`);
  }
  if (DETAIL) {
    console.log("\nsentences the shipped formula ranks wrong (label; best three)");
    labelled.forEach((x, i) => {
      if (ranks[i][0].id !== x.hero) console.log(`  [${x.hero}] ${x.text}\n      -> ${show(ranks[i])}   (label rank ${ranks[i].findIndex((y) => y.id === x.hero) + 1}, ${ranks[i].find((y) => y.id === x.hero).s.toFixed(2)})`);
    });
  }

  // Floor sweep, for the shipped formula: what each floor would keep, drop and send to the orb.
  const off = (await rankAll(embedder, FORMULAS[SHIPPED], offTopic)).map((r) => r[0].s);
  const right = ranks.filter((r, i) => r[0].id === labelled[i].hero).map((r) => r[0].s);
  const wrong = ranks.filter((r, i) => r[0].id !== labelled[i].hero).map((r) => r[0].s);
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

  if (heldOut.length) {
    const hr = await rankAll(embedder, FORMULAS[SHIPPED], heldOut.map((x) => x.text));
    console.log(`\nheld-out (${heldOut.length} sentences by the same author, written after the new heroes' first descriptions existed and not tuned against; ${heldOut.filter(usesOwnWord).length} of them contain a word from their own hero's list): top-1 ${pct(top1(hr, heldOut), heldOut.length)}, top-3 ${pct(top3(hr, heldOut), heldOut.length)}`);
    heldOut.forEach((x, i) => console.log(`  ${hr[i][0].id === x.hero ? "ok  " : "MISS"} [${x.hero}] ${x.text}\n        -> ${show(hr[i])}`));
  }

  if (real.length) {
    console.log(`\nreal scenes (${real.length} narrations from rendered projects, hand-labelled with the heroes a viewer would accept; floor ${shipped}):`);
    const kw = real.map((x) => heroForTextSync(x.text));
    console.log(`  keyword matcher (heroForTextSync):                    ${tally(real, kw)}`);
    for (const [label, ids] of [[`semantic, ${ORIGINAL.length} heroes (without the seven added)`, ORIGINAL], [`semantic, all ${SPECIFIC.length} heroes`, SPECIFIC]]) {
      const rr = await rankAll(embedder, FORMULAS[SHIPPED], real.map((x) => x.text), ids);
      const best = rr.filter((r, i) => real[i].accept.includes(r[0].id)).length;
      const pk = rr.map((r) => (r[0].s >= shipped ? r[0].id : "orb"));
      console.log(`  ${label.padEnd(54)}${tally(real, pk)}; best hero accepted ${pct(best, real.length)} before the floor, ${pct(rr.filter((r) => r[0].s < shipped).length, real.length)} below the floor`);
      if (ids === SPECIFIC) {
        for (const f of grid) {
          const at = rr.map((r) => (r[0].s >= f ? r[0].id : "orb"));
          console.log(`      floor ${f.toFixed(2)}${f === shipped ? " <- shipped" : "          "}  ${tally(real, at)}`);
        }
      }
      if (DETAIL && ids === SPECIFIC) real.forEach((x, i) => { if (outcome(x, pk[i]) !== "ok") console.log(`    ${outcome(x, pk[i]).toUpperCase().padEnd(5)} ${pk[i]} ${rr[i][0].s.toFixed(2)} (accept ${x.accept.join("/")}) | ${x.text.slice(0, 100)}`); });
    }
  }

  // Not shipped: the bag-of-words embedder the ranker no longer uses, kept as the number the comments in heroes.ts cite.
  const lex = await rankAll(lexicalEmbedder, FORMULAS[SHIPPED], texts);
  console.log(`\nfor reference, NOT shipped: the bag-of-words (lexical) embedder on the same sentences: top-1 ${pct(top1(lex, labelled), labelled.length)}, top-3 ${pct(top3(lex, labelled), labelled.length)}`);
}

const kwRight = labelled.filter((x) => heroForTextSync(x.text) === x.hero).length;
const kwMatching = labelled.filter((x) => heroMatch(x.text) > 0).length;
console.log(`${labelled.length} author-labelled sentences, ${offTopic.length} off-topic; catalogue of ${SPECIFIC.length} heroes.`);
console.log(`keyword matcher (heroForTextSync): top-1 ${pct(kwRight, labelled.length)} (${pct(slice(labelled, GROUPS.keywordFree).filter((x) => heroForTextSync(x.text) === x.hero).length, GROUPS.keywordFree[1] - GROUPS.keywordFree[0])} on the keyword-free group); ${labelled.length - kwMatching} sentences match no keyword at all, ${kwMatching} still match at least one.`);
console.log("Author-labelled, formula and descriptions tuned on this set: in-sample, direction not magnitude.");

try {
  await section("semantic", transformersEmbedder);
} catch (err) {
  console.log(`\n=== semantic: skipped, the model is not available (${err instanceof Error ? err.message : err}) ===`);
}

// Degraded mode (no model, or the lexical embedder asked for): the ranker is the keyword matcher itself.
// The bag-of-words embedder was measured as a fallback and ranked below the keyword matcher (the line above, "NOT shipped").
const degraded = await heroRanker(lexicalEmbedder);
const degradedPicks = [];
for (const x of labelled) degradedPicks.push(await degraded.pick(x.text));
console.log(`\n=== degraded mode (source ${degraded.source}): heroRanker(lexicalEmbedder) ===`);
console.log(`top-1 ${pct(degradedPicks.filter((p, i) => p === labelled[i].hero).length, labelled.length)}, orb ${degradedPicks.filter((p) => p === "orb").length}; identical to heroForTextSync on every sentence: ${degradedPicks.every((p, i) => p === heroForTextSync(labelled[i].text))}`);
