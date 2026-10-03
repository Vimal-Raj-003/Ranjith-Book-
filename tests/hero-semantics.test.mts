import test from "node:test";
import assert from "node:assert/strict";
import { heroRanker, heroForTextSync, heroMatch, HERO_IDS, HERO_GUIDE, type HeroId } from "../src/lib/video/scenes/heroes";
import { lexicalEmbedder, type Embedder } from "../src/lib/analysis/embed";
import { planScenes } from "../src/lib/video/scenes";
import type { Beat } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";

// --- helpers ---------------------------------------------------------------------

/**
 * An embedder whose vectors are chosen by the test, so ranking can be proved to
 * come from the embedder and not from the keyword matcher. A text that contains
 * a hero's own `shows` or `use` text is that hero's one-hot vector (these are what
 * the ranker's descriptions of the hero are made of); a text of the form `want:<id> ...`
 * is the same vector, whatever else it says. Everything else is a vector
 * orthogonal to every hero.
 */
function stubEmbedder(opts: { failAfter?: number; failMessage?: string } = {}): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const DIM = HERO_IDS.length + 1;
  return {
    id: "stub-embedder",
    calls,
    async embed(texts) {
      if (opts.failAfter !== undefined && calls.length >= opts.failAfter) throw new Error(opts.failMessage ?? "stub embedder failed");
      calls.push(texts);
      return texts.map((t) => {
        const v = new Float32Array(DIM);
        const want = /^want:(\w+)/.exec(t)?.[1];
        const idx = HERO_IDS.findIndex((id) => id === want || t.includes(HERO_GUIDE[id].shows) || t.includes(HERO_GUIDE[id].use));
        v[idx >= 0 ? idx : DIM - 1] = 1;
        return v;
      });
    },
  };
}

const failing: Embedder = {
  id: "never-loads",
  async embed() {
    throw new Error("no cached model and no network");
  },
};

// --- the ranker ------------------------------------------------------------------

test("a ranker built on the lexical fallback still returns a real hero for anything", async () => {
  const r = await heroRanker(lexicalEmbedder);
  assert.equal(r.source, "lexical");
  for (const text of ["", "zzz qqq xyzzy", "Pleasure and pain happen inside the skull"]) {
    assert.ok(HERO_IDS.includes(await r.pick(text)), `"${text}" produced a real hero`);
  }
});

// Task 2 adds the heroes these sentences are about (mind, rest, storm, dialogue).
// Until then the catalogue has nothing honest to pick for them, so this cannot
// pass. Task 2 removes the `todo`.
test(
  "semantic ranking beats keyword counting on concepts the catalogue states but does not spell",
  { todo: "Task 2 adds the mind / rest / storm / dialogue heroes" },
  async () => {
    const r = await heroRanker();
    // These are the exact sentences that scored 0 against the keyword matcher and fell to `orb`.
    const cases: [string, string[]][] = [
      ["Pleasure and pain happen inside the skull", ["mind"]],
      ["Your memory fails you when you need it most", ["mind"]],
      ["Sleep repairs the body while you do nothing", ["rest"]],
      ["Fear keeps you from ever starting", ["storm", "wall"]],
      ["Anger floods you before you can think", ["storm"]],
      ["A conversation changes how both people see it", ["dialogue"]],
    ];
    for (const [text, acceptable] of cases) {
      const got = await r.pick(text);
      assert.ok(acceptable.includes(got), `"${text}" -> ${got}, wanted one of ${acceptable.join("/")}`);
    }
  },
);

test("the real embedder ranks paraphrases the keyword matcher cannot see, using heroes that exist today", async (t) => {
  const r = await heroRanker();
  if (r.source !== "embedding") return t.skip("the semantic model is not available on this machine");
  // Regression guards on the catalogue as it stands, not a measure of accuracy: each says an idea a
  // hero is FOR without using any word on its keyword list. (Measured over a wider hand-labelled
  // set the embedder ranks the intended hero first about two times in three, the keyword matcher
  // about one in ten; the report has the numbers.) A new hero added to the catalogue may
  // legitimately take one of these, and then the sentence should change, not the ranker.
  const cases: [string, HeroId][] = [
    ["Forgive them, or stay tied to the person who hurt you", "chain"],
    ["A thousand tiny repetitions turn into mastery", "staircase"],
    ["Strangers become allies when you show up for them", "network"],
    ["The scale tips toward the heavier side", "scales"],
  ];
  for (const [text, want] of cases) {
    assert.equal(heroMatch(text), 0, `"${text}" must be a sentence the keyword matcher scores 0 on`);
    assert.equal(heroForTextSync(text), "orb", "so the old matcher would have shown the generic orb");
    assert.equal(await r.pick(text), want, `"${text}"`);
  }
});

test("the ranker respects `avoid`, and falls back to its best pick when everything is used", async () => {
  const r = await heroRanker();
  const text = "Time runs out while you wait";
  const first = await r.pick(text);
  const second = await r.pick(text, [first]);
  assert.notEqual(second, first);
  assert.equal(await r.pick(text, HERO_IDS), first, "when all are used the best pick repeats rather than failing");
});

test("the synchronous keyword matcher is still available as the never-unavailable fallback", () => {
  assert.ok(HERO_IDS.includes(heroForTextSync("time is running out")));
  assert.equal(heroForTextSync("zzz qqq"), "orb");
});

