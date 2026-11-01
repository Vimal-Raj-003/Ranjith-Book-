/**
 * The Instagram account connection: what was SEEN on Instagram's own pages, and
 * the one state word that follows from it.
 *
 * PURE, and importing nothing but `./connect` (itself import-free): a client
 * component loads this, so it must never reach Prisma, Playwright or `node:`.
 * `tests/instagram-connection.test.mts` holds it to that.
 *
 * WHAT A "CONNECTION" IS HERE. BookReel never holds an Instagram password, token
 * or cookie. The login lives in a dedicated Chrome profile on this computer, put
 * there by the person signing in by hand (`browser/signin.ts`). So "connected"
 * cannot mean "we hold a credential" -- it means "the last time BookReel looked
 * through that profile, Instagram's own page said this account was signed in".
 * This file is that last look, as facts, and the rules that turn it into a state.
 *
 * THE FOUR STATES, and what earns each:
 *  - not_connected   no look yet, or the look found Instagram signed out, behind a
 *                    security check, unreadable, or signed in as the WRONG account.
 *  - connected       the right account is signed in. Scheduling is not yet known.
 *  - eligible        Instagram's composer actually showed "Schedule content".
 *  - not_eligible    the right account is signed in but cannot schedule: the
 *                    composer had no such option, or the account is personal.
 *
 * ELIGIBILITY IS PROVEN BY THE COMPOSER, NOT GUESSED. The account-type reading is
 * a text heuristic on Instagram's settings page and is only ever allowed to say
 * "no" when it positively reads "Switch to professional account"; the only thing
 * that can say "yes" is the composer showing the row.
 */
import { displayHandle, judgeIdentity, normaliseHandle, type IdentityVerdict } from "./connect";

export const INSTAGRAM_CONNECTION_STATES = ["not_connected", "connected", "eligible", "not_eligible"] as const;
export type InstagramConnectionState = (typeof INSTAGRAM_CONNECTION_STATES)[number];

/** What Instagram's settings page says the account is. `unknown` is the honest default. */
export type AccountKind = "professional" | "personal" | "unknown";

/** Could the account's own scheduled-content calendar (`/scheduled_content/`) be read? */
export type CalendarCheck = "readable" | "unreadable" | "not_checked";

/**
 * What Instagram's New-reel composer showed on its last screen.
 *  - offers_schedule      a "Schedule content" row with its switch was on screen.
 *  - no_schedule_option   the last screen was reached and the row was NOT there.
 *  - unreachable          the last screen was not reached, so nothing can be said.
 *  - not_checked          the composer was never opened.
 */
export type ComposerCheck = "offers_schedule" | "no_schedule_option" | "unreachable" | "not_checked";

/** One look at Instagram, as stored. Facts only: no cookie, token, password or profile path. */
export interface InstagramVerification {
  v: 1;
  /** ISO. When the account facts were read. */
  checkedAt: string;
  /** Instagram's signed-in app shell was on screen. */
  signedIn: boolean;
  /** The handle Instagram's own page showed, lower-case, no `@`. Null when none was read. */
  handle: string | null;
  /** The handle this install publishes to, `@between_pages`. */
  expected: string;
  identity: IdentityVerdict;
  /** The numeric id Instagram's calendar response named for the account; a public identifier, not a secret. */
  igUserId: string | null;
  accountKind: AccountKind;
  calendar: CalendarCheck;
  /** How many posts the account already has scheduled, when the calendar could be read. */
  scheduledCount: number | null;
  composer: ComposerCheck;
  /** ISO. When the composer was last looked at; null if never. */
  composerCheckedAt: string | null;
  /** One sentence for the person when something is not as needed. */
  reason: string | null;
}

export interface Derived {
  state: InstagramConnectionState;
  reason: string | null;
  /** The facts are older than `STALE_AFTER_MS`: still shown, but worth looking at again. */
  stale: boolean;
}

/** A week. Sessions expire and accounts change type; an old "eligible" should be re-confirmed. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const NOT_YET = "No Instagram account has been verified on this install yet.";

/**
 * The state that follows from the last look.
 *
 * Order is the safe order. A wrong or unreadable account outranks everything (a
 * schedule must never be judged against someone else's account), then the
 * composer -- direct evidence -- outranks the account-type heuristic.
 */
