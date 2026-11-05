import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { repairQuotedRanges } from "../src/lib/content/quoted-ranges";
import { checkRanges } from "../src/lib/content/ranges";
import { repairQuotation } from "../src/lib/content/quotation-repair";
import { checkQuotationBudget, MAX_VERBATIM_SHARE } from "../src/lib/content/quotation";
import { GROUNDING_SYSTEM, buildGroundingPrompt } from "../src/lib/content/verify";
import { generateContent } from "../src/lib/content";
import type { Beat, ContentPackage } from "../src/lib/content/schema";
import { GenerationAttempt } from "../src/lib/episodes/generation-attempt";
import { ContentRejectedError } from "../src/lib/errors";
import { prisma } from "../src/lib/db";
import { WORK_ROOT } from "../src/lib/paths";
import { requireIsolatedDatabase } from "./setup/isolation";

requireIsolatedDatabase("generation recovery fixtures must not use application data");
process.env.CLAUDE_CLI_BIN = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));

const quote = "Whatever once occupies an active, intense mind to the exclusion of everything else is never forgotten.";
const words = [...Array.from({ length: 183 }, (_, i) => `prefix${i}`), ...quote.split(" "), "Next", "paragraph"];
const pages = [{ pageIndex: 52, chapterHeading: null, words }];
const beat = (voiceover: string, startWord = 190, endWord = 198): Beat =>
  ({ id: "idea", voiceover, onScreen: "Focus", sourcePage: 52, startWord, endWord });
const pkg = (beats: Beat[]): ContentPackage => ({
  title: "SCENARIO:quotation-budget-recovers", hook: "Keep this hook", ideaKey: "fixture",
  description: "Keep this description", hashtags: ["books"], takeaway: ["Focus"], cta: "Follow BookReel.", beats,
});

test("November 5 quoted sentence: range 190–198 becomes the actual source span 183–198", () => {
  const input = [beat(`The passage states, ${quote}`), beat("Follow BookReel.", 198, 198)];
  const fixed = repairQuotedRanges(input, pages);
  assert.deepEqual([fixed.beats[0].startWord, fixed.beats[0].endWord], [183, 198]);
  assert.equal(fixed.beats[0].voiceover, input[0].voiceover);
  assert.equal(input[0].startWord, 190, "input and evidence are not mutated");
  assert.deepEqual(checkRanges(fixed.beats, new Map([[52, words.length]]), fixed.matched).problems, []);
});

test("forward-order repair cannot clip a matched quote back to 190", () => {
  const fixed = repairQuotedRanges([beat("Earlier narration", 170, 190), beat(quote), beat("Follow BookReel.", 198, 198)], pages);
  const checked = checkRanges(fixed.beats, new Map([[52, words.length]]), fixed.matched);
  assert.equal(checked.beats[1].startWord, 183);
  assert.match(checked.problems.join(" "), /do not clip/);
});

test("ambiguous repeated quotations and quotes on a different page never get guessed indices", () => {
  const input = beat(quote, 0, 3);
  const ambiguous = repairQuotedRanges([input], [{ ...pages[0], words: [...quote.split(" "), ...quote.split(" ")] }]);
  assert.equal(ambiguous.matched.size, 0);
  assert.deepEqual(ambiguous.beats[0], input);
  assert.deepEqual(repairQuotedRanges([input], [{ ...pages[0], pageIndex: 53 }]).beats[0], input);
});

test("source token indices survive curly quotes and punctuation", () => {
  const fixed = repairQuotedRanges([beat(`“${quote}”`)], pages);
  assert.deepEqual([fixed.beats[0].startWord, fixed.beats[0].endWord], [183, 198]);
});

test("closing CTA exception covers traceability without hiding factual closing narration", () => {
  assert.match(GROUNDING_SYSTEM, /applies to TRACEABILITY, NO INVENTION and WORD-INDEX GROUNDING alike/);
  assert.match(GROUNDING_SYSTEM, /Follow BookReel/);
  assert.match(GROUNDING_SYSTEM, /still requires source evidence for the memory claim/);
  assert.doesNotMatch(GROUNDING_SYSTEM, /if any OTHER beat/);
  const mixed = pkg([beat(quote), beat("Follow BookReel because this method doubles your memory.", 198, 198)]);
  const prompt = buildGroundingPrompt(mixed, pages, [], null, "Fixture");
  assert.match(prompt, /doubles your memory/, "factual CTA content must remain visible to grounding");
});

