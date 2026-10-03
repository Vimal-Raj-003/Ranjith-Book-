import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { heroRanker, heroForTextSync, heroMatch, isHeroId, HERO_IDS, HERO_GUIDE, MIN_HERO_SCORE, type HeroId, type HeroRanker } from "../src/lib/video/scenes/heroes";
import { validateScenes, type ValidateContext } from "../src/lib/video/scenes/validate";
import { sentencesOf } from "../src/lib/video/scenes/plan";
import { lexicalEmbedder, type Embedder } from "../src/lib/analysis/embed";
import { planScenes } from "../src/lib/video/scenes";
import type { Beat } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";

// --- helpers ---------------------------------------------------------------------

/**
 * An embedder whose vectors are chosen by the test, so ranking can be proved to
 * come from the embedder and not from the keyword matcher. A text that contains
 * a hero's own `use` text is that hero's one-hot vector (the ranker describes a hero
 * by its `use` and `words`, so its description contains it; `shows`, the picture, is
 * not part of the description); a text of the form `want:<id> ...` is the same vector,
 * whatever else it says. Everything else is a vector
 * orthogonal to every hero.
 *
 * A text starting `mix:chain=0.6,path=0.1` has exactly those cosines with those
 * heroes (and 0 with the rest), so a test can say how well a hero fits.
 */