export function deriveConnection(v: InstagramVerification | null, now: number = Date.now()): Derived {
  if (!v) return { state: "not_connected", reason: NOT_YET, stale: false };
  const age = now - Date.parse(v.checkedAt);
  const stale = Number.isFinite(age) && age > STALE_AFTER_MS;

  if (!v.signedIn) {
    return {
      state: "not_connected",
      reason: v.reason ?? "Instagram is not signed in on BookReel's Instagram profile.",
      stale,
    };
  }
  if (v.identity === "mismatch") {
    return {
      state: "not_connected",
      reason:
        `Signed in as ${displayHandle(v.handle)}, but this install publishes to ${displayHandle(v.expected)}. ` +
        "Sign in to the right account (Connect Instagram), then verify again.",
      stale,
    };
  }
  if (v.identity !== "match") {
    return {
      state: "not_connected",
      reason:
        v.reason ??
        `Instagram did not say which account is signed in, so it cannot be checked against ${displayHandle(v.expected)}.`,
      stale,
    };
  }

  const who = displayHandle(v.handle);
  if (v.composer === "offers_schedule") return { state: "eligible", reason: null, stale };
  if (v.composer === "no_schedule_option") {
    return {
      state: "not_eligible",
      reason:
        `Instagram's composer did not offer "Schedule content" for ${who}. Native scheduling needs a professional ` +
        "(Business or Creator) account that Instagram has enabled it for. Nothing was posted or scheduled.",
      stale,
    };
  }
  if (v.accountKind === "personal") {
    return {
      state: "not_eligible",
      reason:
        `${who} is a personal account. Instagram offers scheduled posting to professional (Business or Creator) ` +
        "accounts. Switch it to a professional account in Instagram, then verify again.",
      stale,
    };
  }
  return { state: "connected", reason: v.composer === "unreachable" ? v.reason : null, stale };
}

/** What the person should do next. The card shows exactly one primary step. */
export type NextStep = "connect" | "check_scheduling" | "fix_account" | "set_flags" | "done";

export function nextStep(state: InstagramConnectionState, flags: { publish: boolean; nativeSchedule: boolean }): NextStep {
  switch (state) {
    case "not_connected":
      return "connect";
    case "connected":
      return "check_scheduling";
    case "not_eligible":
      return "fix_account";
    case "eligible":
      return flags.publish && flags.nativeSchedule ? "done" : "set_flags";
  }
}

// ----------------------------------------------------------------- reading the account type

/**
 * Instagram's settings page, reduced to a verdict. Best-effort and NOT verified
 * against the live site: it only says `personal` for the sentence only a personal
 * account is offered, and `professional` for sentences only a professional one is.
 * Anything else is `unknown`, which blocks nothing -- the composer decides.
 */
export function accountKindFromText(text: string | null | undefined): AccountKind {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t === "") return "unknown";
  if (/switch to (a )?professional account/i.test(t)) return "personal";
  if (/switch to (a )?personal account|professional dashboard|account type and tools|professional tools/i.test(t)) {
    return "professional";
  }
  return "unknown";
}

// ----------------------------------------------------------------- stored form

const IDENTITIES: readonly string[] = ["match", "mismatch", "unverified"];
const KINDS: readonly string[] = ["professional", "personal", "unknown"];
const CALENDARS: readonly string[] = ["readable", "unreadable", "not_checked"];
const COMPOSERS: readonly string[] = ["offers_schedule", "no_schedule_option", "unreachable", "not_checked"];

const isoOrNull = (x: unknown): string | null => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
const textOrNull = (x: unknown, max = 300): string | null => (typeof x === "string" && x.trim() !== "" ? x.slice(0, max) : null);

/**
 * The stored text back into a record, or null for anything that is not exactly
 * one. A hand-edited or older row must never throw in the Publish panel and
 * must never be believed past what it can prove: unknown values fail closed.
 */