for (const factual of [false, true]) {
  test(`generation sends repaired quote ranges to grounding and ${factual ? "rejects invented CTA facts" : "accepts a non-factual closing request"}`, async () => {
    // Isolate grounding from the separate quotation-budget tests: this tiny
    // fixture is mostly its quoted sentence and intentionally has no full script.
    const book = await prisma.book.create({ data: { title: "Isolated grounding fixture", rightsStatus: "own-work" } });
    try {
      const generation = generateContent({
        bookId: book.id, bookTitle: `SCENARIO:${factual ? "grounding-factual-cta" : "grounding-range-cta"}`,
        ideaKey: `fixture-${randomUUID()}`, author: null, authorVerified: false,
        archetype: "motivation", rightsStatus: "own-work", provider: "claude-cli", pages,
      });
      if (factual) await assert.rejects(generation, /Unsupported factual memory claim/);
      else {
        const result = await generation;
        assert.equal(result.revised, false);
        assert.deepEqual([result.pkg.beats[0].startWord, result.pkg.beats[0].endWord], [183, 198]);
        assert.equal(result.pkg.beats[1].voiceover, "Follow BookReel.");
      }
    } finally { await prisma.book.delete({ where: { id: book.id } }); }
  });
}

for (const [count, runLength, totalWords, percentage] of [[5, 5, 104, 24], [2, 9, 100, 18]]) {
  test(`November 5 quotation shape: ${count} scattered runs (${percentage}%) are repaired without relaxing the final gate`, async () => {
    const passages = Array.from({ length: count }, (_, i) => Array.from({ length: runLength }, (_, j) => `source${i}word${j}`).join(" "));
    const source = passages.join(" separator ");
    const narration = [...passages.flatMap((s) => [...s.split(" "), "bridge"]),
      ...Array.from({ length: totalWords - count * (runLength + 1) }, (_, i) => `commentary${i}`)].join(" ");
    const before = checkQuotationBudget(narration, source, "in-copyright");
    assert.equal(before.withinBudget, false);
    assert.equal(before.excerpts.length, count);
    assert.equal(Math.round(before.verbatimShare * 100), percentage);
    const draft = pkg([beat(narration, 0, source.split(" ").length - 1)]);
    const repaired = await repairQuotation(draft, [{ ...pages[0], words: source.split(" ") }], "claude-cli");
    assert.equal(MAX_VERBATIM_SHARE, 0.08);
    assert.equal(checkQuotationBudget(repaired.beats[0].voiceover, source, "in-copyright").withinBudget, true);
    assert.deepEqual({ ...repaired, beats: draft.beats }, draft, "metadata is preserved");
    assert.deepEqual({ ...repaired.beats[0], voiceover: narration }, draft.beats[0], "citations and beat labels are preserved");
    assert.equal(checkQuotationBudget(narration, source, "in-copyright").withinBudget, false, "original content is still rejected");
  });
}

