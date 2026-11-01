/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import { PublishError, UnknownOutcomeError, type PublishLog } from "../types";
import { humanClick } from "./actions";

/**
 * The end of the Studio upload: wait for the file to finish uploading, press
 * Publish, and read what YouTube says back.
 *
 * Until now this engine stopped before all three. It selected the file and
 * filled the form, then returned and left the dialog to a person - so "Publish"
 * in RepoReel never published anything, and nothing ever checked that the file
 * had arrived. The decisions are pure functions over the text Studio shows
 * (`readUploadState`, `readOutcome`, `watchUpload`) so they can be tested
 * without a browser; the functions that touch the page are thin readers around
 * them.
 */

const squash = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

/* ----------------------------------------------------------- video ids -- */

/** An 11-character video id, in any of the shapes YouTube prints one. */
export function videoIdFrom(text: string): string | null {
  const m =
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^"'\s]*&)?v=|shorts\/|live\/|embed\/)|studio\.youtube\.com\/video\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(
      text ?? "",
    );
  return m ? m[1] : null;
}

/* ------------------------------------------------------- upload state -- */

export type UploadPhase =
  | "unknown"
  | "uploading"
  /** Every byte is on YouTube's side; processing has not started. */
  | "uploaded"
  | "processing"
  | "checking"
  /** The copyright and ads checks have finished. */
  | "checked"
  | "failed";

export interface UploadState {
  phase: UploadPhase;
  /** 0-100 while uploading, when the page says. */
  percent: number | null;
  /** A problem Studio put in words: a failure, or an issue the checks found. */
  problem: string | null;
  text: string;
}

/**
 * Failures YouTube prints in the upload dialog. Deliberately specific: a loose
 * match on "error" or "failed" would read an ordinary sentence about "failed
 * checks" as the upload having died.
 */
