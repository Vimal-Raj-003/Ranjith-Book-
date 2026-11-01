import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { locateChromium as findChromium } from "../src/lib/publish/browser/engine";
import { setAiUse, setCategory, setVideoLanguage, setVideoLocation, setYouTubeTags } from "../src/lib/publish/browser/youtube-settings";
import { detailsFixture, fixtureTags } from "./helpers/youtube-details-fixture.mjs";

/**
 * Studio's Details screen, reproduced closely enough to catch the two ways this
 * code has actually gone wrong against the real one.
 *
 * The first: the screen asks Yes/No four times over, and a search that ranged
 * too far up the DOM answered the AI question by flipping Made for Kids. The
 * fixture therefore keeps all four questions, with the real wording, in the
 * real order — the AI one last, so a matcher that takes the first Yes it finds
 * fails here the way it failed there.
 *
 * The second: the menus do not hold still. Studio renders the language options
 * a moment after the menu opens and re-renders the location suggestions as the
 * autocomplete settles, so a list read in one call and clicked in another was
 * gone by the time it was clicked. Both delays are reproduced.
 *
 * The DOM is a stand-in; the matching, the already-set checks, the verification
 * and the logging are the shipping code.
 */

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: (await findChromium()) ?? undefined });
});
test.after(async () => {
  await browser?.close();
});

function recorder() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

/** A Yes/No question, as Studio builds one: a section, a question, two radios. */
const question = (id: string, text: string, yes: string, no: string) => `
  <div class="section" id="${id}">
    <div class="title">${text}</div>
    <tp-yt-paper-radio-button data-opt="${id}-yes" aria-checked="false">${yes}</tp-yt-paper-radio-button>
    <tp-yt-paper-radio-button data-opt="${id}-no" aria-checked="false">${no}</tp-yt-paper-radio-button>
  </div>`;

/** Every Yes/No on the screen, in Studio's order, with the AI one last. */
const QUESTIONS = [
  question(
    "kids",
    "Audience. This video is set as not Made for Kids",
    "Yes, it's Made for Kids. Features like personalised ads and notifications won't be available on videos that are Made for Kids.",
    "No, it's not 'Made for Kids'",
  ),
  question(
    "age",
    "Age restriction (advanced)",
    "Yes, restrict my video to viewers over 18",
    "No, don't restrict my video to viewers over 18 only",
  ),
  question(
    "promo",
    "Paid promotion",
    "Yes, my video includes paid promotion",
    "No, my video doesn't include paid promotion",
  ),
  question(
    "ai",
    "AI use. Do you want to let people know your video contains altered or synthetic content that appears realistic? Learn more",
    "Yes",
    "No",
  ),
].join("");

/**
 * A dropdown shaped like Studio's: the label sits outside the trigger, the
 * trigger is wrapped in a second element matching the same selector, and the
 * options arrive late.
 */
const dropdown = (id: string, label: string, value: string, options: string[], delay: number) => `
  <div class="form-row" id="${id}-container">
    <div class="label">${label}</div>
    <ytcp-text-dropdown-trigger id="${id}-trigger">
      <ytcp-dropdown-trigger>${value}</ytcp-dropdown-trigger>
    </ytcp-text-dropdown-trigger>
  </div>
  <div id="${id}-menu" style="display:none"></div>
  <script>
    document.querySelector("#${id}-trigger").addEventListener("click", () => {
      const menu = document.querySelector("#${id}-menu");
      setTimeout(() => {
        menu.style.display = "block";
        menu.innerHTML = ${JSON.stringify(options)}
          .map((o) => '<tp-yt-paper-item data-opt="' + o + '">' + o + '</tp-yt-paper-item>').join("");
        for (const el of menu.querySelectorAll("[data-opt]")) {
          el.addEventListener("click", () => {
            el.setAttribute("data-clicked", "yes");
            document.querySelector("#${id}-trigger ytcp-dropdown-trigger").textContent = el.textContent;
            menu.style.display = "none";
          });
        }
      }, ${delay});
    });
  </script>`;

/** English among its near misses, and the category already right in en-GB spelling. */
const LANGUAGES = ["English (Australia)", "English (Canada)", "English", "English (India)", "English (UK)"];