function stubEmbedder(opts: { failAfter?: number; failMessage?: string; id?: string } = {}): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const DIM = HERO_IDS.length + 1;
  return {
    id: opts.id ?? "stub-embedder",
    calls,
    async embed(texts) {
      if (opts.failAfter !== undefined && calls.length >= opts.failAfter) throw new Error(opts.failMessage ?? "stub embedder failed");
      calls.push(texts);
      return texts.map((t) => {
        const v = new Float32Array(DIM);
        const mix = /^mix:(\S+)/.exec(t)?.[1];
        if (mix) {
          let sq = 0;
          for (const pair of mix.split(",")) {
            const [id, score] = pair.split("=");
            v[HERO_IDS.indexOf(id as HeroId)] = Number(score);
            sq += Number(score) ** 2;
          }
          v[DIM - 1] = Math.sqrt(Math.max(0, 1 - sq)); // unit length, so each score IS the cosine
          return v;
        }
        const want = /^want:(\w+)/.exec(t)?.[1];
        const idx = HERO_IDS.findIndex((id) => id === want || t.includes(HERO_GUIDE[id].use));
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

test(
  "semantic ranking beats keyword counting on concepts the catalogue states but does not spell",
  async (t) => {
    const r = await heroRanker();
    if (r.source !== "embedding") return t.skip("the semantic model is not available on this machine");
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

test("the real embedder ranks paraphrases the keyword matcher cannot see", async (t) => {
  const r = await heroRanker();
  if (r.source !== "embedding") return t.skip("the semantic model is not available on this machine");
  // Regression guards on the catalogue as it stands, not a measure of accuracy: each says an idea a
  // hero is FOR without using any word on any hero's keyword list. (`node --import tsx
  // scripts/hero-bench.mjs` prints the figures over the wider hand-labelled set.) A new hero added
  // to the catalogue may legitimately take one of these, and then the sentence should change, not
  // the ranker: "A thousand tiny repetitions turn into mastery" is no longer keyword-free, because
  // the habit hero's own list says "repetition", so it became the one below.
  const cases: [string, HeroId][] = [
    ["Forgive them, or stay tied to the person who hurt you", "chain"],
    ["Skill is just a long line of small upgrades", "staircase"],
    ["Strangers become allies when you show up for them", "network"],
    ["The scale tips toward the heavier side", "scales"],
  ];
  for (const [text, want] of cases) {
    assert.equal(heroMatch(text), 0, `"${text}" must be a sentence the keyword matcher scores 0 on`);
    assert.equal(heroForTextSync(text), "orb", "so the old matcher would have shown the generic orb");
    assert.equal(await r.pick(text), want, `"${text}"`);
  }
});

test("the obstacle and habit heroes win sentences that are about nothing else", async (t) => {
  const r = await heroRanker();
  if (r.source !== "embedding") return t.skip("the semantic model is not available on this machine");
  // One sentence each, picked for a clear margin (0.30 and 0.15 over the runner-up). The heart hero has none: its
  // best-fitting labelled sentence leads by 0.02, too thin to guard, and the bench shows it is the weakest of the seven.
  const cases: [string, HeroId][] = [
    ["Some doors stay shut no matter how hard you push", "wall"],
    ["Most of what you did today you did on autopilot", "loop"],
  ];
  for (const [text, want] of cases) assert.equal(await r.pick(text), want, `"${text}"`);
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

// --- a fair fit, or nothing --------------------------------------------------------

test("text that fits nothing well gets the generic orb, not an arbitrary unused hero", async () => {
  const r = await heroRanker(stubEmbedder());
  const below = MIN_HERO_SCORE - 0.02;
  const above = MIN_HERO_SCORE + 0.02;
  assert.equal(await r.pick(`mix:chain=${below} something`), "orb", "the best fit is below the floor");
  assert.equal(await r.pick(`mix:chain=${above} something`), "chain", "just above it is a fit");
  assert.equal(await r.pick("completely unrelated text"), "orb", "orthogonal to every hero");
  assert.ok(Math.abs((await r.score(`mix:chain=${below} something`)) - below) < 1e-6, "`score` still reports the raw best cosine");
});

test("an unused hero below the floor does not displace a used one that fits", async () => {
  const r = await heroRanker(stubEmbedder());
  const weak = `mix:chain=0.6,path=${MIN_HERO_SCORE - 0.05} x`;
  const fair = `mix:chain=0.6,path=${MIN_HERO_SCORE + 0.05} x`;
  assert.equal(await r.pick(weak, ["chain"]), "chain", "path is unused but not a fit: the good repeat stands");
  assert.equal(await r.pick(fair, ["chain"]), "path", "path is unused and a fair fit: it is taken");
  assert.equal(await r.pick(weak), "chain");
  // And when even the repeat is below the floor, there is nothing to repeat.
  assert.equal(await r.pick(`mix:chain=${MIN_HERO_SCORE - 0.05},path=${MIN_HERO_SCORE - 0.1} x`, ["chain"]), "orb");
});

const beatAt = (i: number, voiceover: string): Beat => ({ id: `b${i}`, voiceover, onScreen: "", sourcePage: 0, startWord: 0, endWord: 9 });
function timedWords(beats: Beat[], perWord = 0.4): TimedWord[] {
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
const specAt = (i: number, extra: object) => ({ fromSentence: i, toSentence: i, from: i, to: i, kind: "cinematic" as const, concept: "a thing", reason: "r", ...extra });
async function validatorContext(beats: Beat[]): Promise<ValidateContext> {
  return {
    sentences: sentencesOf(beats, timedWords(beats)),
    pageWords: new Map([[0, "Time is the one thing nobody gets back".split(" ")]]),
    cropFor: () => null,
    hasPage: () => true,
    locate: () => null,
    heroRanker: await heroRanker(stubEmbedder()),
  };
}

test("the variety repair declines a swap below the floor, and takes one above it", async () => {
  const beats = [
    beatAt(0, "Time is the one thing nobody gets back."),
    beatAt(1, "Your past can weigh you down like a chain."),
    beatAt(2, "It follows you into every new room."),
    beatAt(3, "Follow for more."),
  ];
  const run = async (concept2: string) => {
    // Scenes 1 and 2 are both a chain, which the never-twice-in-a-row rule must repair.
    const r = await validateScenes(
      [specAt(0, { hero: "mountain" }), specAt(1, { hero: "chain" }), specAt(2, { hero: "chain", concept: concept2 }), specAt(3, { hero: "spark" })],
      await validatorContext(beats),
    );
    return r.scenes.map((s) => s.cine?.hero);
  };
  const declined = await run(`mix:chain=0.6,path=${MIN_HERO_SCORE - 0.05}`);
  assert.equal(declined[2], "chain", "the only unused fit is below the floor: the repeat stays");
  const taken = await run(`mix:chain=0.6,path=${MIN_HERO_SCORE + 0.05}`);
  assert.equal(taken[2], "path", "a fair unused fit replaces the repeat");
});

test("a cinematic scene the director gave no hero, about nothing in the catalogue, shows the orb", async () => {
  const beats = [beatAt(0, "Time is the one thing nobody gets back."), beatAt(1, "Add two cups of flour and stir."), beatAt(2, "Follow for more.")];
  const r = await validateScenes(
    [specAt(0, { hero: "mountain" }), specAt(1, { concept: "nothing in the catalogue" }), specAt(2, { hero: "spark" })],
    await validatorContext(beats),
  );
  assert.equal(r.scenes[1].cine?.hero, "orb");
});

// --- degradation never fails a plan -----------------------------------------------

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "hero-labels.json"), "utf8")) as {
  labelled: { hero: string; text: string }[];
  offTopic: string[];
};
const CORPUS = [
  ...fixture.labelled.map((x) => x.text),
  ...fixture.offTopic,
  "",
  "   ",
  "zzz qqq xyzzy",
  "Time is running out before the deadline",
  "Small steps and good habits build progress",
  "time ".repeat(400),
];
const AVOIDS: (readonly HeroId[])[] = [[], ["hourglass", "clock"], HERO_IDS];

/** The three ways a ranker ends up degraded: asked for, never loaded, or lost partway. */
async function degradedRankers(): Promise<[string, HeroRanker][]> {
  const midPlan = await heroRanker(stubEmbedder({ failAfter: 1, failMessage: "onnx session died" }));
  assert.equal(midPlan.source, "embedding", "the hero descriptions embedded fine");
  await midPlan.pick("anything at all"); // this embed fails, and from here the ranker is degraded
  return [
    ["lexical embedder asked for", await heroRanker(lexicalEmbedder)],
    ["model unavailable at construction", await heroRanker(failing)],
    ["model died mid-plan", midPlan],
  ];
}

test("a degraded ranker is exactly the keyword matcher, and never yields an undefined hero", async () => {
  for (const [how, r] of await degradedRankers()) {
    assert.equal(r.source, "lexical", how);
    for (const text of CORPUS) {
      for (const avoid of AVOIDS) {
        const got = await r.pick(text, avoid);
        assert.ok(isHeroId(got), `${how}: "${text.slice(0, 40)}" gave ${String(got)}`);
        assert.equal(got, heroForTextSync(text, avoid), `${how}: "${text.slice(0, 40)}" avoiding ${avoid.length}`);
      }
    }
  }
});

test("a degraded ranker says why, and a degraded score is the keyword hit count squashed into 0..1", async () => {
  const [asked, never, midPlan] = (await degradedRankers()).map(([, r]) => r);
  assert.equal(asked.degradedBecause, null, "lexical was asked for: nothing went wrong");
  assert.match(never.degradedBecause ?? "", /no cached model and no network/);
  assert.match(midPlan.degradedBecause ?? "", /onnx session died/);
  for (const r of [asked, never, midPlan]) {
    assert.equal(await r.score("zzz qqq xyzzy"), 0, "no keyword hit: 0, so a floor-style check still routes it to the orb");
    assert.equal(await r.score(""), 0);
    const one = await r.score("a deadline");
    const many = await r.score("time and deadline");
    assert.ok(one > 0 && one < many && many < 1, `more keyword hits score higher, inside 0..1 (${one}, ${many})`);
  }
});

test("asking for the lexical embedder does no embedding work at all", async () => {
  const stub = stubEmbedder({ id: lexicalEmbedder.id });
  const r = await heroRanker(stub);
  assert.equal(r.source, "lexical");
  await r.pick("Time is running out before the deadline");
  await r.score("Time is running out before the deadline");
  assert.equal(stub.calls.length, 0, "the keyword matcher needs no vectors");
});

test("a model that loads and then fails mid-plan degrades the ranker rather than the plan", async () => {
  const r = await heroRanker(stubEmbedder({ failAfter: 1, failMessage: "onnx session died" }));
  assert.equal(r.source, "embedding");
  const hero = await r.pick("Time is running out before the deadline");
  assert.equal(hero, "hourglass", "the failing embed was answered by the keyword matcher");
  assert.equal(r.source, "lexical", "and the ranker reports that it is no longer semantic");
  assert.match(r.degradedBecause ?? "", /onnx session died/);
  assert.equal(await r.pick("Small steps and good habits"), heroForTextSync("Small steps and good habits"), "later asks keep working");
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