const FAILED =
  /(upload (failed|declined|aborted|error)|couldn['’]?t upload|daily upload limit|upload limit (reached|exceeded)|processing (abandoned|failed|aborted)|(unsupported|invalid) (file|format)|file (is )?(too large|not supported|corrupt)|something went wrong|verify (your )?(identity|account|phone))/i;

/** Issues the checks found, as opposed to "No issues found". */
const CHECK_ISSUE =
  /(copyright (claim|issue|restriction)|content (id )?claim|found (\d+|an?|some) (issue|restriction|claim)|restrictions? (found|apply))/i;

/** The phrase that matched, with enough around it to read, so an error says what it saw. */
function around(text: string, at: number, length: number): string {
  return text.slice(Math.max(0, at - 60), Math.min(text.length, at + length + 100)).trim();
}

export function readUploadState(raw: string): UploadState {
  const text = squash(raw);
  const percent = /(\d{1,3})\s*%/.exec(text);
  const pct = percent ? Math.min(100, Number(percent[1])) : null;

  if (FAILED.test(text)) {
    return { phase: "failed", percent: pct, problem: text.slice(0, 240), text };
  }

  // "Uploading 45%" is positive evidence the bytes are still moving, and wins
  // over any other words in the footer: a line that also mentions processing
  // is describing what comes next, not what has happened.
  if (/uploading\s*\d{1,3}\s*%/i.test(text) || /\d{1,3}\s*%\s*uploaded/i.test(text)) {
    return { phase: "uploading", percent: pct, problem: null, text };
  }

  if (/checks? complete|finished checking|no issues found/i.test(text)) {
    const issue = CHECK_ISSUE.test(text) && !/no issues found/i.test(text);
    return { phase: "checked", percent: pct, problem: issue ? text.slice(0, 240) : null, text };
  }
  if (CHECK_ISSUE.test(text)) {
    return { phase: "checked", percent: pct, problem: text.slice(0, 240), text };
  }
  if (/checking|checks? (are )?(running|in progress)|checks will/i.test(text)) {
    return { phase: "checking", percent: pct, problem: null, text };
  }
  if (/processing|finished processing|hd (version )?(is )?(processing|ready)/i.test(text)) {
    return { phase: "processing", percent: pct, problem: null, text };
  }
  if (/upload(ing)?\s+complete|uploaded|finished uploading/i.test(text) && !/uploading\s+\d/i.test(text)) {
    return { phase: "uploaded", percent: 100, problem: null, text };
  }
  if (/uploading/i.test(text)) {
    return { phase: "uploading", percent: pct, problem: null, text };
  }
  return { phase: "unknown", percent: pct, problem: null, text };
}

export const READY_TO_PUBLISH: ReadonlySet<UploadPhase> = new Set(["uploaded", "processing", "checking", "checked"]);

export interface WatchDeps {
  /** The progress line Studio shows now. */
  read: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: PublishLog;
}

export interface WatchOptions {
  /** Longest to wait for the bytes to arrive. */
  uploadTimeoutMs: number;
  /** After the upload, how long to wait for the checks before going on without them. */
  checksGraceMs: number;
  pollMs: number;
}

export const WATCH_DEFAULTS: WatchOptions = {
  uploadTimeoutMs: 15 * 60_000,
  checksGraceMs: 4 * 60_000,
  pollMs: 3000,
};

export interface WatchResult {
  phase: UploadPhase;
  /** True when the checks reported back; false when the wait for them ran out. */
  checksFinished: boolean;
  /** An issue the checks found. The caller decides whether it stops the post. */
  issue: string | null;
}

/**
 * Wait until the file is on YouTube and, for a bounded while, until its checks
 * are done.
 *
 * Publishing early is allowed by Studio and is not safe: a copyright check that
 * finishes after the click can take a published video down, and one that finds
 * something before it shows a warning this engine must not click through. So
 * the checks are waited for - but only for a grace period, because they can
 * take longer than anyone should sit and watch, and a finished upload is worth
 * more than an unfinished verdict.
 *
 * A failure in the dialog ends the wait at once, and says what the dialog said.
 */
export async function watchUpload(deps: WatchDeps, opts: WatchOptions = WATCH_DEFAULTS): Promise<WatchResult> {
  const started = deps.now();
  let uploadedAt: number | null = null;
  let lastPhase: UploadPhase = "unknown";
  let lastPercentLogged = -10;
  let unknownSince: number | null = null;
  let lastUnknownText = "";

  for (;;) {
    const state = readUploadState(await deps.read());

    if (state.phase === "failed") {
      throw new PublishError(
        `YouTube could not take the upload: "${state.problem}". Nothing was published. Fix that in Studio, then post again.`,
        { retryable: false },
      );
    }

    if (state.phase !== lastPhase) {
      deps.log(
        state.phase === "uploading"
          ? `Uploading the video${state.percent !== null ? ` (${state.percent}%)` : ""}`
          : state.phase === "uploaded"
            ? "The video is uploaded; YouTube is starting to process it"
            : state.phase === "processing"
              ? "YouTube is processing the video"
              : state.phase === "checking"
                ? "YouTube is checking the video"
                : state.phase === "checked"
                  ? "YouTube has finished its checks"
                  : "Waiting for YouTube to report on the upload",
      );
      lastPhase = state.phase;
    }
    if (state.phase === "uploading" && state.percent !== null && state.percent - lastPercentLogged >= 10) {
      lastPercentLogged = state.percent;
      deps.log(`Uploading the video (${state.percent}%)`);
    }

    if (state.phase === "checked") {
      return { phase: "checked", checksFinished: true, issue: state.problem };
    }

    if (READY_TO_PUBLISH.has(state.phase)) {
      uploadedAt ??= deps.now();
      if (deps.now() - uploadedAt >= opts.checksGraceMs) {
        deps.log("YouTube's checks are still running; the upload itself is done");
        return { phase: state.phase, checksFinished: false, issue: null };
      }
    } else if (state.phase === "unknown") {
      // Nothing recognisable on screen. A dialog that has not drawn its footer
      // yet looks like this, so it is waited out - but not forever, and said so.
      unknownSince ??= deps.now();
      if (state.text && state.text !== lastUnknownText) {
        lastUnknownText = state.text;
        deps.log(`Studio's upload footer says: "${state.text.slice(0, 160)}"`);
      }
      if (deps.now() - unknownSince > 90_000) {
        throw new PublishError(
          `Studio's upload dialog never reported any progress${state.text ? ` (it says: "${state.text.slice(0, 120)}")` : ""}. ` +
            "The page may have changed. Nothing was published; look at the open window.",
          { retryable: false },
        );
      }
    } else {
      unknownSince = null;
    }

    if (deps.now() - started > opts.uploadTimeoutMs + (uploadedAt ? opts.checksGraceMs : 0)) {
      throw new PublishError(
        `The upload had not finished after ${Math.round(opts.uploadTimeoutMs / 60_000)} minutes (last state: ${state.phase}). Nothing was published.`,
        { retryable: false },
      );
    }

    await deps.sleep(opts.pollMs);
  }
}

/* ------------------------------------------------------------ outcome -- */

export type PublishOutcome = "published" | "failed" | "unknown";

export interface OutcomeReading {
  outcome: PublishOutcome;
  /** What the page said, when it is a failure. */
  problem: string | null;
  text: string;
}

const OUTCOME_FAILED =
  /((couldn['’]?t|could not|unable to|failed to|can['’]?t) (publish|save|upload|process)|publish(ing)? failed|something went wrong|try again later|an error (has )?occurred|daily upload limit|upload limit)/i;

const OUTCOME_PUBLISHED =
  /(video (is )?(published|saved|live|scheduled)|(is|has been|was) (now )?(published|saved|scheduled)|published to|scheduled (for|to publish|to go)|your video (is|has been) (now )?(public|private|unlisted|live|scheduled)|saved as (public|private|unlisted))/i;

/**
 * What the dialogs on screen after the click say.
 *
 * Failure is checked first: a dialog can contain a sentence about "saved
 * changes" in the same breath as saying the publish did not go through.
 */
export function readOutcome(raw: string): OutcomeReading {
  const text = squash(raw);
  const failed = OUTCOME_FAILED.exec(text);
  if (failed) return { outcome: "failed", problem: around(text, failed.index, failed[0].length), text };
  if (OUTCOME_PUBLISHED.test(text)) return { outcome: "published", problem: null, text };
  return { outcome: "unknown", problem: null, text };
}

/** What is on screen after (or just before) the click. */
export interface DialogSnapshot {
  /** The visible words of every dialog, minus the video's own. */
  text: string;
  links: string[];
  /** The upload dialog itself is still showing. */
  uploadsOpen: boolean;
  /** The "video published" share dialog is showing. */
  shareOpen: boolean;
}

export interface OutcomeDeps {
  read: () => Promise<DialogSnapshot>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: PublishLog;
}

export type ConfirmedBy =
  /** YouTube drew its share dialog, which only follows a publish. */
  | "share-dialog"
  /** The upload dialog that was open when the button was pressed has closed. */
  | "dialog-closed"
  /** A success sentence that was not on screen before the click. */
  | "new-words";

export interface Confirmed {
  videoId: string | null;
  by: ConfirmedBy;
  text: string;
}

export interface ConfirmOptions {
  timeoutMs: number;
  pollMs: number;
  /** What the dialogs said just before the button was pressed. */
  before: DialogSnapshot;
  /** The draft's id, which is the video's id: the answer when no link names another. */
  draftId: string | null;
}

/**
 * Wait for Studio to react to the click, and say so only when it has.
 *
 * What counts is a *change* after the button was pressed: the share dialog
 * appearing, the upload dialog that was open closing, or a success sentence that
 * was not already on screen. Not a sentence that was there all along - the
 * "Saved as private" badge in the dialog's header is showing before Publish is
 * ever pressed, and a video id is on screen from the moment the upload begins,
 * so neither proves the press did anything.
 *
 * This is the platform reacting, not yet the channel agreeing: the caller still
 * reads the video back from the channel before calling it published.
 */
export async function confirmPublished(deps: OutcomeDeps, opts: ConfirmOptions): Promise<Confirmed> {
  const started = deps.now();
  const alreadySaid = readOutcome(opts.before.text).outcome === "published";
  let last = "";

  for (;;) {
    const seen = await deps.read();
    const reading = readOutcome(seen.text);
    last = reading.text;

    if (reading.outcome === "failed") {
      throw new PublishError(
        `YouTube did not publish the video: "${reading.problem}". It may be sitting in Studio as a draft - check there before posting again.`,
        { retryable: false },
      );
    }

    const id = seen.links.map(videoIdFrom).find(Boolean) ?? videoIdFrom(seen.text) ?? opts.draftId;

    if (seen.shareOpen) return { videoId: id, by: "share-dialog", text: reading.text };
    if (opts.before.uploadsOpen && !seen.uploadsOpen) return { videoId: id, by: "dialog-closed", text: reading.text };
    if (reading.outcome === "published" && !alreadySaid) return { videoId: id, by: "new-words", text: reading.text };

    if (deps.now() - started > opts.timeoutMs) {
      throw new UnknownOutcomeError(
        `Publish was pressed, but YouTube's page had not changed after ${Math.round(opts.timeoutMs / 1000)} seconds` +
          `${last ? ` (the page says: "${last.slice(0, 120)}")` : ""}. It is not known whether it went out - check YouTube Studio before posting again.`,
      );
    }
    await deps.sleep(opts.pollMs);
  }
}

/** What Studio's own page for a video says about it. */
export interface ChannelView {
  visibility: string | null;
  title: string | null;
}

export interface ChannelVerdict {
  /** The channel itself says the video is out, with the visibility that was asked for. */
  published: boolean;
  /** Said to the operator: a mismatch, or a draft, or nothing readable. */
  problems: string[];
  /** The title and visibility could not be read at all. */
  unreadable: boolean;
}

/**
 * Whether the channel agrees the video is out.
 *
 * This is the definition of "published" for the browser engine: not a dialog
 * closing, which is YouTube reacting, but the video's own Studio page reporting
 * the visibility that was chosen and not "Draft". The title is compared too, but
 * a mismatch there is reported rather than undoing a video that is up.
 */
export function judgeChannelView(view: ChannelView | null, want: { privacy: string; title: string }): ChannelVerdict {
  if (!view || (!view.visibility && !view.title)) {
    return { published: false, problems: ["The video's Studio page could not be read, so it is not confirmed."], unreadable: true };
  }

  const problems: string[] = [];
  const shown = squash(view.visibility ?? "");
  let published = false;

  if (!shown) {
    problems.push("Studio's page for the video does not say what its visibility is.");
  } else if (/\bdraft\b/i.test(shown)) {
    problems.push(`Studio still lists the video as a draft ("${shown.slice(0, 60)}"), so it was not saved.`);
  } else if (new RegExp(`\\b${want.privacy}\\b`, "i").test(shown)) {
    published = true;
  } else {
    problems.push(`Studio shows the visibility as "${shown.slice(0, 60)}", not ${want.privacy}.`);
  }

  const wantTitle = squash(want.title).slice(0, 40).toLowerCase();
  if (published && view.title && !squash(view.title).toLowerCase().includes(wantTitle)) {
    problems.push(`Studio shows the title as "${squash(view.title).slice(0, 60)}", which is not the one that was approved.`);
  }

  return { published, problems, unreadable: false };
}

/* ------------------------------------------------------ page readers -- */

const DIALOG = "ytcp-uploads-dialog";

/**
 * Fields whose contents are the video's own words, and so never the platform's.
 *
 * A description that says "published to npm" or a title that says "something
 * went wrong" is not YouTube reporting on the upload, and read as if it were it
 * would end a post that was going fine - or, worse, call an unpublished video
 * published. Everything the operator typed is cut out before any dialog is read.
 */
const OWN_WORDS = "[contenteditable], textarea, input, #title-textarea, #description-textarea, #tags-container, ytcp-chip-bar";

/*
 * What is *visible* in a dialog, with the video's own words hidden while it is
 * read. Written inline in each reader below rather than shared: a helper declared
 * inside a page.evaluate body is rewritten into a call the page cannot resolve.
 *
 * Visible is the point. Studio keeps error templates mounted and hidden inside
 * its dialogs - an "Oops, something went wrong. Retry" sits in the upload dialog
 * the whole time - and `textContent`, which is what a detached clone gives, reads
 * them as if they were showing. The first real post was failed on exactly that
 * sentence a moment after Save had gone through. `innerText` only reads what is
 * on screen, and it needs the element live, so the operator's own fields are
 * hidden for the length of one synchronous read and put back before the page can
 * paint.
 */

/** The progress line in the dialog's footer, falling back to the dialog without the video's own words. */
export async function readProgress(page: Page): Promise<string> {
  return page
    .evaluate(
      ({ dialog, own }) => {
        const bar = document.querySelector("ytcp-video-upload-progress") as HTMLElement | null;
        const text = bar ? bar.innerText || "" : "";
        if (text.trim()) return text;
        const d = document.querySelector(dialog) as HTMLElement | null;
        if (!d) return "";
        const hidden: [HTMLElement, string][] = [];
        for (const n of d.querySelectorAll(own)) {
          hidden.push([n as HTMLElement, (n as HTMLElement).style.display]);
          (n as HTMLElement).style.display = "none";
        }
        const read = d.innerText || "";
        for (const [n, was] of hidden) n.style.display = was;
        return read;
      },
      { dialog: DIALOG, own: OWN_WORDS },
    )
    .then(squash)
    .catch(() => "");
}

/**
 * The upload dialog alone, without the video's own words. Refusals - the daily
 * limit, a file Studio will not take - are printed inside it, so reading it
 * alone is enough, and reading every dialog on the page is not safe: Studio keeps
 * others mounted whose wording has nothing to do with this upload.
 */
export async function readUploadsDialog(page: Page): Promise<string> {
  return page
    .evaluate(
      ({ dialog, own }) => {
        const d = document.querySelector(dialog) as HTMLElement | null;
        if (!d) return "";
        const hidden: [HTMLElement, string][] = [];
        for (const n of d.querySelectorAll(own)) {
          hidden.push([n as HTMLElement, (n as HTMLElement).style.display]);
          (n as HTMLElement).style.display = "none";
        }
        const read = d.innerText || "";
        for (const [n, was] of hidden) n.style.display = was;
        return read;
      },
      { dialog: DIALOG, own: OWN_WORDS },
    )
    .then(squash)
    .catch(() => "");
}

/** Every dialog that is open now, minus the video's own words: what YouTube says, and the links in it. */
export async function readDialogs(page: Page): Promise<DialogSnapshot> {
  return page
    .evaluate((own) => {
      const nodes = [
        ...document.querySelectorAll(
          "ytcp-video-share-dialog, ytcp-uploads-dialog, ytcp-uploads-still-processing-dialog, ytcp-prechecks-warning-dialog, tp-yt-paper-dialog, ytcp-dialog",
        ),
      ].filter((n) => (n as HTMLElement).offsetParent !== null || (n as HTMLElement).getClientRects().length > 0);
      const parts: string[] = [];
      for (const n of nodes) {
        const el = n as HTMLElement;
        const hidden: [HTMLElement, string][] = [];
        for (const f of el.querySelectorAll(own)) {
          hidden.push([f as HTMLElement, (f as HTMLElement).style.display]);
          (f as HTMLElement).style.display = "none";
        }
        parts.push(el.innerText || "");
        for (const [f, was] of hidden) f.style.display = was;
      }
      return {
        text: parts.join(" | "),
        links: nodes.flatMap((n) => [...n.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href)),
        uploadsOpen: nodes.some((n) => n.tagName.toLowerCase() === "ytcp-uploads-dialog"),
        shareOpen: nodes.some((n) => n.tagName.toLowerCase() === "ytcp-video-share-dialog"),
      };
    }, OWN_WORDS)
    .then((r): DialogSnapshot => ({ text: squash(r.text), links: r.links, uploadsOpen: r.uploadsOpen, shareOpen: r.shareOpen }))
    .catch((): DialogSnapshot => ({ text: "", links: [], uploadsOpen: false, shareOpen: false }));
}

/** The id of the video this dialog is uploading, read as soon as Studio shows its link. */
export async function readDraftId(page: Page): Promise<string | null> {
  const seen = await readDialogs(page);
  return seen.links.map(videoIdFrom).find(Boolean) ?? videoIdFrom(seen.text);
}

/** Wait for the file to arrive, reporting as it does. */
export function waitForUpload(page: Page, log: PublishLog, opts: WatchOptions = WATCH_DEFAULTS): Promise<WatchResult> {
  return watchUpload(
    {
      read: () => readProgress(page),
      sleep: (ms) => page.waitForTimeout(ms),
      now: Date.now,
      log,
    },
    opts,
  );
}

const DONE = "#done-button, ytcp-button#done-button";

/** Whether the Publish button can be pressed. Read from the page, not assumed. */
async function doneButton(page: Page): Promise<{ present: boolean; enabled: boolean; label: string }> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { present: false, enabled: false, label: "" };
      const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
      return { present: true, enabled: !disabled, label: (el.innerText || el.textContent || "").trim() };
    }, DONE)
    .catch(() => ({ present: false, enabled: false, label: "" }));
}

