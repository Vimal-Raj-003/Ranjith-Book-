import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOK_THEME_IDS,
  DEFAULT_BOOK_THEME_ID,
  THEME_SETTING_AUTO,
  bookThemeById,
  isBookThemeId,
  isThemeSetting,
} from "../src/lib/video/composition/themes";
import { THEME_GUIDE, themeForTextSync, themeTop } from "../src/lib/video/composition/themes/choose";
import { AUTO_THEME_OPTION, VIDEO_THEMES } from "../src/lib/strings";

/* ===========================================================================
 * Choosing a theme from the content (themes/choose.ts)
 *
 * The defect these cover, measured on the real library before the change: a
 * theme came from one global operator setting with a fixed default, so it had
 * nothing to do with what a video was about. Across the last 40 episodes the
 * split was marginalia 16, editorial 20, spotlight 3, terminal 1 — it tracked
 * when the operator last touched the setting, and four finished videos on four
 * unrelated subjects all rendered in the same palette because all four were
 * stamped marginalia.
 *
 * So what is worth asserting is not "it returns a theme" — the old code did
 * that perfectly well. It is that unrelated subjects come out DIFFERENT, that
 * the answer never wanders, and that an operator who picks one explicitly is
 * still obeyed.
 * ======================================================================== */

// Spread across what this catalogue of books actually covers, and written as
// prose rather than keyword soup, because prose is what the caller passes: an
// idea's title, hook, core idea and angle run together into one string.
const IDEA_TEXTS: Record<string, string> = {
  time: "Time slips away while you wait. You keep saying you will begin tomorrow, but the hours are spent whether you choose or not, and nobody alive can buy a twenty-fifth hour.",
  method: "Build a system rather than a wish. A plan with steps beats intention: decide the rule, write the schedule, and let the method carry you on the days you do not feel like it.",
  mind: "Concentration is the whole of it. An unruly mind wanders wherever it likes; a trained one stays where you put it, and that is a skill like any other skill.",
  people: "To listen properly to another person is far rarer than it sounds, and that attention is most of what friendship actually consists of.",
  measure: "Keep the record. Count the hours against the claim, and the gap between what you believe about yourself and what is true begins to close.",
};

test("a theme is chosen from the content, and unrelated subjects do not all land on one", () => {
  const picked = Object.fromEntries(
    Object.entries(IDEA_TEXTS).map(([k, v]) => [k, themeForTextSync(v)]),
  );
  for (const [subject, id] of Object.entries(picked)) {
    assert.ok(isBookThemeId(id), `${subject} chose "${id}", which is not a theme this build has`);
  }
  // The bar is separation, not one particular mapping: a picker that answered
  // "marginalia" every time would satisfy every other assertion in this file
  // and would be precisely the defect it replaced.
  const distinct = new Set(Object.values(picked)).size;
  assert.ok(
    distinct >= 3,
    `five unrelated subjects produced only ${distinct} theme(s) (${JSON.stringify(picked)}) — the look would barely change between videos`,
  );
});

test("the suggestion list and the stamped theme come from one ranking", () => {
  // The inspector shows `themeTop`; `runIngest` and `createIdeaEpisodes` stamp
  // `themeForTextSync`. If those were two copies of the scoring they would
  // agree today and drift the first time one was touched, and the symptom would
  // be a panel telling the operator Auto picks a theme that Auto does not pick.
  // They are one function now, and this is what holds them to it.
  for (const [subject, text] of Object.entries(IDEA_TEXTS)) {
    assert.equal(themeTop(text, 1)[0], themeForTextSync(text), `${subject} ranks differently from how it is stamped`);
    assert.equal(themeTop(text, 3)[0], themeForTextSync(text), `${subject}'s top suggestion is not the theme it would get`);
  }
  // Including the cases with no keyword signal at all, where the answer comes
  // from `spread` rather than from the scores — the path most likely to be
  // reimplemented slightly differently in a second copy.
  for (const text of ["", "   \n  ", "!!! ??? ...", "zzz qqq"]) {
    assert.equal(themeTop(text, 1)[0], themeForTextSync(text), `wordless text ${JSON.stringify(text)} disagrees`);
    assert.equal(themeTop(text, 3).length, 1, "a text that matches nothing must not be padded with registry order");
  }
  // A ranked list is a prefix of a longer one, never a reshuffle.
  const text = IDEA_TEXTS.method;
  assert.deepEqual(themeTop(text, 2), themeTop(text, 5).slice(0, 2));
  for (const id of themeTop(text, 5)) assert.ok(isBookThemeId(id), `${id} is not a theme this build has`);
});