async function detailsPage(extra = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<body style="font-family:sans-serif">
    ${QUESTIONS}
    ${dropdown("language", "Video language", "Select", LANGUAGES, 900)}
    ${dropdown("category", "Category", "Science and technology", ["Education", "Science and technology"], 300)}
    ${extra}
  </body>`);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("tp-yt-paper-radio-button")) {
      el.addEventListener("click", () => {
        el.setAttribute("data-clicked", "yes");
        el.setAttribute("aria-checked", "true");
      });
    }
  });
  return page;
}

const clicked = (page: Page, opt: string) => page.locator(`[data-opt="${opt}"]`).getAttribute("data-clicked");

test("AI use answers its own question and leaves Made for Kids alone", async () => {
  const page = await detailsPage();
  const { lines, log } = recorder();

  assert.equal(await setAiUse(page, log), true, lines.join(" | "));
  assert.equal(await clicked(page, "ai-yes"), "yes", "the AI question was not answered");
  for (const other of ["kids-yes", "age-yes", "promo-yes", "ai-no"]) {
    assert.equal(await clicked(page, other), null, `${other} must never be clicked`);
  }
  assert.ok(lines.some((l) => /verified "Yes"/.test(l)), lines.join(" | "));
  await page.close();
});

test("an AI question already answered Yes is not clicked again", async () => {
  const page = await detailsPage();
  await page.locator('[data-opt="ai-yes"]').evaluate((el) => el.setAttribute("aria-checked", "true"));
  const { lines, log } = recorder();

  assert.equal(await setAiUse(page, log), true, lines.join(" | "));
  assert.equal(await clicked(page, "ai-yes"), null, "clicked an answer that was already given");
  assert.ok(lines.some((l) => /already "Yes"/.test(l)), lines.join(" | "));
  await page.close();
});

test("a screen without the AI question is left alone and says so", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<body>${QUESTIONS.replace(/AI use[^<]*/, "Comments and ratings")}</body>`);
  const { lines, log } = recorder();

  assert.equal(await setAiUse(page, log), false);
  assert.ok(lines.some((l) => /no Yes\/No question about AI/.test(l)), lines.join(" | "));
  await page.close();
});

test("the language menu is waited for, and English beats its near misses", async () => {
  const page = await detailsPage();
  const { lines, log } = recorder();

  assert.equal(await setVideoLanguage(page, "English", log), true, lines.join(" | "));
  assert.equal(await clicked(page, "English"), "yes");
  for (const near of ["English (India)", "English (UK)"]) {
    assert.equal(await clicked(page, near), null, `${near} must never be chosen`);
  }
  assert.ok(lines.some((l) => /verified "English"/.test(l)), lines.join(" | "));
  await page.close();
});

test('"Science & Technology" matches the "Science and technology" already set', async () => {
  const page = await detailsPage();
  const { lines, log } = recorder();

  assert.equal(await setCategory(page, "Science & Technology", log), true, lines.join(" | "));
  // The options only exist once the menu is opened, so an empty menu is the
  // evidence that nothing was reselected.
  assert.equal(await page.locator("#category-menu [data-opt]").count(), 0, "opened a menu for a category already set");
  assert.ok(lines.some((l) => /already "Science and technology"/.test(l)), lines.join(" | "));
  await page.close();
});

test("the category is chosen when the screen opens on something else", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(
    `<body>${dropdown("category", "Category", "Select", ["Education", "Science and technology"], 300)}</body>`,
  );
  const { lines, log } = recorder();

  assert.equal(await setCategory(page, "Science & Technology", log), true, lines.join(" | "));
  assert.equal(await clicked(page, "Science and technology"), "yes");
  assert.equal(await clicked(page, "Education"), null);
  await page.close();
});

/** The location field, with Google's suggestions arriving and re-rendering as they do. */
const LOCATION = `
  <div class="form-row">
    <div class="label">Video location</div>
    <input aria-label="Video location" />
  </div>
  <div id="places"></div>
  <script>
    const places = document.querySelector("#places");
    const commit = (el) => {
      // Studio drops the whole list once a place is taken, so the clicked row
      // is gone by the time a test could look at it: what was taken is recorded
      // on the body instead.
      document.body.setAttribute("data-taken", el.getAttribute("data-place"));
      document.querySelector('input[aria-label="Video location"]').value = el.getAttribute("data-place");
      places.innerHTML = "";
    };
    const render = (rows) => {
      if (document.body.hasAttribute("data-taken")) return;
      places.innerHTML = rows.map((r) =>
        '<tp-yt-paper-item data-opt="' + r.text + '" data-place="' + r.place + '">' + r.text + '</tp-yt-paper-item>'
      ).join("");
      for (const el of places.querySelectorAll("[data-opt]")) el.addEventListener("click", () => commit(el));
    };
    document.querySelector('input[aria-label="Video location"]').addEventListener("input", () => {
      // First the stale list, then the settled one — the re-render that used to
      // leave a marked row detached before it could be clicked.
      render([{ text: "Chennai Central", place: "Chennai Central" }]);
      setTimeout(() => render([
        { text: "Chennai, Tamil Nadu", place: "Chennai" },
        { text: "Chennai International Airport (MAA) Meenambakkam, Chennai, Tamil Nadu", place: "Chennai Airport" },
        { text: "Tamil Nadu Open University Saidapet, Chennai, Tamil Nadu", place: "TNOU" },
      ]), 1200);
    });
  </script>`;