/**
 * Press Publish - or Save, which is what the same button says for a private
 * video - once it is enabled, and return what it said.
 *
 * Waits for the button rather than the clock: Studio keeps it disabled while it
 * cannot accept the click, and clicking a disabled one does nothing and looks
 * exactly like having worked.
 */
export async function pressPublish(page: Page, log: PublishLog, opts: { expectLabel?: RegExp } = {}): Promise<string> {
  const deadline = Date.now() + 90_000;
  let state = await doneButton(page);
  while (!(state.present && state.enabled) && Date.now() < deadline) {
    await page.waitForTimeout(1500);
    state = await doneButton(page);
  }

  // The same button says Publish, Save or Schedule depending on what was chosen
  // above it. When the caller knows which one it means to press, a different word
  // is a page that did not take the choice - and pressing "Publish" where
  // "Schedule" was meant puts the video on the channel immediately. So the label is
  // given a few seconds to settle, and then it is either right or nothing is pressed.
  if (opts.expectLabel && state.present && !opts.expectLabel.test(state.label)) {
    const settle = Date.now() + 8_000;
    while (!opts.expectLabel.test(state.label) && Date.now() < settle) {
      await page.waitForTimeout(800);
      state = await doneButton(page);
    }
    if (!opts.expectLabel.test(state.label)) {
      throw new PublishError(
        `The final button says "${state.label || "nothing"}", not what this step needs (${opts.expectLabel.source}), so it was not pressed and nothing was published or scheduled. ` +
          "The upload is in Studio as a draft; look at the open window.",
        { retryable: false },
      );
    }
  }

  if (!state.present) {
    throw new PublishError(
      "The Publish button is not on the page, so nothing was published. The upload is in Studio as a draft; look at the open window.",
      { retryable: false },
    );
  }
  if (!state.enabled) {
    throw new PublishError(
      "YouTube kept the Publish button disabled for 90 seconds, so nothing was published. The upload is in Studio as a draft; look at the open window.",
      { retryable: false },
    );
  }

  log(`Pressing ${state.label || "Publish"}`);
  await humanClick(page, DONE);
  return state.label;
}