test("rejection waits for audio AND nested scenes, archives evidence and removes only owned draft files", async () => {
  const id = `fixture-${randomUUID()}`;
  const attempt = new GenerationAttempt<{ scenes: Promise<void> }>(id);
  const retry = new GenerationAttempt<{ scenes: Promise<void> }>(id);
  assert.notEqual(attempt.workDir, retry.workDir);
  const legacy = path.join(WORK_ROOT, "audio", id, "draft-1");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, "evidence.wav"), "old evidence");
  await fs.mkdir(retry.workDir, { recursive: true });
  await fs.writeFile(path.join(retry.workDir, "keep.txt"), "other attempt");
  let finishAudio!: () => void;
  let finishScenes!: () => void;
  const audio = new Promise<void>((r) => { finishAudio = r; });
  const scenes = new Promise<void>((r) => { finishScenes = r; });
  const { dir } = attempt.start(pkg([beat(quote)]), async (dir) => {
    await fs.mkdir(dir, { recursive: true });
    await audio;
    await fs.writeFile(path.join(dir, "voice.wav"), "late audio");
    return { scenes: scenes.then(async () => { await fs.writeFile(path.join(dir, "scene.json"), "late scene"); }) };
  });
  const report = { quotation: "24%", limit: "8%" };
  let settled = false;
  const rejection = attempt.reject(new ContentRejectedError("fixture rejected", report), pkg([beat(quote)]))
    .then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  finishAudio();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "nested scene planning still owns the draft");
  finishScenes();
  await rejection;
  await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(legacy, "evidence.wav"), "utf8"), "old evidence");
  assert.equal(await fs.readFile(path.join(retry.workDir, "keep.txt"), "utf8"), "other attempt");
  const evidenceDir = path.join(WORK_ROOT, "generation-evidence", id);
  const evidence = JSON.parse(await fs.readFile(path.join(evidenceDir, (await fs.readdir(evidenceDir))[0]), "utf8"));
  assert.deepEqual(evidence.error.report, report);
  assert.equal(evidence.drafts.length, 1);
  assert.equal(evidence.candidate.beats[0].voiceover, quote);
});

test("a rejected background task is settled and cleaned, and successful draft audio is retained", async () => {
  const attempt = new GenerationAttempt<{ scenes: Promise<void> }>(`fixture-${randomUUID()}`);
  const rejected = attempt.start({}, async (dir) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "partial.wav"), "partial");
    throw new Error("voice fixture failure");
  });
  const kept = attempt.start({}, async (dir) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "voice.wav"), "approved");
    return { scenes: Promise.resolve() };
  });
  await attempt.discardExcept(kept.dir);
  await assert.rejects(fs.stat(rejected.dir), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(kept.dir, "voice.wav"), "utf8"), "approved");
});

test("failed evidence archiving preserves rejected files for inspection", async () => {
  const id = `fixture-${randomUUID()}`;
  const attempt = new GenerationAttempt<{ scenes: Promise<void> }>(id);
  const draft = attempt.start({}, async (dir) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "voice.wav"), "evidence");
    return { scenes: Promise.resolve() };
  });
  const evidenceRoot = path.join(WORK_ROOT, "generation-evidence");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, id), "block archive");
  await assert.rejects(attempt.reject(new Error("original failure"), {}));
  assert.equal(await fs.readFile(path.join(draft.dir, "voice.wav"), "utf8"), "evidence");
});

test("grounding failure settles speculative work before releasing the idea reservation", async () => {
  const book = await prisma.book.create({ data: { title: "Isolated recovery fixture" } });
  const ideaKey = `idea-${randomUUID()}`;
  const attempt = new GenerationAttempt<{ scenes: Promise<void> }>(`fixture-${randomUUID()}`);
  let failureCallback = false;
  try {
    await assert.rejects(generateContent({
      bookId: book.id, bookTitle: "SCENARIO:always-revise-flags-indices", ideaKey,
      author: null, authorVerified: false, archetype: "motivation", rightsStatus: "in-copyright",
      provider: "claude-cli", pages: [{ pageIndex: 0, chapterHeading: null, words: Array.from({ length: 40 }, (_, i) => `source${i}`) }],
      onCheckStart: (candidate) => {
        attempt.start(candidate, async (dir) => {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "voice.wav"), "fixture audio");
          return { scenes: Promise.resolve() };
        });
      },
      onFailure: async (error, draft) => {
        failureCallback = true;
        assert.equal(await prisma.usedIdea.count({ where: { bookId: book.id, ideaKey } }), 1);
        await attempt.reject(error, draft);
        assert.equal(await prisma.usedIdea.count({ where: { bookId: book.id, ideaKey } }), 1, "reservation is held through cleanup");
      },
    }), /grounding check rejected/);
    assert.equal(failureCallback, true);
    assert.equal(await prisma.usedIdea.count({ where: { bookId: book.id, ideaKey } }), 0);
    assert.deepEqual(await fs.readdir(attempt.workDir), []);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});