// --- a repair pass can never silently get keyword matching ------------------------

test("a text the ranker has never seen is ranked by the embedder, not by keyword counting", async () => {
  const stub = stubEmbedder();
  const r = await heroRanker(stub);
  assert.equal(r.source, "embedding");
  // No hero word appears in this sentence, and nothing prepared it.
  assert.equal(heroMatch("want:staircase glorp"), 0);
  assert.equal(await r.pick("want:staircase glorp"), "staircase");
  assert.equal(await r.pick("want:chain glorp"), "chain");
  // And the answer is the embedder's even where the keyword matcher has a (different) opinion.
  assert.equal(heroForTextSync("want:path time deadline"), "hourglass");
  assert.equal(await r.pick("want:path time deadline"), "path");
});

test("each distinct text is embedded once, however many passes ask about it", async () => {
  const stub = stubEmbedder();
  const r = await heroRanker(stub);
  const heroCalls = stub.calls.length;
  await r.pick("want:path one");
  await r.pick("want:path one", ["path"]);
  await r.score("want:path one");
  assert.equal(stub.calls.length, heroCalls + 1, "three questions about one text cost one embedding");
  assert.deepEqual(stub.calls.at(-1), ["want:path one"]);
});

test("blank narration has nothing to rank, so it gets the generic backdrop without asking the embedder", async () => {
  const stub = stubEmbedder();
  const r = await heroRanker(stub);
  const before = stub.calls.length;
  assert.equal(await r.pick("   "), "orb");
  assert.equal(await r.score(""), 0);
  assert.equal(stub.calls.length, before);
});

test("score is how well the best hero fits, so a near-miss scores lower than a match", async () => {
  const r = await heroRanker(stubEmbedder());
  assert.equal(await r.score("want:growth x"), 1);
  assert.equal(await r.score("nothing relevant at all"), 0);
});

// --- degradation never fails a plan -----------------------------------------------

test("with no usable model the ranker is built on the lexical embedder and says why", async () => {
  const r = await heroRanker(failing);
  assert.equal(r.source, "lexical");
  assert.match(r.degradedBecause ?? "", /no cached model and no network/);
  assert.ok(HERO_IDS.includes(await r.pick("Time is running out before the deadline")));
});

test("a model that loads and then fails mid-plan degrades the ranker rather than the plan", async () => {
  const r = await heroRanker(stubEmbedder({ failAfter: 1, failMessage: "onnx session died" }));
  assert.equal(r.source, "embedding", "the hero descriptions embedded fine");
  const hero = await r.pick("Time is running out before the deadline");
  assert.ok(HERO_IDS.includes(hero), "the failing embed still produced a hero");
  assert.equal(r.source, "lexical", "and the ranker reports that it is no longer semantic");
  assert.match(r.degradedBecause ?? "", /onnx session died/);
  assert.ok(HERO_IDS.includes(await r.pick("Small steps and good habits")), "later asks keep working");
});

test("an embedder that returns the wrong number of vectors is treated as a failure, not trusted", async () => {
  const short: Embedder = { id: "short", async embed(texts) { return texts.slice(1).map(() => new Float32Array(4)); } };
  const r = await heroRanker(short);
  assert.equal(r.source, "lexical");
});

// --- the plan records a degraded run ----------------------------------------------

const beat = (i: number, voiceover: string): Beat => ({ id: `b${i}`, voiceover, onScreen: "", sourcePage: 0, startWord: 0, endWord: 9 });
function timed(beats: Beat[], perWord = 0.5): TimedWord[] {
  const out: TimedWord[] = [];
  let t = 1;
  beats.forEach((b, bi) => {
    b.voiceover.split(/\s+/).filter(Boolean).forEach((word, i) => {
      out.push({ word, start: +t.toFixed(3), end: +(t + perWord * 0.8).toFixed(3), beatIndex: bi, index: i, source: "audio" });
      t += perWord;
    });
    t += 0.34;
  });
  return out;
}
const PAGE_WORDS = "Small habits compound over time into remarkable results".split(" ");
const planWith = (heroEmbedder: Embedder) => {
  const beats = [
    beat(0, "Small habits compound over time. That is the claim."),
    beat(1, "Anger floods you before you can think. It is a method."),
    beat(2, "Follow for more."),
  ];
  return planScenes({
    bookTitle: "Atomic",
    beats,
    words: timed(beats),
    pageWords: new Map([[0, PAGE_WORDS]]),
    cropFor: () => ({ x0: 0, y0: 0, x1: 900, y1: 120 }),
    hasPage: () => true,
    provider: "claude-cli",
    skipDirector: true,
    heroEmbedder,
  });
};

test("a plan whose heroes were chosen on the lexical fallback says so in its notes", async () => {
  const plan = await planWith(failing);
  assert.ok(plan.notes.some((n) => /hero/i.test(n) && /word overlap/i.test(n) && /no cached model/.test(n)), plan.notes.join("\n"));
  assert.ok(plan.scenes.every((s) => s.kind !== "cinematic" || HERO_IDS.includes(s.cine!.hero)), "every cinematic scene still has a real hero");
});

test("a plan whose heroes were chosen semantically has no degradation note", async () => {
  const plan = await planWith(stubEmbedder());
  assert.ok(!plan.notes.some((n) => /word overlap/i.test(n)), plan.notes.join("\n"));
});