test("the same text always chooses the same theme", () => {
  for (const [subject, text] of Object.entries(IDEA_TEXTS)) {
    const first = themeForTextSync(text);
    for (let i = 0; i < 5; i++) {
      assert.equal(themeForTextSync(text), first, `${subject} is not deterministic`);
    }
  }
});

test("every theme is described, and wordless text still answers", () => {
  // A guide entry per theme, so a theme cannot be added without saying what it
  // is for — the same discipline HERO_GUIDE and HERO_ENVIRONMENT already hold.
  for (const id of BOOK_THEME_IDS) {
    assert.ok(THEME_GUIDE[id], `${id} has no entry in THEME_GUIDE`);
    assert.ok(THEME_GUIDE[id].use.length > 0, `${id} does not say what it is for`);
    assert.ok(THEME_GUIDE[id].words.length > 0, `${id} has no words to match on`);
  }
  // Total: a blank or wordless idea must still render something, never throw.
  assert.ok(isBookThemeId(themeForTextSync("")), "empty text did not produce a theme");
  assert.ok(isBookThemeId(themeForTextSync("   \n  ")), "whitespace did not produce a theme");
  assert.ok(isBookThemeId(themeForTextSync("!!! ??? ...")), "punctuation did not produce a theme");
});

test("no two themes are described by the same words", () => {
  // Overlapping word lists are the known failure mode for this kind of ranker
  // in this repo — commit 94d5ccc trimmed the hero lists for exactly this —
  // and it shows up as one theme quietly absorbing its neighbour's subjects.
  for (const a of BOOK_THEME_IDS) {
    for (const b of BOOK_THEME_IDS) {
      if (a >= b) continue;
      const wa = new Set(THEME_GUIDE[a].words.map((w) => w.toLowerCase()));
      const shared = THEME_GUIDE[b].words.filter((w) => wa.has(w.toLowerCase()));
      assert.equal(
        shared.length,
        0,
        `${a} and ${b} both claim ${JSON.stringify(shared)} — whichever is scored first will absorb the other's subjects`,
      );
    }
  }
});

test("an operator who picks a theme still gets exactly that one", () => {
  // "auto" is storable but is NOT a theme: nothing may ever render in it.
  assert.ok(isThemeSetting(THEME_SETTING_AUTO), "auto is not accepted as a setting");
  assert.ok(!isBookThemeId(THEME_SETTING_AUTO), "auto leaked into the renderable theme union");
  for (const id of BOOK_THEME_IDS) {
    assert.ok(isThemeSetting(id), `${id} is not accepted as a setting`);
  }
  assert.ok(!isThemeSetting("chartreuse"), "an unknown id was accepted as a setting");
  assert.ok(!isThemeSetting(null), "null was accepted as a setting");

  // An episode stamped with a real id still resolves to that theme, which is
  // what keeps a finished video and the look it claims in agreement.
  for (const id of BOOK_THEME_IDS) {
    assert.equal(bookThemeById(id).id, id, `${id} did not resolve back to itself`);
  }
  // A row written by a build that predates all of this must still render.
  assert.equal(bookThemeById(null).id, DEFAULT_BOOK_THEME_ID, "a null stored theme stopped resolving");
  assert.equal(
    bookThemeById(THEME_SETTING_AUTO).id,
    DEFAULT_BOOK_THEME_ID,
    "auto must never reach the renderer as a theme",
  );
});

test("the picker offers auto alongside every implemented theme", () => {
  assert.equal(
    AUTO_THEME_OPTION.id,
    THEME_SETTING_AUTO,
    "the picker's auto entry does not match the value that gets stored",
  );
  for (const id of BOOK_THEME_IDS) {
    assert.ok(VIDEO_THEMES.some((t) => t.id === id), `${id} is implemented but the picker never offers it`);
  }
  assert.ok(
    !VIDEO_THEMES.some((t) => t.id === THEME_SETTING_AUTO),
    "auto is listed among the real themes rather than beside them",
  );
});
