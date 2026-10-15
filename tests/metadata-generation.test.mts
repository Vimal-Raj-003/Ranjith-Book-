import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "../src/lib/content/prompt";
import { CONTENT_JSON_SCHEMA, contentJsonSchema, type ContentPackage } from "../src/lib/content/schema";
import { findAuthorMentions } from "../src/lib/content/verify";
import { callKind } from "../src/lib/content/cli-metrics";
import { hasEmoji, isEmojiCluster, stripEmoji, titleEmojiShape } from "../src/lib/content/emoji";
import { DESCRIPTION_MAX, TITLE_MAX } from "../src/lib/content/metadata-rules";
import { generatePlatformMetadata, regenerateField, type PlatformMetadata, type RegenerateSource } from "../src/lib/publish/regenerate";
import { YOUTUBE_TAGS_LIMIT, hashtagLine, tagsLine } from "../src/lib/publish/limits";
import { buildThumbHtml, headlineText } from "../src/lib/thumbnails";
import { ASPECTS, VARIANTS } from "../src/lib/thumbnails/types";

/**
 * The generation of the title, description, hashtags, YouTube tags and
 * Instagram copy -- what the writer is told, what Regenerate asks, and what the
 * batched platform generator accepts. Every model call here is a stub injected
 * through `deps.call`: nothing spawns a CLI and nothing is spent. The real model
 * is exercised by the browser verification, not by these.
 *
 * The database-backed half (storing, empty-only, the render step) lives in
 * `tests/publish.test.mts`, which owns the episode seeding.
 */

// ---------------------------------------------------------------- stubs

