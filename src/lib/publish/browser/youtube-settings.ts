/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import type { PublishLog } from "../types";
import { normaliseTags } from "../limits";
import { tagsLength } from "../youtube/publisher";

/**
 * Four settings on YouTube Studio's Details screen: the AI-use answer, the
 * video language, the recording location and the category.
 *
 * None of them can be addressed by a stable selector. Studio renames its ids
 * between redesigns — `#create-icon` on the dashboard is already gone — and
 * these controls are anonymous and repeated: the screen carries a dozen
 * `tp-yt-paper-radio-button`s and a column of identical dropdown triggers, none
 * of which say what they are for. Picking by index would set whichever control
 * Studio happened to render first that morning, which is a different setting on
 * a different day.
 *
 * So each one is found from the text a person reads next to it, and then marked
 * with an attribute so Playwright and the page agree on which element is meant.
 * Marking rather than counting matters because Studio nests its triggers —
 * every dropdown matches the selector twice, once outside and once inside — so
 * an index into "all the triggers" points at a different control depending on
 * how deep the match was.
 *
 * Two facts about this account's Studio are written into the matching rather
 * than assumed away: it renders in en-GB, where the category reads "Science and
 * technology" and not "Science & Technology", and its location field replaces
 * what was typed with the place's own short name once a suggestion is taken.
 * Both are the same setting under a different spelling, so comparisons here
 * normalise "&" to "and" and accept a committed place by the suggestion it came
 * from.
 *
 * Each setting reports its verified state. The upload orchestrator refuses to
 * advance or press a final button when any required setting cannot be verified.
 */

const RADIO = 'tp-yt-paper-radio-button, [role="radio"]';
const TRIGGER = "ytcp-text-dropdown-trigger, ytcp-dropdown-trigger";
const ITEM = 'tp-yt-paper-item, ytcp-menu-item, [role="option"]';
const SHOW_MORE =
  '#toggle-button, ytcp-button#toggle-button, [aria-label="Show advanced settings"], ytcp-button:has-text("Show more")';

/** The attribute the page and Playwright meet on. */
const MARK = "data-bookreel-target";
const MARKED = `[${MARK}]`;

/** Collapse whitespace: read a label the way a person does, not the way the DOM stores it. */
const flat = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** "Science & Technology" and "Science and technology" are one category. */
const norm = (s: string | null | undefined) => flat(s).toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Language, location, category and the AI-use question all live behind "Show
 * more" and are simply absent until it is expanded. The tags step usually opens
 * it first, so this is normally a no-op — but it must not depend on that,
 * because the tags step gives up early when a video has no tags.
 */
async function openAdvanced(page: Page, log: PublishLog): Promise<boolean> {
  const open = async () =>
    page
      .evaluate(
        () =>
          [...document.querySelectorAll(
            "#category-container, #language-container, ytcp-video-metadata-editor-advanced:not([hidden])",
          )].some(node => !!(node as HTMLElement).offsetWidth && !!(node as HTMLElement).offsetHeight) || /show less|show fewer/i.test(document.body.innerText),
      )
      .catch(() => false);

  if (await open()) {
    log("Settings: the advanced panel is already open");
    return true;
  }

  const toggle = page.locator(SHOW_MORE).first();
  if ((await toggle.count().catch(() => 0)) === 0) {
    log("Settings: no Show more control on this screen");
    return false;
  }

  // Playwright's scroll, not the wheel: the toggle sits below the fold and a
  // wheel event cannot move Studio's dialog.
  await toggle.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
  await toggle.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const ok = await open();
  log(ok ? "Settings: advanced panel open" : "Settings: advanced panel would not open");
  return ok;
}

/**
 * Mark the one control that belongs to `label`, and say whether there was one.
 *
 * Nested matches are dropped first, so "the controls on this page" means what a
 * person would count. From the label's own element the search walks outwards to
 * the first ancestor that contains any control at all, and takes the one
 * nearest the label in reading order — which is the control the label names.
 */