test("the location is committed from a suggestion, not left as typed text", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<body>${LOCATION}</body>`);
  const { lines, log } = recorder();

  assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", log), true, lines.join(" | "));
  // The city, never a business or a campus that happens to sit inside it.
  assert.equal(
    await page.locator("body").getAttribute("data-taken"),
    "Chennai",
    "the city suggestion was not the one taken",
  );
  assert.equal(
    await page.locator('input[aria-label="Video location"]').inputValue(),
    "Chennai",
    "the field should hold the place Studio committed, not the typed text",
  );
  assert.ok(lines.some((l) => /verified "Chennai"/.test(l)), lines.join(" | "));
  await page.close();
});

test("typed Chennai is reselected from the exact suggestion instead of assumed committed", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<body>${LOCATION}</body>`);
  await page.locator('input[aria-label="Video location"]').evaluate((el) => ((el as HTMLInputElement).value = "Chennai"));
  const { lines, log } = recorder();

  assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", log), true, lines.join(" | "));
  assert.equal(await page.locator("body").getAttribute("data-taken"), "Chennai");
  await page.close();
});

test("nothing on offer leaves the field unset rather than claiming success", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<body>
    <div class="label">Video location</div>
    <input aria-label="Video location" />
  </body>`);
  const { lines, log } = recorder();

  assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", log), false);
  assert.ok(lines.some((l) => /nothing offered/.test(l)), lines.join(" | "));
  await page.close();
});

test("nearby place names cannot substitute for the exact Chennai, Tamil Nadu result", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<body>${LOCATION.replace('text: "Chennai, Tamil Nadu"', 'text: "Chennai Tamil Nadu"')}</body>`);
    assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", () => {}), false);
    assert.equal(await page.locator("body").getAttribute("data-taken"), null);
  } finally { await page.close(); }
});

test("Studio Polymer tp-yt-paper-item-body without a literal comma matches exact Chennai, Tamil Nadu and rejects Chennai Central", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<body>${LOCATION.replace(
        "'<tp-yt-paper-item data-opt=\"' + r.text + '\" data-place=\"' + r.place + '\">' + r.text + '</tp-yt-paper-item>'",
        "'<tp-yt-paper-item data-opt=\"' + r.text + '\" data-place=\"' + r.place + '\"><tp-yt-paper-item-body>' + r.text + '</tp-yt-paper-item-body></tp-yt-paper-item>'",
      ).replace('text: "Chennai, Tamil Nadu"', 'text: "Chennai Tamil Nadu"')}</body>`,
    );
    assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", () => {}), true);
    assert.equal(await page.locator("body").getAttribute("data-taken"), "Chennai");
  } finally { await page.close(); }
});

test("a clicked suggestion must remain committed after focus leaves the location field", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(detailsFixture());
    await page.locator("#location-input").evaluate(el => el.addEventListener("blur", () => { (el as HTMLInputElement).value = ""; }));
    assert.equal(await setVideoLocation(page, "Chennai, Tamil Nadu", () => {}), false);
  } finally { await page.close(); }
});

test("tags replace existing chips, verify exact values, and do not duplicate on draft recovery", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(detailsFixture("delayed-tags"));
    await setYouTubeTags(page, ["outdated tag"], () => {});
    await setYouTubeTags(page, fixtureTags, () => {});
    await setYouTubeTags(page, fixtureTags, () => {});
    assert.deepEqual(await page.locator("ytcp-chip #chip-text").allTextContents(), fixtureTags);
    assert.equal(await page.locator("#text-input").inputValue(), "");
  } finally { await page.close(); }
});

test("tag length includes quotes and separators; over-budget, duplicates and wrong chips stop safely", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(detailsFixture("tags"));
    for (const tags of [["x".repeat(500)], ["same", "same"], ["two words ".repeat(50)]]) {
      await assert.rejects(setYouTubeTags(page, tags, () => {}), /500-character limit/);
    }
    assert.equal(await page.locator("ytcp-chip").count(), 0, "invalid input never touched the field");
    await assert.rejects(setYouTubeTags(page, ["specific topic"], () => {}), /Committed tag chips differ/);
  } finally { await page.close(); }
});