/** A stand-in for `runCliJson` that records every call and answers with `reply`. */
function fakeCall(reply: unknown) {
  const seen: { system: string; user: string; schema: Record<string, unknown> }[] = [];
  const call = async <T,>(_p: unknown, system: string, user: string, schema: object): Promise<T> => {
    seen.push({ system, user, schema: schema as Record<string, unknown> });
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { call: call as never, seen };
}

function source(over: Partial<RegenerateSource> & { lines: string[] }): RegenerateSource {
  const { lines, ...rest } = over;
  return {
    bookTitle: "The Focus Habit",
    author: null,
    archetype: "motivation",
    bookLink: null,
    title: null,
    hook: null,
    cta: "Follow for one idea a day",
    script: JSON.stringify(
      lines.map((voiceover, i) => ({ id: `b${i}`, voiceover, onScreen: "x", sourcePage: 0, startWord: i, endWord: i + 1 })),
    ),
    voScript: lines.join(" "),
    ...rest,
  };
}

const PRODUCTIVITY = source({
  bookTitle: "The Focus Habit",
  title: "🎯 Why Deep Work Beats Being Busy 🧠⏳",
  hook: "Most people are busy. Almost nobody is focused.",
  lines: [
    "Most people are busy. Almost nobody is focused.",
    "Deep work means giving one hard task your full attention for a long stretch.",
    "Switching between tasks leaves part of your mind behind on the last one.",
    "Block out the time and protect it.",
  ],
});

const STUDY = source({
  bookTitle: "Make It Last",
  title: "📚 Stop Re-Reading: Test Yourself to Remember 🧠✅",
  hook: "Re-reading feels like learning. It mostly is not.",
  lines: [
    "Re-reading feels like learning, but it mostly builds familiarity.",
    "Testing yourself pulls the answer out of memory, and that effort is what makes it last.",
    "Space your practice across days instead of cramming the night before.",
  ],
});

const MINDSET = source({
  bookTitle: "The Power of Yet",
  title: "🌱 The Power of Yet: Turn Failure Into a Plan 🚀",
  hook: "You are not bad at this. You are not good at it yet.",
  lines: [
    "Your abilities are not fixed.",
    "When you treat a failure as information instead of a verdict, you keep trying.",
    "The word yet turns a sentence from a judgement into a plan.",
  ],
});

// ---------------------------------------------------------------- the emoji helper

test("stripEmoji removes emoji of every shape and leaves ordinary typography alone", () => {
  assert.equal(stripEmoji("🧠 Why Your Brain Resists Starting Hard Things 🚀"), "Why Your Brain Resists Starting Hard Things");
  // A ZWJ sequence, a flag, a keycap, a skin-tone modifier and a variation-selector emoji are ONE each.
  assert.equal(stripEmoji("👨‍💻 Deep Work 🇮🇳 1️⃣ Rule 👍🏽 ☀️"), "Deep Work Rule");
  // Not emoji, so not touched: trade-mark and copyright signs, hashes, digits, percent.
  assert.equal(stripEmoji("Brand™ Deep Work © 2020 #1 100%"), "Brand™ Deep Work © 2020 #1 100%");
  assert.equal(stripEmoji(""), "");
  assert.equal(stripEmoji(undefined as never), "");
  assert.equal(isEmojiCluster("©"), false);
  assert.equal(isEmojiCluster("🧠"), true);
  assert.equal(hasEmoji("plain"), false);
});

test("titleEmojiShape counts what a reader sees: one leading, one or two trailing, none inside", () => {
  assert.deepEqual(titleEmojiShape("🧠 Why Brains Resist Hard Things 🚀"), {
    leading: 1,
    trailing: 1,
    inside: 0,
    text: "Why Brains Resist Hard Things",
  });
  assert.equal(titleEmojiShape("⏰ Beat Procrastination ✅🔥").trailing, 2);
  assert.equal(titleEmojiShape("👨‍💻 A ZWJ sequence is one emoji 🏳️‍🌈").leading, 1, "a joined sequence is one, not seven");
  assert.equal(titleEmojiShape("✨ Stranded 🎯 in the middle ✨").inside, 1);
  assert.deepEqual(
    [titleEmojiShape("No emoji at all").leading, titleEmojiShape("No emoji at all").trailing],
    [0, 0],
  );
});

// ---------------------------------------------------------------- GAP 1: what the pipeline writer is told

test("the writer is told what a title is: one leading emoji, one or two trailing, topic-matched, 100 characters including them", () => {
  for (const hasAuthor of [true, false]) {
    const s = buildSystemPrompt({ hasAuthor });
    assert.match(s, /TITLE — the YouTube title/);
    assert.match(s, /ONE relevant emoji at the very start/);
    assert.match(s, /ONE OR TWO relevant emojis at the very end/);
    assert.match(s, /chosen for THIS video's subject/);
    assert.match(s, /never random|Never random/);
    assert.match(s, /At most 100 characters INCLUDING the emojis/);
    assert.match(s, /complete, grammatical phrase/, "found in the first real run: 'Why You Procrastinate Isn't Laziness'");
    assert.match(s, /No clickbait, no ALL CAPS, no trailing hashtags/);
    assert.match(s, /no "<" or ">"/);
    assert.match(s, /Keep the video's meaning/);
  }
});

test("the writer is told the eight-part structured description, grounded in the script, with no hashtags in it", () => {
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.match(s, /DESCRIPTION — the YouTube description: a COMPLETE, structured body, never a single sentence/);
  // The eight parts, in order.
  const order = [
    /1\. An engaging opening headline line with 1–2 relevant emojis/,
    /2\. A relatable question or hook/,
    /3\. A clear explanation of the core idea/,
    /4\. The source\..*Inspired by ideas from/,
    /5\. "What you'll discover:".*4–6 bullet lines/,
    /6\. Only when the script itself gives the viewer something to do/,
    /7\. One memorable closing takeaway line/,
    /8\. A natural closing line inviting the viewer to follow BookReel/,
  ];
  let from = 0;
  for (const part of order) {
    const m = part.exec(s.slice(from));
    assert.ok(m, `part ${part} is missing or out of order`);
    from += m.index + m[0].length;
  }
  // Grounded, and never inventing.
  assert.match(s, /Invent nothing: no fact, quotation, statistic, study, research finding or claim about the book/);
  assert.match(s, /do not invent advice/);
  // The author rule survives into the description.
  assert.match(s, /without any archive id, file extension or page count in it, and with no dangling punctuation/, "the operator's titles are not always tidy");
  assert.match(s, /Add "by" and the author's name ONLY when the Author line names someone/);
  assert.match(s, /name no one and do not stand in for one/);
  // Hashtags are their own field, and the purchase link is composed in code.
  assert.match(s, /every bullet leads with its own relevant emoji, or every bullet starts with "• " — never a mix/, "one bullet style, not both");
  assert.match(s, /Do NOT put hashtags in the description/);
  assert.match(s, /the purchase link is appended afterwards, in code/);
  assert.match(s, /No angle brackets/);
});

test("the writer is told what hashtags are: specific first, a few broad, #BookReel, no stock list", () => {
  const s = buildSystemPrompt({ hasAuthor: false });
  assert.match(s, /HASHTAGS — between 3 and 12/);
  assert.match(s, /specific to THIS video's subject/);
  assert.match(s, /broader category tags/);
  assert.match(s, /Include #BookReel/);
  assert.match(s, /CamelCase \(#DeepWork\)/);
  assert.match(s, /no duplicates or near-duplicates/);
  assert.match(s, /Do not reuse a stock list/);
  assert.match(s, /No keyword stuffing/);
});

test("adding the posting-copy rules took none of the existing rules away", () => {
  for (const length of ["short", "long"] as const) {
    const s = buildSystemPrompt({ hasAuthor: false, length });
    assert.match(s, /No emoji, no URLs, no hashtags inside voiceover/, "the spoken-voiceover emoji ban stays");
    assert.match(s, /NEVER write a URL, a domain, a link/, "the URL ban stays");
    assert.match(s, /Invent nothing/, "the grounding rule stays");
    assert.match(s, /emoji is optional, and at most ONE emoji character per beat/, "the per-beat emoji rule stays");
    assert.match(s, /hookKeywords are the two or three words/);
    assert.match(s, /THE LAST BEAT IS THE CALL TO ACTION/);
    assert.match(s, /ideaKey is the single angle/);
  }
  // The long-episode rules still come after, and are still there.
  assert.match(buildSystemPrompt({ hasAuthor: false, length: "long" }), /THIS IS A .* VIDEO\./);
  assert.ok(
    buildSystemPrompt({ hasAuthor: false, length: "long" }).indexOf("THE POSTING COPY") <
      buildSystemPrompt({ hasAuthor: false, length: "long" }).indexOf("THIS IS A"),
    "the posting copy rules sit between the script rules and the length rules",
  );
});

test("the schema allows a description up to YouTube's 5,000 and a title up to 100, short and long", () => {
  assert.equal(CONTENT_JSON_SCHEMA.properties.description.maxLength, 5000);
  assert.equal(CONTENT_JSON_SCHEMA.properties.description.maxLength, DESCRIPTION_MAX);
  assert.equal(CONTENT_JSON_SCHEMA.properties.title.maxLength, 100, "emoji count toward the same 100");
  assert.equal(CONTENT_JSON_SCHEMA.properties.title.maxLength, TITLE_MAX);
  assert.equal(CONTENT_JSON_SCHEMA.properties.hashtags.minItems, 3);
  assert.equal(CONTENT_JSON_SCHEMA.properties.hashtags.maxItems, 12);
  assert.equal(contentJsonSchema("long").properties.description.maxLength, 5000, "the long-episode schema inherits it");
});

/**
 * The deterministic author gate reads title AND description. The structured
 * body writes "Inspired by ideas from <Book>" -- and a "by" before a capitalised
 * word is exactly the shape of a fabricated byline, so this proves the wording
 * the prompt prescribes cannot trip the gate on a clean description, and still
 * trips it on a wrong author.
 */
test("the prescribed 'Inspired by ideas from' wording passes the author gate; a wrong author is still caught", () => {
  const pkg = (description: string): ContentPackage => ({
    title: "🎯 Why Deep Work Beats Being Busy 🧠⏳",
    hook: "Most people are busy.",
    ideaKey: "deep-work",
    beats: [{ id: "hook", voiceover: "x", onScreen: "x", sourcePage: 0, startWord: 0, endWord: 1 }],
    cta: "Follow",
    description,
    hashtags: ["#BookReel"],
    takeaway: ["a", "b"],
  });
  const unverified = "🎯 Focus beats busy\n\nInspired by ideas from The Focus Habit\n\nFollow BookReel for more.";
  assert.deepEqual(findAuthorMentions(pkg(unverified), null), [], "no author established, none named");

  const verified = "🎯 Focus beats busy\n\nInspired by ideas from The Focus Habit by Cal Newport\n\nFollow BookReel for more.";
  assert.deepEqual(findAuthorMentions(pkg(verified), "Cal Newport"), [], "the verified author may be named");
  assert.equal(findAuthorMentions(pkg(verified), "Someone Else").length, 1, "a different verified author makes it a fabrication");
  assert.equal(findAuthorMentions(pkg(verified), null).length, 1, "and so does naming one when none is established");
});

/**
 * The byline gate is the only defence against an unverified name in a
 * description. The newline fix must not have loosened it: a name typed with a
 * non-breaking (or any other Unicode) space is still a name.
 */
test("the byline gate still sees a wrong author typed with a non-breaking space, and still stops at a line break", () => {
  const pkg = (description: string): ContentPackage => ({
    title: "🎯 Why Deep Work Beats Being Busy 🧠⏳",
    hook: "Most people are busy.",
    ideaKey: "deep-work",
    beats: [{ id: "hook", voiceover: "x", onScreen: "x", sourcePage: 0, startWord: 0, endWord: 1 }],
    cta: "Follow",
    description,
    hashtags: ["#BookReel"],
    takeaway: ["a", "b"],
  });
  const NBSP = "\u00A0";

  // An unverified author, separated by a no-break space: DETECTED.
  const nbsp = `Inspired by ideas from The Focus Habit by Cal${NBSP}Newport\n\nFollow BookReel for more.`;
  assert.equal(findAuthorMentions(pkg(nbsp), null).length, 1, "no author is established: any name trips the gate");
  // The "by" itself followed by a no-break space, too.
  assert.equal(findAuthorMentions(pkg(`by${NBSP}Cal Newport\n\nFollow`), null).length, 1);
  // A different verified author: the NBSP name is a mismatch, so DETECTED.
  assert.equal(findAuthorMentions(pkg(nbsp), "Someone Else").length, 1, "a wrong author is a fabrication however the space is spelled");
  // Other Unicode spaces (thin, ideographic) too.
  for (const space of ["\u2009", "\u3000", "\u202F"]) {
    assert.equal(findAuthorMentions(pkg(`by Cal${space}Newport\n\nFollow`), null).length, 1, `U+${space.charCodeAt(0).toString(16)}`);
  }

  // The captured name stops at the line break (LF or CRLF), so a CORRECT verified author is not
  // turned into "Cal Newport / Follow Book" and rejected.
  for (const eol of ["\n\n", "\r\n\r\n"]) {
    assert.deepEqual(findAuthorMentions(pkg(`Inspired by ideas from The Focus Habit by Cal Newport${eol}Follow BookReel for more.`), "Cal Newport"), [], JSON.stringify(eol));
  }
  // ...and the verified author typed with an NBSP is the same person (matched, not flagged).
  assert.deepEqual(findAuthorMentions(pkg(nbsp), "Cal Newport"), []);
});

// ---------------------------------------------------------------- GAP 2: titles through Regenerate

test("Regenerate no longer forbids an emoji in a title, and asks for the same title the writer does", async () => {
  const fake = fakeCall({ title: "🎯 Why Deep Work Beats Being Busy 🧠⏳" });
  const out = await regenerateField("title", PRODUCTIVITY, { call: fake.call, provider: "claude-cli" });
  assert.equal(out.value, "🎯 Why Deep Work Beats Being Busy 🧠⏳");

  const { system, user } = fake.seen[0];
  assert.doesNotMatch(system + user, /no emoji in a title/i, "the old ban is gone");
  assert.match(user, /ONE relevant emoji at the very start/);
  assert.match(user, /ONE OR TWO relevant emojis at the very end/);
  assert.match(user, /At most 100 characters INCLUDING the emojis/);
  assert.match(user, /No clickbait, no ALL CAPS, no trailing hashtags/);
  assert.match(user, /Keep the video's meaning/);
  assert.equal(callKind(system), "other", "still not classified as the script writer");

  const shape = titleEmojiShape(out.value as string);
  assert.equal(shape.leading, 1);
  assert.ok(shape.trailing >= 1 && shape.trailing <= 2);
  assert.ok([...(out.value as string)].length <= 100);
});

test("a title's 100 characters INCLUDE its emoji: over by one is refused, never cut", async () => {
  // 97 letters + 3 emoji = exactly 100 code points -> accepted.
  const exactly = `🎯 ${"a".repeat(96)} 🧠`;
  assert.equal([...exactly].length, 100);
  const ok = await regenerateField("title", PRODUCTIVITY, { call: fakeCall({ title: exactly }).call, provider: "claude-cli" });
  assert.equal(ok.value, exactly);

  // One more letter, and the emoji are what tips it over: refused whole.
  const over = `🎯 ${"a".repeat(97)} 🧠`;
  assert.equal([...over].length, 101);
  await assert.rejects(
    () => regenerateField("title", PRODUCTIVITY, { call: fakeCall({ title: over }).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, "regenerate_failed");
      assert.match((err as Error).message, /over the 100 asked for/);
      assert.match((err as Error).message, /Nothing was changed/);
      return true;
    },
  );
});

test("a title or description loses '<' and '>' (YouTube refuses an upload that holds either)", async () => {
  const title = await regenerateField("title", PRODUCTIVITY, {
    call: fakeCall({ title: "🎯 Deep <b>Work</b> Wins 🧠" }).call,
    provider: "claude-cli",
  });
  assert.doesNotMatch(title.value as string, /[<>]/);
  assert.equal(title.value, "🎯 Deep bWork/b Wins 🧠");

  const description = await regenerateField("description", PRODUCTIVITY, {
    call: fakeCall({ description: "Headline\n\nInspired by ideas from <The Focus Habit>" }).call,
    provider: "claude-cli",
  });
  assert.doesNotMatch(description.value as string, /[<>]/);
});

test("the poster NEVER shows the title's emoji: not the headline fallback, not the eyebrow", () => {
  const title = "🎯 Why Deep Work Beats Being Busy 🧠⏳";

  // `headlineText` falls back to the title when the hook offers nothing.
  const headline = headlineText({ title, hook: "", keywords: [] }, 12);
  assert.equal(headline, "Why Deep Work Beats Being Busy");
  assert.equal(hasEmoji(headline), false);
  // ...and the hook-derived headline is untouched by the title.
  assert.equal(headlineText({ title, hook: "Most people are busy.", keywords: [] }, 8), "Most people are busy");

  // Every poster variant, in both aspects: no emoji anywhere in the markup.
  for (const aspect of ASPECTS) {
    for (const variant of VARIANTS) {
      const html = buildThumbHtml({
        aspect,
        variant,
        copy: { title, hook: "Most people are busy.", keywords: ["busy"], cta: "Follow", onScreen: [], takeaway: [] },
        photo: null,
        focus: null,
      });
      assert.equal(hasEmoji(html), false, `${aspect.tag}-${variant}: an emoji reached the poster`);
      assert.match(html, /WHY DEEP WORK BEATS BEING/, `${aspect.tag}-${variant}: the eyebrow is the title WITHOUT its emoji`);
    }
  }
});

test("the thumbnail entry point strips the title before it reaches either consumer (pipeline and redo both go through it)", async () => {
  const src = await fs.readFile(fileURLToPath(new URL("../src/lib/thumbnails/index.ts", import.meta.url)), "utf8");
  assert.match(src, /title: clean\(stripEmoji\(/, "generateThumbnails builds its copy from the emoji-free title");
});

// ---------------------------------------------------------------- GAP 1/2: description and hashtags through Regenerate

const STRUCTURED = [
  "🎯 Why focus beats being busy",
  "",
  "Ever finish a day full of tasks and wonder what actually moved forward?",
  "",
  "Deep work means giving one hard task your full attention for a long stretch. Switching between tasks leaves part of your mind behind on the last one.",
  "",
  "Inspired by ideas from The Focus Habit",
  "",
  "What you'll discover:",
  "🧠 Why switching tasks leaves part of your mind behind",
  "🎯 What deep work actually means",
  "⏳ Why a long stretch of attention matters",
  "🔒 Why you protect the time you block out",
  "",
  "Try this:",
  "1. Block out the time",
  "2. Protect it",
  "",
  "Attention is the thing worth guarding.",
  "",
  "Follow BookReel for more ideas from the books worth your time.",
].join("\n");

test("a regenerated description keeps the multi-section body, grounded, with no hashtag line and the link added in code", async () => {
  const fake = fakeCall({ description: STRUCTURED });
  const out = await regenerateField(
    "description",
    { ...PRODUCTIVITY, bookLink: "https://example.com/buy?id=1" },
    { call: fake.call, provider: "claude-cli" },
  );
  const text = out.value as string;

  // The body is multi-section and intact; the purchase link is composed in code after it.
  assert.ok(text.startsWith(STRUCTURED));
  assert.equal(text, `${STRUCTURED}\n\nGet the book: https://example.com/buy?id=1`);
  assert.ok(text.split("\n\n").length >= 8, "headline, hook, idea, source, bullets, steps, takeaway, follow line, link");
  assert.match(text, /What you'll discover:/);
  assert.equal(text.match(/^[🧠🎯⏳🔒] /gmu)?.length, 5, "the headline and four bullets each lead with one emoji");

  // It does not duplicate the hashtag line -- that is its own field.
  assert.doesNotMatch(text, /(^|\s)#\w/, "no hashtag in the description");
  assert.ok(!text.includes(hashtagLine(["#BookReel", "#DeepWork"])));

  // The brief it was given is the structured one, and grounded in the script.
  const { user } = fake.seen[0];
  assert.match(user, /COMPLETE, structured body/);
  assert.match(user, /8\. A natural closing line inviting the viewer to follow BookReel/);
  assert.match(user, /Everything in it must come from the script below/);
  assert.match(user, /Deep work means giving one hard task your full attention/, "the script's own words are the ground truth");
});

test("the description cap is YouTube's 5,000: 4,900 characters are accepted whole, 5,001 refused", async () => {
  const long = STRUCTURED + "\n\n" + "x".repeat(4900 - [...STRUCTURED].length - 2);
  assert.equal([...long].length, 4900);
  const ok = await regenerateField("description", PRODUCTIVITY, { call: fakeCall({ description: long }).call, provider: "claude-cli" });
  assert.equal(ok.value, long, "stored whole, not cut to the old 1,200");

  await assert.rejects(
    () => regenerateField("description", PRODUCTIVITY, { call: fakeCall({ description: "x".repeat(5001) }).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.match((err as Error).message, /over the 5000 asked for/);
      return true;
    },
  );
});

test("the 5,000 cap leaves room for the purchase link that is appended after it", async () => {
  const link = "https://example.com/buy?id=1";
  const room = [...`\n\nGet the book: ${link}`].length; // what appendBookLink adds
  const src = { ...PRODUCTIVITY, bookLink: link };

  // Exactly what fits: accepted whole, and the finished description is exactly 5,000.
  const fits = "x".repeat(5000 - room);
  const ok = await regenerateField("description", src, { call: fakeCall({ description: fits }).call, provider: "claude-cli" });
  assert.equal([...(ok.value as string)].length, 5000);

  // One over: refused (never cut), naming the lower ceiling.
  await assert.rejects(
    () => regenerateField("description", src, { call: fakeCall({ description: fits + "x" }).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.match((err as Error).message, new RegExp(`over the ${5000 - room} asked for`));
      assert.match((err as Error).message, /Nothing was changed/);
      return true;
    },
  );

  // No link on the book: the whole 5,000 is available, as before.
  const bare = await regenerateField("description", { ...PRODUCTIVITY, bookLink: null }, { call: fakeCall({ description: "x".repeat(5000) }).call, provider: "claude-cli" });
  assert.equal([...(bare.value as string)].length, 5000);
});

test("regenerated hashtags: topic-specific, #BookReel kept, de-duplicated, 3 to 12", async () => {
  const fake = fakeCall({
    hashtags: ["#DeepWork", "#BookReel", "#deepwork", "FocusHabit", "#Productivity", "#Attention", "#TimeBlocking", "#Books"],
  });
  const out = await regenerateField("hashtags", PRODUCTIVITY, { call: fake.call, provider: "claude-cli" });
  assert.deepEqual(out.value, ["#DeepWork", "#BookReel", "#FocusHabit", "#Productivity", "#Attention", "#TimeBlocking", "#Books"]);
  assert.ok(out.value.length >= 3 && out.value.length <= 12);
  assert.match(fake.seen[0].user, /Include #BookReel/);
  assert.match(fake.seen[0].user, /Do not reuse a stock list/);

  // More than twelve is cut to twelve, fewer than three is refused.
  const many = fakeCall({ hashtags: Array.from({ length: 20 }, (_, i) => `#tag${i}`) });
  assert.equal(((await regenerateField("hashtags", PRODUCTIVITY, { call: many.call, provider: "claude-cli" })).value as string[]).length, 12);
  await assert.rejects(
    () => regenerateField("hashtags", PRODUCTIVITY, { call: fakeCall({ hashtags: ["#a", "#b"] }).call, provider: "claude-cli" }),
    /too few hashtags/,
  );
});

// ---------------------------------------------------------------- GAP 3: the batched platform generator

const PLATFORM_REPLY = {
  tags: ["deep work", "focus", "attention", "productivity", "time blocking", "single tasking", "book summary"],
  igHook: "Busy is not the same as focused. 🎯",
  igCaption:
    "Most of us are busy all day and focused for none of it. 🧠\n\nDeep work is one hard task, full attention, a long stretch. Switching tasks leaves part of your mind behind.\n\nBlock the time. Protect it.",
  igHashtags: ["#deepwork", "#focus", "#productivity", "#booktok", "#attention", "#timeblocking"],
};

test("one call yields the YouTube tags and all three Instagram fields, from the stored script", async () => {
  const fake = fakeCall(PLATFORM_REPLY);
  const out = await generatePlatformMetadata(
    { ...PRODUCTIVITY, description: STRUCTURED },
    { call: fake.call, provider: "claude-cli" },
  );

  assert.equal(fake.seen.length, 1, "ONE model call for all four fields");
  assert.deepEqual(Object.keys(out).sort(), ["igCaption", "igHashtags", "igHook", "tags"]);
  assert.equal(out.igHook, "Busy is not the same as focused. 🎯");
  assert.deepEqual(out.igHashtags, ["#deepwork", "#focus", "#productivity", "#booktok", "#attention", "#timeblocking"]);
  assert.ok(out.tags.length >= 5 && out.tags.length <= 15);
  assert.ok(out.tags.every((t) => !t.includes("#")), "keyword tags carry no #");

  // The schema it is held to is the four fields, with the same caps Regenerate uses.
  const schema = fake.seen[0].schema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.deepEqual([...schema.required].sort(), ["igCaption", "igHashtags", "igHook", "tags"]);
  assert.equal(schema.properties.igHook.maxLength, 150);
  assert.equal(schema.properties.igCaption.maxLength, 800);
  assert.equal(schema.properties.tags.minItems, 5);
  assert.equal(schema.properties.tags.maxItems, 15);
  assert.equal(schema.properties.igHashtags.minItems, 5);
  assert.equal(schema.properties.igHashtags.maxItems, 20);

  // It reuses the per-field briefs rather than inventing a second statement of them.
  const { system, user } = fake.seen[0];
  assert.match(user, /YouTube SEO keyword tags/);
  assert.match(user, /Instagram Reel title and opening line/);
  assert.match(user, /NOT the YouTube description reused/);
  assert.match(user, /do not repeat the igHook line inside it/);
  // Found in the first real run: a hook claimed "just do it never sticks", which the script never says.
  assert.match(user, /Say only what the script says: a sharper way of saying it is fine, a new claim is not/);
  assert.match(user, /Every claim in it must be something the script says/);
  assert.match(user, /Instagram hashtags/);
  assert.match(user, /Deep work means giving one hard task your full attention/, "grounded in the stored script");
  assert.doesNotMatch(user, /Ever finish a day full of tasks/, "the YouTube description is never shown to the writer");
  assert.equal(callKind(system), "other", "must not be classified as the script writer");
  assert.match(system, /Never name or imply an author/);
  assert.match(system, /Never write a URL/);
});

test("the book's title is always among the tags; a VERIFIED author is added, an unverified one never", async () => {
  const bare = await generatePlatformMetadata(PRODUCTIVITY, { call: fakeCall(PLATFORM_REPLY).call, provider: "claude-cli" });
  assert.equal(bare.tags[0], "The Focus Habit", "the title leads");
  assert.ok(!bare.tags.some((t) => /newport/i.test(t)));

  const fake = fakeCall(PLATFORM_REPLY);
  const withAuthor = await generatePlatformMetadata({ ...PRODUCTIVITY, author: "Cal Newport" }, { call: fake.call, provider: "claude-cli" });
  assert.deepEqual(withAuthor.tags.slice(0, 2), ["The Focus Habit", "Cal Newport"]);
  assert.match(fake.seen[0].user, /Author: Cal Newport/);

  const noAuthor = fakeCall(PLATFORM_REPLY);
  await generatePlatformMetadata(PRODUCTIVITY, { call: noAuthor.call, provider: "claude-cli" });
  assert.match(noAuthor.seen[0].user, /Author: not established/);

  // Not duplicated when the model already wrote them, whatever the case.
  const already = await generatePlatformMetadata(
    { ...PRODUCTIVITY, author: "Cal Newport" },
    { call: fakeCall({ ...PLATFORM_REPLY, tags: ["the focus habit", "cal newport", "focus", "attention", "productivity"] }).call, provider: "claude-cli" },
  );
  assert.equal(already.tags.filter((t) => /focus habit/i.test(t)).length, 1);
  assert.equal(already.tags.filter((t) => /cal newport/i.test(t)).length, 1);

  // A subtitle or a comma never becomes part of ONE tag (the line is comma-separated).
  const subtitle = await generatePlatformMetadata(
    { ...PRODUCTIVITY, bookTitle: "Deep Work: Rules for Focused Success, Revised" },
    { call: fakeCall({ ...PLATFORM_REPLY, tags: ["focus", "attention", "productivity", "habits", "time blocking"] }).call, provider: "claude-cli" },
  );
  assert.equal(subtitle.tags[0], "Deep Work");
});

/**
 * The titles in the operator's real library are not tidy: an archive id in
 * brackets, a file name, an author credit typed into the title of a book whose
 * author was never verified. The tag the code guarantees must never carry any of
 * that -- found when the first real run put "How to use your mind; a psychology
 * of study; (IA howtouseyourmind00kits)" and "How to Live on 24 Hours a Day by
 * Arnold Bennett" (an unverified author) into the tag line.
 */
test("the book-name tag is the name a reader searches for: no archive id, no file name, never an unverified author", async () => {
  const filler = ["alpha", "bravo", "charlie", "delta", "echo"];
  const tagsFor = async (bookTitle: string, author: string | null, tags: string[]) =>
    (await generatePlatformMetadata({ ...PRODUCTIVITY, bookTitle, author }, { call: fakeCall({ ...PLATFORM_REPLY, tags }).call, provider: "claude-cli" })).tags;

  // An archive id and a subtitle are dropped.
  assert.equal(
    (await tagsFor("How to use your mind; a psychology of study; (IA howtouseyourmind00kits)", null, filler))[0],
    "How to use your mind",
  );
  // An author credit inside the TITLE is not published as a tag when no author is verified...
  const unverified = await tagsFor("How to Live on 24 Hours a Day by Arnold Bennett", null, filler);
  assert.equal(unverified[0], "How to Live on 24 Hours a Day");
  assert.ok(!unverified.some((t) => /bennett/i.test(t)), "an unverified author is never named, not even through the title");
  // ...and a VERIFIED author is added once, separately.
  assert.deepEqual((await tagsFor("How to Live on 24 Hours a Day by Arnold Bennett", "Arnold Bennett", filler)).slice(0, 2), [
    "How to Live on 24 Hours a Day",
    "Arnold Bennett",
  ]);
  // A file name or a domain is not a name worth a tag: nothing is added at all.
  assert.deepEqual(await tagsFor("gutenberg.org cache epub 10674 pg10674.txt", null, filler), filler);
  assert.deepEqual(await tagsFor("pg10674.txt", null, filler), filler);

  // Nothing is added when the writer already named it -- in its own words, case and word order aside.
  assert.deepEqual(await tagsFor("How to use your mind; a psychology of study; (IA howtouseyourmind00kits)", null, ["how to use your mind", ...filler]), [
    "how to use your mind",
    ...filler,
  ]);
  assert.deepEqual(
    (await tagsFor("Productivity The Art of Getting Important Things Done 70 Pages", null, ["productivity the art of getting important things done", ...filler])).slice(0, 2),
    ["productivity the art of getting important things done", "alpha"],
    "a tag that is most of the title (the writer dropped '70 Pages') covers it",
  );
  // A short name is not 'covered' by a tag that merely shares a word with it.
  assert.equal((await tagsFor("The Focus Habit", null, ["focus", ...filler]))[0], "The Focus Habit");
});

test("tags are a comma list: no '#', de-duplicated, and the whole line stays under YouTube's 500", async () => {
  const out = await generatePlatformMetadata(PRODUCTIVITY, {
    call: fakeCall({ ...PLATFORM_REPLY, tags: ["#focus", "Focus", "deep work", "Deep Work", "attention", "productivity", "habits"] }).call,
    provider: "claude-cli",
  });
  assert.deepEqual(out.tags, ["The Focus Habit", "focus", "deep work", "attention", "productivity", "habits"]);
  assert.ok(out.tags.every((t) => !t.includes("#")));
  assert.ok([...tagsLine(out.tags)].length <= YOUTUBE_TAGS_LIMIT);
  assert.equal(tagsLine(out.tags), "The Focus Habit, focus, deep work, attention, productivity, habits");
});

test("a reply over a cap is REFUSED, not truncated, and returns nothing at all", async () => {
  const refuses = async (reply: Record<string, unknown>, message: RegExp, src: RegenerateSource = PRODUCTIVITY) => {
    await assert.rejects(
      () => generatePlatformMetadata(src, { call: fakeCall({ ...PLATFORM_REPLY, ...reply }).call, provider: "claude-cli" }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "regenerate_failed");
        assert.equal((err as { status: number }).status, 502);
        assert.match((err as Error).message, message);
        return true;
      },
    );
  };

  // 15 tags of 40 characters is 600+ comma-joined: over YouTube's 500, so refused rather than cut.
  const fat = Array.from({ length: 15 }, (_, i) => `a very long keyword phrase number ${String(i).padStart(2, "0")} x`);
  assert.ok(fat.join(", ").length > YOUTUBE_TAGS_LIMIT);
  await refuses({ tags: fat }, /over the 500 YouTube allows/);

  await refuses({ tags: ["a", "b"] }, /too few tags/);
  await refuses({ igHashtags: ["#a", "#b", "#c"] }, /too few Instagram hashtags/);
  await refuses({ igHook: "h".repeat(151) }, /igHook of 151 characters, over the 150 asked for/);
  await refuses({ igCaption: "c".repeat(801) }, /igCaption of 801 characters, over the 800 asked for/);
  await refuses({ igHook: "   " }, /returned no igHook/);
  await refuses({ igCaption: undefined }, /returned no igCaption/);
});

test("an over-long LIST is cut to its maximum, the way Regenerate does it; prose at the cap is kept whole", async () => {
  const out = await generatePlatformMetadata(PRODUCTIVITY, {
    call: fakeCall({
      ...PLATFORM_REPLY,
      tags: Array.from({ length: 20 }, (_, i) => `kw${i}`),
      igHashtags: Array.from({ length: 30 }, (_, i) => `#h${i}`),
      igHook: "h".repeat(150),
      igCaption: "c".repeat(800),
    }).call,
    provider: "claude-cli",
  });
  assert.equal(out.tags.length, 15);
  assert.equal(out.igHashtags.length, 20);
  assert.equal(out.igHook.length, 150);
  assert.equal(out.igCaption.length, 800);
});

test("Instagram copy is its own: a hook that is the YouTube title, or a caption that is the description, is refused", async () => {
  // The hook is the title with its emoji and punctuation changed.
  await assert.rejects(
    () =>
      generatePlatformMetadata(PRODUCTIVITY, {
        call: fakeCall({ ...PLATFORM_REPLY, igHook: "why deep work beats being busy!" }).call,
        provider: "claude-cli",
      }),
    /reused the YouTube title as the Instagram hook/,
  );

  // The caption is the description, or the description with a line added.
  for (const igCaption of [STRUCTURED.slice(0, 700), `${STRUCTURED.slice(0, 600)}`]) {
    await assert.rejects(
      () =>
        generatePlatformMetadata(
          { ...PRODUCTIVITY, description: STRUCTURED.slice(0, 700) },
          { call: fakeCall({ ...PLATFORM_REPLY, igCaption }).call, provider: "claude-cli" },
        ),
      /reused the YouTube description as the Instagram caption/,
    );
  }

  // A genuinely different caption and hook go through, and are not the YouTube fields.
  const out = await generatePlatformMetadata(
    { ...PRODUCTIVITY, description: STRUCTURED },
    { call: fakeCall(PLATFORM_REPLY).call, provider: "claude-cli" },
  );
  assert.notEqual(out.igHook, PRODUCTIVITY.title);
  assert.notEqual(out.igCaption, STRUCTURED);
  assert.ok([...out.igCaption].length < [...STRUCTURED].length, "concise for social, not the YouTube body");
  assert.ok([...out.igCaption].length <= 800);

  // The same two rules guard a single-field Regenerate, so the two paths cannot disagree.
  await assert.rejects(
    () => regenerateField("igHook", PRODUCTIVITY, { call: fakeCall({ igHook: "Why Deep Work Beats Being Busy" }).call, provider: "claude-cli" }),
    /reused the YouTube title/,
  );
});

test("the generator refuses to run without a script, spends no call, and reports an unreachable writer as a 502", async () => {
  const none = fakeCall(PLATFORM_REPLY);
  await assert.rejects(
    () => generatePlatformMetadata({ ...PRODUCTIVITY, script: null, voScript: null }, { call: none.call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, "no_script");
      assert.equal((err as { status: number }).status, 409);
      return true;
    },
  );
  assert.equal(none.seen.length, 0, "no model call is spent finding out");

  await assert.rejects(
    () => generatePlatformMetadata(PRODUCTIVITY, { call: fakeCall(new Error("claude: not signed in")).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.equal((err as { status: number }).status, 502);
      assert.match((err as Error).message, /not signed in/);
      return true;
    },
  );

  // A flattened voiceover is the fallback when the stored beats do not parse.
  const flat = fakeCall(PLATFORM_REPLY);
  await generatePlatformMetadata({ ...PRODUCTIVITY, script: "{not json" }, { call: flat.call, provider: "claude-cli" });
  assert.match(flat.seen[0].user, /Most people are busy\./);
});

// ---------------------------------------------------------------- three different topics

/**
 * Productivity, study skills and mindset, driven through the real prompt and
 * validation with a stubbed writer that answers each as that topic would.
 *
 * What this proves is the PLUMBING, not the model: each topic's own script is
 * what the writer is shown, nothing in the code supplies a shared list of tags
 * or hashtags that would make three videos look the same, the only words the
 * code adds to a tag list are the book's own title (and a verified author), and
 * every platform keeps its own fields. That the real model writes distinct,
 * apt copy for three real episodes is checked in the browser, not here.
 */
const TOPICS = [
  {
    name: "productivity",
    src: PRODUCTIVITY,
    reply: PLATFORM_REPLY,
    hashtags: ["#DeepWork", "#BookReel", "#FocusHabit", "#Productivity", "#TimeBlocking"],
    description: STRUCTURED,
  },
  {
    name: "study skills",
    src: STUDY,
    reply: {
      tags: ["retrieval practice", "active recall", "study tips", "spaced repetition", "how to study", "learning science"],
      igHook: "Re-reading is the study habit that feels best and works worst.",
      igCaption:
        "You read it three times and still blanked on the test. 📚\n\nTesting yourself pulls the answer out of memory, and that effort is what makes it last. Space it across days, not the night before.",
      igHashtags: ["#studytips", "#activerecall", "#studygram", "#learning", "#examprep", "#spacedrepetition"],
    },
    hashtags: ["#StudyTips", "#BookReel", "#ActiveRecall", "#SpacedRepetition", "#Learning"],
    description:
      "📚 Stop re-reading, start testing yourself\n\nWhy does re-reading feel like learning when it mostly builds familiarity?\n\nTesting yourself pulls the answer out of memory, and that effort is what makes it last.\n\nInspired by ideas from Make It Last\n\nWhat you'll discover:\n🧠 Why re-reading builds familiarity, not memory\n✅ How testing yourself makes it last\n📅 Why spacing beats cramming\n\nSpace your practice across days.\n\nFollow BookReel for more ideas from books.",
  },
  {
    name: "mindset",
    src: MINDSET,
    reply: {
      tags: ["growth mindset", "fixed mindset", "learning from failure", "self improvement", "the power of yet", "resilience"],
      igHook: "Three letters that turn a verdict into a plan: not yet.",
      igCaption:
        "Failing at something doesn't mean you're bad at it. 🌱\n\nTreat a failure as information, not a verdict, and the sentence changes from a judgement into a plan. You're not there yet.",
      igHashtags: ["#growthmindset", "#selfimprovement", "#resilience", "#mindsetshift", "#personalgrowth", "#notyet"],
    },
    hashtags: ["#GrowthMindset", "#BookReel", "#PowerOfYet", "#Resilience", "#SelfImprovement"],
    description:
      "🌱 The word that turns failure into a plan\n\nWhat if \"I can't\" is just missing one word?\n\nWhen you treat a failure as information instead of a verdict, you keep trying.\n\nInspired by ideas from The Power of Yet\n\nWhat you'll discover:\n🌱 Why abilities are not fixed\n💡 Failure as information, not a verdict\n🚀 How yet turns a judgement into a plan\n\nYou are not bad at this. You are not good at it yet.\n\nFollow BookReel for more ideas from books.",
  },
];

test("three different topics get their own script in the prompt, their own copy back, and no shared fixed list", async () => {
  type Result = { t: (typeof TOPICS)[number]; tags: PlatformMetadata; hashtags: string[]; description: string };
  const results: Result[] = [];
  for (const t of TOPICS) {
    const platform = fakeCall(t.reply);
    const tags = await generatePlatformMetadata({ ...t.src, description: t.description }, { call: platform.call, provider: "claude-cli" });

    const regen = fakeCall({ hashtags: t.hashtags });
    const hashtags = (await regenerateField("hashtags", t.src, { call: regen.call, provider: "claude-cli" })).value as string[];

    const desc = fakeCall({ description: t.description });
    const description = (await regenerateField("description", t.src, { call: desc.call, provider: "claude-cli" })).value as string;

    // Each prompt carries THIS topic's script and none of the others'.
    const others = TOPICS.filter((o) => o !== t);
    for (const sent of [platform.seen[0].user, regen.seen[0].user, desc.seen[0].user]) {
      assert.ok(sent.includes(JSON.parse(t.src.script!)[0].voiceover), `${t.name}: its own script is in the prompt`);
      for (const o of others) {
        const foreign = JSON.parse(o.src.script!)[1].voiceover as string;
        assert.ok(!sent.includes(foreign), `${t.name}: ${o.name}'s script leaked into the prompt`);
      }
    }

    // The only word the code ever adds to a tag list is the book's own title -- and not even that
    // when the writer already wrote it (the mindset reply has "the power of yet").
    const added = tags.tags.filter((tag) => !t.reply.tags.map((x) => x.toLowerCase()).includes(tag.toLowerCase()));
    assert.ok(added.every((a) => a === t.src.bookTitle), `${t.name}: the code added ${added.join(", ")}`);
    assert.ok(tags.tags.some((x) => x.toLowerCase() === t.src.bookTitle.toLowerCase()), `${t.name}: the book title is a tag`);

    // Platform separation and shape.
    assert.ok(tags.tags.every((x) => !x.includes("#")));
    assert.ok([...tagsLine(tags.tags)].length <= YOUTUBE_TAGS_LIMIT);
    assert.ok(tags.igHashtags.every((x) => x.startsWith("#")));
    assert.ok(hashtags.length >= 3 && hashtags.length <= 12);
    assert.ok(hashtags.includes("#BookReel"));
    assert.notEqual(tags.igHook, t.src.title);
    assert.notEqual(tags.igCaption, description);
    assert.doesNotMatch(description, /(^|\s)#\w/, `${t.name}: no hashtag line inside the description`);
    assert.ok(description.split("\n\n").length >= 6, `${t.name}: a multi-section body`);
    assert.ok(titleEmojiShape(t.src.title!).leading === 1 && titleEmojiShape(t.src.title!).trailing >= 1);

    results.push({ t, tags, hashtags, description });
  }

  // Distinct across topics -- nothing is a shared list.
  const sets = (pick: (r: Result) => string[]) =>
    results.map((r) => new Set(pick(r).map((x) => x.toLowerCase())));
  for (const [label, pick] of [
    ["tags", (r: Result) => r.tags.tags],
    ["igHashtags", (r: Result) => r.tags.igHashtags],
    ["hashtags", (r: Result) => r.hashtags],
  ] as const) {
    const [a, b, c] = sets(pick);
    for (const [x, y, names] of [[a, b, "productivity/study"], [a, c, "productivity/mindset"], [b, c, "study/mindset"]] as const) {
      const shared = [...x].filter((v) => y.has(v));
      // #BookReel is the channel's own tag and is meant to repeat; nothing else may.
      const meaningful = shared.filter((v) => v !== "#bookreel");
      assert.deepEqual(meaningful, [], `${label}: ${names} share ${meaningful.join(", ")}`);
    }
  }
  assert.equal(new Set(results.map((r) => r.tags.igHook)).size, 3);
  assert.equal(new Set(results.map((r) => r.tags.igCaption)).size, 3);
  assert.equal(new Set(results.map((r) => r.description)).size, 3);
});

// ---------------------------------------------------------------- wiring, pinned in source

test("the render starts the platform copy right after the script is stored, never lets it fail the render, and waits for it only briefly", async () => {
  const src = await fs.readFile(fileURLToPath(new URL("../src/lib/pipeline.ts", import.meta.url)), "utf8");
  const stored = src.indexOf("title: stripAngleBrackets(pkg.title)");
  const started = src.indexOf("runPlatformMetadataStep(episodeId");
  const assets = src.indexOf("await startStep(EPISODE_STEPS[3]); // Preparing page assets");
  const render = src.indexOf("await startStep(EPISODE_STEPS[9]); // Rendering the video");
  const joined = src.indexOf("PLATFORM_COPY_GRACE_MS", render);
  const done = src.indexOf('data: { status: "DONE", videoPath', render);

  assert.ok(stored > 0 && started > stored, "started after the title, description and hashtags are written");
  assert.ok(started < assets, "started before any of the slow work, so it overlaps it");
  assert.ok(joined > render && joined < done, "joined after the render and before the episode is marked DONE");
  // Best-effort: the step is the never-throwing one, its failure is a NOTE, and the wait is bounded.
  assert.match(src, /if \(platformNote\) await appendNotes\(episodeId, \[platformNote\]\)/);
  assert.match(src, /const PLATFORM_COPY_GRACE_MS = 60_000/);
  assert.match(src, /appendBookLink\(stripAngleBrackets\(pkg\.description\), episode\.book\.bookLink\)\]\.length > DESCRIPTION_MAX/, "a description pushed past 5,000 by the link is noted, not silently stored");
  assert.match(src, /description: appendBookLink\(stripAngleBrackets\(pkg\.description\), episode\.book\.bookLink\)/, "the link is still appended once, in code");
});

test("the generate route authenticates, applies the visibility rule, requires a DONE episode, and answers with the whole view", async () => {
  const src = await fs.readFile(
    fileURLToPath(new URL("../src/app/api/episodes/[id]/publish/generate/route.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /export async function POST/);
  assert.match(src, /currentUser\(\)/);
  assert.match(src, /status: 401/);
  assert.match(src, /loadForRegenerate\(user\.id, id\)/, "visibility is the shared rule, not a hand-rolled where");
  assert.match(src, /row\.status !== "DONE"/);
  assert.match(src, /generateMissingPlatformMetadata\(id\)/);
  assert.match(src, /NextResponse\.json\(await publishView\(user\.id, id\)\)/, "the answer is the view, like save and regenerate");
});