async function markControl(page: Page, kind: string, label: string): Promise<boolean> {
  return page
    .evaluate(
      ({ kind, label, mark }) => {
        for (const stale of document.querySelectorAll(`[${mark}]`)) stale.removeAttribute(mark);

        // Outermost matches only: Studio wraps each dropdown in a second
        // element that matches the same selector.
        const all = [...document.querySelectorAll(kind)].filter(
          (el, _i, list) => !list.some((other) => other !== el && other.contains(el)),
        );
        if (!all.length) return false;

        const re = new RegExp(`^${label}$`, "i");
        const leaves = [...document.querySelectorAll("div,span,label,h2,h3,p")].filter(
          (el) => el.children.length === 0 && re.test((el.textContent ?? "").replace(/\s+/g, " ").trim()),
        );

        for (const leaf of leaves) {
          let node: Element | null = leaf.parentElement;
          for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
            const near = all.filter((c) => node!.contains(c));
            if (!near.length) continue;

            // The label describes what follows it; fall back to what precedes
            // it for the layouts that put the label inside the control.
            const after = near.find(
              (c) => leaf.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING || c.contains(leaf),
            );
            const chosen = after ?? near[near.length - 1];
            chosen.setAttribute(mark, "yes");
            return true;
          }
        }
        return false;
      },
      { kind, label: escapeRe(label), mark: MARK },
    )
    .catch(() => false);
}

/**
 * Read the open list, choose from it and mark the choice — all in one pass on
 * the page.
 *
 * One pass because these lists will not hold still between two. Studio's
 * language menu renders its items a moment after the menu opens, so a list read
 * on arrival is empty and the same read half a second later is complete; the
 * location suggestions go the other way and re-render as the autocomplete
 * settles. Reading in one call and marking in another therefore chose from a
 * list that no longer existed, which is what "no option reading English" meant
 * while English was plainly on the screen.
 *
 * The caller polls this: an empty list is a list that has not arrived yet.
 */
interface Pick {
  offered: string[];
  chosen: string | null;
}

async function pickOption(
  page: Page,
  rule: { mode: "exact"; wanted: string },
): Promise<Pick> {
  // Nothing in here may declare a named function. The transpiler rewrites
  // `const norm = (s) => …` into a call to its own `__name` helper, which does
  // not exist in the page, so the whole callback dies with a ReferenceError
  // that `.catch` then turns into "no options" — an invisible failure that
  // reported English missing from a list English was sitting in. Everything is
  // therefore inlined, and `key` carries the normalised text.
  return page
    .evaluate(
      ({ item, rule, mark }) => {
        const wanted = rule.wanted.replace(/\s+/g, " ").trim().toLowerCase().replace(/&/g, "and");
        const wantedNoComma = wanted.replace(/,/g, "").replace(/\s+/g, " ").trim();
        const rows = [...document.querySelectorAll(item)]
          .filter((el, _i, list) => !list.some((other) => other !== el && other.contains(el)))
          .filter((el) => !!((el as HTMLElement).offsetParent || el.getClientRects().length))
          .map((el) => {
            const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            const hasBody = !!el.querySelector("tp-yt-paper-item-body");
            return { el, text, key: text.toLowerCase().replace(/&/g, "and"), hasBody };
          })
          .filter((r) => r.text.length > 0 && r.text.length < 140);

        const winner = rows.find((r) => r.key === wanted || (r.hasBody && r.key === wantedNoComma));

        if (winner) {
          for (const stale of document.querySelectorAll(`[${mark}-option]`)) stale.removeAttribute(`${mark}-option`);
          winner.el.setAttribute(`${mark}-option`, "yes");
        }
        return { offered: rows.map((r) => r.text).slice(0, 40), chosen: winner?.text ?? null };
      },
      { item: ITEM, rule, mark: MARK },
    )
    .catch(() => ({ offered: [], chosen: null }) as Pick);
}

