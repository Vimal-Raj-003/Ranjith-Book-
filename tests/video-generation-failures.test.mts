import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContentPackage } from "../src/lib/content/cli-provider";
import { alignBeatRangesToSource, isPureClosingRequest, repairQuotedRanges } from "../src/lib/content/quoted-ranges";
import { checkRanges } from "../src/lib/content/ranges";
import { spokenWordCount, voScriptFromPackage, type Beat, type ContentPackage } from "../src/lib/content/schema";
import { detectPublicDomainFrontMatter } from "../src/lib/analysis/public-domain";

test("Regression (cmwdlarw50101n6k0dm31drex): normalizeContentPackage unwraps double-encoded string beats from gemini-2.5-flash-lite", () => {
  const rawFromFlashLite = {
    title: "Why Meaning Makes Memory Effortless",
    hook: "Stop trying to memorize words like nonsense syllables.",
    hookKeywords: ["meaning", "memory"],
    ideaKey: "why-meaning-makes-memory-effortless",
    archetype: "motivation",
    beats: [
      JSON.stringify({
        id: "b1",
        voiceover: "Trying to memorize disconnected facts burns mental energy fast.",
        onScreen: "Disconnected facts",
        sourcePage: "166",
        startWord: "67",
        endWord: "90",
      }),
      JSON.stringify({
        id: "b2",
        voiceover: "When ideas form a coherent whole, recall becomes natural.",
        onScreen: "Coherent meaning",
        sourcePage: 166,
        startWord: 91,
        endWord: 118,
      }),
      JSON.stringify({
        id: "cta",
        voiceover: "Follow BookReel for more ideas from books.",
        onScreen: "Follow BookReel",
        sourcePage: 166,
        startWord: 118,
        endWord: 118,
      }),
    ],
    cta: "Follow BookReel for more ideas from books.",
    description: "Meaning anchors memory.",
    hashtags: ["#BookReel", "#Memory", "#Learning"],
    takeaway: ["Connect facts into meaning.", "Avoid rote isolated drills."],
  };

  const pkg = normalizeContentPackage(rawFromFlashLite);
  assert.equal(pkg.beats.length, 3);
  assert.equal(typeof pkg.beats[0], "object");
  assert.equal(pkg.beats[0].voiceover, "Trying to memorize disconnected facts burns mental energy fast.");
  assert.equal(pkg.beats[0].sourcePage, 166);
  assert.equal(pkg.beats[0].startWord, 67);
  assert.equal(pkg.beats[0].endWord, 90);
  assert.ok(spokenWordCount(pkg) > 20);
  assert.ok(voScriptFromPackage(pkg).includes("coherent whole"));

  // Confirm repairQuotedRanges never crashes with undefined.split
  const repaired = repairQuotedRanges(pkg.beats, [
    { pageIndex: 166, chapterHeading: null, words: Array.from({ length: 150 }, (_, i) => `word${i}`) },
  ]);
  assert.equal(repaired.beats.length, 3);
});

test("Regression (cmwdlas8c0105n6k0tce04pun): alignBeatRangesToSource expands 2-word stub (145-146 'second reason') to the supporting sentence on Page 63", () => {
  const prefixWords = Array.from({ length: 144 }, (_, i) => `earlier${i}`);
  const sentenceAt144 = (
    "A second reason for the enormous capacity of memory is to be found in the fact that " +
    "the concepts and scientific thoughts which we have once mastered can always be revived " +
    "when we return to similar contexts of thought."
  ).split(" ");
  const tailWords = "This concludes the section on observational retention.".split(" ");
  const page63Words = [...prefixWords, ...sentenceAt144, ...tailWords];

  // Verify indices 145..146 are literally "second" and "reason", matching the real failure!
  assert.deepEqual(page63Words.slice(145, 147), ["second", "reason"]);

  const beats: Beat[] = [
    {
      id: "b5",
      voiceover: "With those essential anchors secured, you can readily reconstruct the entire content in detailed form later.",
      onScreen: "Reconstruct content",
      sourcePage: 63,
      startWord: 132,
      endWord: 145,
    },
    {
      id: "b6",
      voiceover: "Release the heavy weight of literal memorization by focusing on conceptual frameworks to expand your learning capacity.",
      onScreen: "Expand capacity",
      sourcePage: 63,
      startWord: 145,
      endWord: 146,
    },
    {
      id: "cta",
      voiceover: "Follow BookReel for more evidence based insights from classic books.",
      onScreen: "Follow BookReel",
      sourcePage: 63,
      startWord: 146,
      endWord: 146,
    },
  ];

  assert.equal(isPureClosingRequest(beats[1].voiceover), false);
  assert.equal(isPureClosingRequest(beats[2].voiceover), true);

  const aligned = alignBeatRangesToSource(beats, [{ pageIndex: 63, chapterHeading: null, words: page63Words }]);
  const expanded = aligned.beats[1];
  assert.ok(expanded.startWord >= 145, `startWord (${expanded.startWord}) stays >= previous beat's endWord (145)`);
  assert.ok(expanded.endWord - expanded.startWord >= 12, `stub 145-146 expanded to full supporting span (${expanded.startWord}-${expanded.endWord})`);

  const coveredText = page63Words.slice(expanded.startWord, expanded.endWord + 1).join(" ");
  assert.match(coveredText, /capacity/);
  assert.match(coveredText, /memory/);

  // And the pure closing request beat automatically rests at the expanded beat's endWord!
  assert.equal(aligned.beats[2].startWord, expanded.endWord);
  assert.deepEqual(checkRanges(aligned.beats, new Map([[63, page63Words.length]])).problems, []);
});

test("Public-domain front-matter detector identifies pre-1930 copyright & Gutenberg while keeping modern books in-copyright", () => {
  const meumann1913 = detectPublicDomainFrontMatter(
    [
      "Digitized by the Internet Archive in 2012 with funding from Research Library",
      "THE PSYCHOLOGY OF LEARNING BY E. MEUMANN",
      "COPYRIGHT, 1913, BY D. APPLETON AND COMPANY",
    ],
    "Changing your habits steps to better health (IA CAT31310001)",
  );
  assert.equal(meumann1913.isPublicDomain, true);
  assert.match(meumann1913.reason ?? "", /1913/);

  const modernEdition = detectPublicDomainFrontMatter(
    [
      "Originally published 1913.",
      "Introduction and translation Copyright © 2018 by Penguin Random House LLC. All rights reserved.",
    ],
    "The Psychology of Learning",
  );
  assert.equal(modernEdition.isPublicDomain, false, "post-1929 copyright notice keeps book in-copyright");

  const gutenberg = detectPublicDomainFrontMatter(
    ["The Project Gutenberg eBook of Habit, by William James. This eBook is for the use of anyone anywhere."],
    "Habit",
  );
  assert.equal(gutenberg.isPublicDomain, true);
});

test("Defensive schema helpers survive missing voiceover without throwing TypeError", () => {
  const malformed = {
    beats: [{ id: "b1", voiceover: undefined as unknown as string, onScreen: "", sourcePage: 0, startWord: 0, endWord: 0 }],
  } as ContentPackage;
  assert.equal(spokenWordCount(malformed), 0);
  assert.equal(voScriptFromPackage(malformed), "");
});