/**
 * Wait for Studio to react to the click. `before` is read by the caller just
 * ahead of pressing the button, so a sentence that was already on screen cannot
 * pass for the press having worked.
 */
export function waitForConfirmation(page: Page, log: PublishLog, before: DialogSnapshot, draftId: string | null): Promise<Confirmed> {
  return confirmPublished(
    {
      read: () => readDialogs(page),
      sleep: (ms) => page.waitForTimeout(ms),
      now: Date.now,
      log,
    },
    { timeoutMs: 3 * 60_000, pollMs: 1000, before, draftId },
  );
}

/**
 * Open the video's own Studio page and read what is saved on the server side.
 *
 * The confirmation dialog is YouTube answering the click; this is asking the
 * channel afterwards, which also catches a title that was truncated or a
 * visibility that did not take. Best effort - a page that will not load is a
 * reason to say "could not re-check", not to fail a video that is already up.
 */
export async function readFromChannel(page: Page, videoId: string): Promise<ChannelView | null> {
  try {
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#title-textarea #textbox, ytcp-video-metadata-editor", { timeout: 45_000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
      const title = document.querySelector("#title-textarea #textbox") as HTMLElement | null;
      const vis = document.querySelector(
        "ytcp-video-metadata-visibility, ytcp-video-metadata-editor-sidepanel .visibility, #visibility-text, [id*='visibility'] .label",
      ) as HTMLElement | null;
      const all = (document.body.innerText || "").replace(/\s+/g, " ");
      const m = /\b(Private|Unlisted|Public|Scheduled)\b/.exec(all);
      return {
        title: title ? (title.innerText || "").replace(/\s+/g, " ").trim() : null,
        visibility: vis ? (vis.innerText || "").replace(/\s+/g, " ").trim() : m ? m[1] : null,
      };
    });
  } catch {
    return null;
  }
}