/** Choose and click, giving the list time to arrive and one go at re-marking if it moves. */
async function takeOption(
  page: Page,
  rule: { mode: "exact"; wanted: string },
): Promise<Pick & { clicked: boolean }> {
  let pick: Pick = { offered: [], chosen: null };

  for (let attempt = 0; attempt < 12 && !pick.chosen; attempt++) {
    pick = await pickOption(page, rule);
    if (!pick.chosen) await page.waitForTimeout(600);
  }
  if (!pick.chosen) return { ...pick, clicked: false };

  for (let attempt = 0; attempt < 2; attempt++) {
    const option = page.locator(`[${MARK}-option]`).first();
    await option.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const clicked = await option
      .click({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return { ...pick, clicked: true };
    // The row was replaced between marking it and clicking it; mark the
    // replacement once, then give up rather than fight the page.
    pick = await pickOption(page, rule);
    if (!pick.chosen) break;
  }
  return { ...pick, clicked: false };
}

/**
 * Open one of Studio's dropdowns and pick an option by its exact text.
 *
 * Exact, because these lists are full of near misses: "English" sits among
 * "English (India)", "English (UK)" and a dozen more, and a substring match
 * would take whichever came first.
 */
async function chooseFromDropdown(
  page: Page,
  what: string,
  label: string,
  wanted: string,
  log: PublishLog,
): Promise<boolean> {
  if (!(await markControl(page, TRIGGER, label))) {
    log(`${what}: no "${label}" dropdown on this screen`);
    return false;
  }

  const trigger = page.locator(MARKED).first();
  // The trigger shows its own label above the value, so the label comes off
  // before asking what the value is. Leaving it on was why a correctly set
  // language still read back as wrong.
  const strip = new RegExp(`^\\s*${escapeRe(label)}\\s*`, "i");
  const value = async () => flat((await trigger.innerText().catch(() => "")).replace(strip, ""));

  const before = await value();
  if (norm(before) === norm(wanted)) {
    log(`${what}: already "${before}" — not touching it`);
    return true;
  }

  log(`${what}: selecting "${wanted}" (it currently reads "${before || "nothing"}")`);
  await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
  await trigger.click({ timeout: 15_000 });

  const taken = await takeOption(page, { mode: "exact", wanted });
  if (!taken.clicked) {
    const near = taken.offered.filter((o) => norm(o).includes(norm(wanted).split(" ")[0])).slice(0, 8);
    log(
      taken.chosen
        ? `${what}: "${wanted}" was on the list but would not click`
        : `${what}: no option reading "${wanted}" — ${
            near.length ? `nearest: ${near.join(" | ")}` : `${taken.offered.length} options offered`
          }`,
    );
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await page.waitForTimeout(1500);

  const after = await value();
  const ok = norm(after) === norm(wanted);
  log(ok ? `${what}: verified "${after}"` : `${what}: verification FAILED — it reads "${after || "nothing"}"`);
  return ok;
}

/**
 * Answer the AI-use question with Yes.
 *
 * Three rules, and each one is here because dropping it picked a different
 * setting. The AI question's radios say exactly "Yes" and "No" and nothing else,
 * while every other Yes/No pair on this screen spells its answer out — "Yes,
 * it's Made for Kids", "Yes, my video includes paid promotion" — so a bare
 * "Yes" is the only candidate worth considering. The section is then confirmed
 * by its own text, close by: searching eight ancestors up reaches a node that
 * holds the whole form, whose text mentions AI because the AI section is
 * somewhere inside it, and the first bare-ish "Yes" in the form got the click.
 * That is how a run meant to set AI use flipped Made for Kids to Yes instead.
 * And the section must hold this pair alone — two radios, no more — which is
 * what a single question looks like.
 */
export async function setAiUse(page: Page, log: PublishLog): Promise<boolean> {
  try {
    const found = await page
      .evaluate(
        ({ radio, mark }) => {
          for (const stale of document.querySelectorAll(`[${mark}]`)) stale.removeAttribute(mark);

          const all = [...document.querySelectorAll(radio)].filter(
            (el, _i, list) => !list.some((other) => other !== el && other.contains(el)),
          );
          // Bare "Yes": every unrelated question on this screen answers in a
          // sentence. Written inline because a named helper here would be
          // rewritten into a `__name` call the page cannot resolve.
          const yes = all.filter((r) => /^yes$/i.test((r.textContent ?? "").replace(/\s+/g, " ").trim()));

          for (const candidate of yes) {
            let node: Element | null = candidate.parentElement;
            for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              const pair = all.filter((r) => node!.contains(r));
              // A section, not the form: its text is one question long and it
              // holds this question's two answers only.
              if (pair.length > 2 || text.length > 600) break;
              if (/\bai\b|altered or synthetic|altered content|synthetic content/i.test(text)) {
                candidate.setAttribute(mark, "yes");
                return true;
              }
            }
          }
          return false;
        },
        { radio: RADIO, mark: MARK },
      )
      .catch(() => false);

    if (!found) {
      log("AI use: no Yes/No question about AI on this screen — leaving it alone");
      return false;
    }

    const yes = page.locator(MARKED).first();
    const checked = async () =>
      (await yes.getAttribute("aria-checked").catch(() => null)) === "true" ||
      (await yes
        .evaluate((el) => el.hasAttribute("checked") || el.classList.contains("checked"))
        .catch(() => false));

    log(`AI use: the question reads "${flat(await yes.innerText().catch(() => ""))}"`);
    if (await checked()) {
      log('AI use: already "Yes" — not touching it');
      return true;
    }

    log('AI use: selecting "Yes"');
    await yes.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await yes.click({ timeout: 15_000 });
    await page.waitForTimeout(1200);

    const ok = await checked();
    log(ok ? 'AI use: verified "Yes"' : "AI use: verification FAILED — Yes did not take");
    return ok;
  } catch (err) {
    log(`AI use: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export async function setVideoLanguage(page: Page, wanted: string, log: PublishLog): Promise<boolean> {
  try {
    return await chooseFromDropdown(page, "Video language", "Video language", wanted, log);
  } catch (err) {
    log(`Video language: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export async function setCategory(page: Page, wanted: string, log: PublishLog): Promise<boolean> {
  try {
    return await chooseFromDropdown(page, "Category", "Category", wanted, log);
  } catch (err) {
    log(`Category: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/**
 * Set the recording location from Studio's own suggestions.
 *
 * Typing is not choosing: the field holds free text until a suggestion is
 * taken, and an uncommitted one is dropped when the field loses focus. Once one
 * is taken, Studio rewrites the field to the place's own short name — the city
 * offered as "Chennai · Tamil Nadu" is stored as "Chennai" — so a committed
 * location is recognised by the suggestion it came from rather than by the
 * words that were typed.
 */
export async function setVideoLocation(page: Page, wanted: string, log: PublishLog): Promise<boolean> {
  try {
    const direct =
      'input#location-input, ytcp-form-location input, input[aria-label*="location" i], input[placeholder*="location" i]';
    let field = page.locator(direct).first();

    if ((await field.count().catch(() => 0)) === 0) {
      if (!(await markControl(page, "input", "Video location"))) {
        log("Video location: no location field on this screen");
        return false;
      }
      field = page.locator(MARKED).first();
    }

    const city = wanted.split(",")[0].trim();

    log(`Video location: searching for "${wanted}"`);
    await field.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await field.click({ timeout: 15_000 });
    await field.fill("", { timeout: 10_000 });
    // Typed rather than filled: the autocomplete listens for keystrokes, and a
    // value set in one go raises no input events at all.
    await field.pressSequentially(city, { timeout: 10_000 });

    const taken = await takeOption(page, { mode: "exact", wanted });
    const named = taken.offered.filter((t) => norm(t).includes(norm(city))).slice(0, 6);
    log(`Video location: suggestions offered: ${named.length ? named.join(" | ") : `(none named ${wanted})`}`);

    if (!taken.chosen) {
      log(`Video location: nothing offered for "${wanted}" — leaving the field unset`);
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
    if (!taken.clicked) {
      log(`Video location: "${taken.chosen}" was offered but would not click`);
      return false;
    }
    log(`Video location: took "${taken.chosen}"`);
    await page.waitForTimeout(2000);

    // Committed, not typed: the field now holds the place's own name, which is
    // how the chosen suggestion begins. Typed text would still read in full.
    const menuClosed = await page.locator(ITEM).filter({ hasText: taken.chosen }).evaluateAll(nodes => nodes.every(node => !(node as HTMLElement).offsetWidth || !(node as HTMLElement).offsetHeight));
    await field.press("Tab", { timeout: 5_000 });
    await page.waitForTimeout(300);
    const after = flat(await field.inputValue({ timeout: 5_000 }).catch(() => ""));
    const ok = menuClosed && (norm(after) === norm(city) || norm(after) === norm(wanted) || norm(after) === norm(taken.chosen));
    log(
      ok
        ? `Video location: verified "${after}" — taken from the suggestion "${taken.chosen}"`
        : `Video location: verification FAILED — the field reads "${after || "nothing"}" and no suggestion was committed`,
    );
    return ok;
  } catch (err) {
    log(`Video location: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/**
 * Close a video preview that has opened over the form.
 *
 * A single key sent to the page instead of a field can play Studio's preview and
 * send it fullscreen - its shortcuts are "f" for fullscreen, space to play, and the
 * tag text is full of both. A fullscreen player then covers the Details fields, so
 * every click lands on it and times out, the required answers never get set, and the
 * upload cannot go on. This exits fullscreen and pauses any playing video so the form
 * is usable again, and does nothing when nothing is playing. Returns whether it acted.
 */
export async function closePreviewPlayer(page: Page, log: PublishLog): Promise<boolean> {
  const acted = await page
    .evaluate(() => {
      let did = false;
      if (document.fullscreenElement) {
        try {
          void document.exitFullscreen();
        } catch {
          /* best effort */
        }
        did = true;
      }
      for (const v of Array.from(document.querySelectorAll("video"))) {
        const video = v as HTMLVideoElement;
        if (!video.paused) {
          try {
            video.pause();
          } catch {
            /* best effort */
          }
          did = true;
        }
      }
      return did;
    })
    .catch(() => false);
  if (acted) {
    // Escape is what a person presses to leave a player's fullscreen; it needs no gesture.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    log("Closed a video preview that had opened over the form");
  }
  return acted;
}

/** Replace draft tags, then read individual committed chips, never substring matches. */
export async function setYouTubeTags(page: Page, tags: string[], log: PublishLog): Promise<void> {
  const budget = Math.max(tagsLength(tags), tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 3 : 1), 0));
  if (!tags.length || tags.length > 40 || normaliseTags(tags).length !== tags.length || budget > 500 || tags.some(t => /[,#\r\n]/.test(t))) {
    throw new Error("YouTube tags are empty, duplicated, invalid, or exceed the 500-character limit. Review the tags.");
  }
  const box = page.locator("#tags-container, ytcp-chip-bar").first();
  const input = box.locator("#text-input, input").first();
  const chips = box.locator('ytcp-chip, [role="listitem"]');
  const read = () => chips.evaluateAll(nodes => nodes.map(node => (node.querySelector("#chip-text, .chip-text, #text")?.textContent ?? node.textContent ?? "").trim()));
  const verifiedWithin = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 4_000;
    do { if (await check()) return true; await page.waitForTimeout(100); } while (Date.now() < deadline);
    return false;
  };
  try {
    await input.waitFor({ state: "visible", timeout: 10_000 });
    if (JSON.stringify(await read()) !== JSON.stringify(tags)) {
      // A retry replaces existing chips instead of duplicating them.
      for (let i = 0; await chips.count(); i++) {
        if (i >= 40) throw new Error("Too many existing tag chips to clear safely");
        const before = await chips.count();
        await chips.first().locator('#delete-icon, [aria-label*="Remove" i], [aria-label*="Delete" i]').first().click({ timeout: 5_000 });
        if (!await verifiedWithin(async () => await chips.count() < before)) throw new Error("An existing tag chip could not be removed");
      }
      await input.fill("", { timeout: 5_000 });
      for (const [index, tag] of tags.entries()) {
        await input.fill(tag, { timeout: 5_000 });
        await input.press("Enter", { timeout: 5_000 });
        if (!await verifiedWithin(async () => JSON.stringify(await read()) === JSON.stringify(tags.slice(0, index + 1)))) throw new Error("Committed tag chips differ from the generated tags");
      }
    }
    await input.press("Tab", { timeout: 5_000 });
    if (!await verifiedWithin(async () => JSON.stringify(await read()) === JSON.stringify(tags)) || (await input.inputValue({ timeout: 5_000 })).trim()) {
      throw new Error("Committed tag chips differ from the generated tags");
    }
    log(`Tags verified: ${tags.length} exact committed chips, ${budget}/500 characters${budget < 480 ? "; below the 480 target, no filler added" : ""}`);
  } catch (error) {
    throw new Error(`YouTube Tags could not be verified: ${error instanceof Error ? error.message : String(error)}. Review the saved draft before retrying.`);
  }
}

export interface VideoSettings {
  aiUse: boolean;
  language: boolean;
  location: boolean;
  category: boolean;
}

/**
 * Apply the requested advanced settings and report each readback. The caller
 * must stop the upload workflow if any required setting is unverified.
 *
 * The panel is expanded first and for all four, including the AI-use question:
 * on this Studio that question is not in the DOM at all until "Show more" is
 * open, and looking for it beforehand found nothing and said so.
 */
export async function applyVideoSettings(
  page: Page,
  opts: { language: string; location: string; category: string; aiDisclosure?: boolean },
  log: PublishLog,
): Promise<VideoSettings> {
  // A stray keystroke earlier can leave Studio's preview playing or fullscreen over the
  // form; a fullscreen player covers every field and each click below times out. Clear it first.
  await closePreviewPlayer(page, log);
  await openAdvanced(page, log);
  const aiUse = opts.aiDisclosure ? await setAiUse(page, log) : false;
  const language = opts.language ? await setVideoLanguage(page, opts.language, log) : false;
  const location = opts.location ? await setVideoLocation(page, opts.location, log) : false;
  const category = opts.category ? await setCategory(page, opts.category, log) : false;
  return { aiUse, language, location, category };
}