export function parseVerification(raw: string | null | undefined): InstagramVerification | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const checkedAt = isoOrNull(o.checkedAt);
  if (o.v !== 1 || checkedAt === null || typeof o.signedIn !== "boolean") return null;
  if (typeof o.identity !== "string" || !IDENTITIES.includes(o.identity)) return null;
  if (typeof o.accountKind !== "string" || !KINDS.includes(o.accountKind)) return null;
  if (typeof o.calendar !== "string" || !CALENDARS.includes(o.calendar)) return null;
  if (typeof o.composer !== "string" || !COMPOSERS.includes(o.composer)) return null;
  const composerCheckedAt = isoOrNull(o.composerCheckedAt);
  // A composer result with no time it was seen is not a result.
  const composer = (o.composer === "offers_schedule" || o.composer === "no_schedule_option") && composerCheckedAt === null
    ? "not_checked"
    : (o.composer as ComposerCheck);
  return {
    v: 1,
    checkedAt,
    signedIn: o.signedIn,
    handle: textOrNull(o.handle, 100) === null ? null : normaliseHandle(String(o.handle)),
    expected: displayHandle(textOrNull(o.expected, 100)),
    identity: o.identity as IdentityVerdict,
    igUserId: textOrNull(o.igUserId, 40),
    accountKind: o.accountKind as AccountKind,
    calendar: o.calendar as CalendarCheck,
    scheduledCount: typeof o.scheduledCount === "number" && Number.isInteger(o.scheduledCount) && o.scheduledCount >= 0 ? o.scheduledCount : null,
    composer,
    composerCheckedAt,
    reason: textOrNull(o.reason),
  };
}

/**
 * A fresh ACCOUNT-ONLY look must not throw away a composer result that still
 * applies -- else re-verifying a good account would force another trip through
 * the composer. It applies only to the same account, found again, and only if the
 * composer actually gave an answer.
 */
export function carryComposer(prev: InstagramVerification | null, next: InstagramVerification): InstagramVerification {
  if (!prev || next.composer !== "not_checked") return next;
  if (prev.composer !== "offers_schedule" && prev.composer !== "no_schedule_option") return next;
  if (!next.signedIn || next.identity !== "match" || prev.identity !== "match") return next;
  if (normaliseHandle(prev.handle) !== normaliseHandle(next.handle)) return next;
  if (prev.igUserId && next.igUserId && prev.igUserId !== next.igUserId) return next;
  return { ...next, composer: prev.composer, composerCheckedAt: prev.composerCheckedAt };
}

/**
 * The record judged against the handle this install expects NOW. If the operator
 * moved the brand to another handle after the look, the old "match" must not be
 * believed: the identity is recomputed from the handle Instagram showed.
 */
export function judgedAgainst(v: InstagramVerification | null, expected: string): InstagramVerification | null {
  if (v === null) return null;
  return { ...v, expected: displayHandle(expected), identity: judgeIdentity(v.handle, expected) };
}

// ----------------------------------------------------------------- the wire shape

/** Progress of the one background check, in memory only. */
export interface CheckProgress {
  running: boolean;
  mode: "account" | "scheduling" | null;
  /** What it is doing now, in a sentence. */
  step: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set when the last run could not finish (not when it finished with a "no"). */
  error: string | null;
}

/** How this install opens a browser, for the words on the card. */
export type BrowserKind = "channel" | "attach" | "bundled";

/** Everything the card draws. Nothing here is a credential, a cookie or a path. */
export interface InstagramConnectionView {
  state: InstagramConnectionState;
  /** `@handle` as Instagram showed it, or null when none was read. */
  handle: string | null;
  /** `@handle` this install publishes to. */
  expected: string;
  accountKind: AccountKind;
  calendar: CalendarCheck;
  scheduledCount: number | null;
  composer: ComposerCheck;
  checkedAt: string | null;
  composerCheckedAt: string | null;
  stale: boolean;
  reason: string | null;
  next: NextStep;
  check: CheckProgress;
  browser: { ready: boolean; reason: string | null; kind: BrowserKind; headless: boolean };
  /** Are the two publishing flags on? BookReel only reports them; it never changes them. */
  flags: { publish: boolean; nativeSchedule: boolean };
}
