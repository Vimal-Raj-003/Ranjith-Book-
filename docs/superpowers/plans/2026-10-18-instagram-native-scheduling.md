# Instagram Native Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule each Weekly-Schedule video on Instagram natively — at activation, for its exact assigned Asia/Kolkata instant — marking it `SCHEDULED` only after Instagram's own UI reads the time back, mirroring YouTube.

**Architecture:** Instagram moves from the live-post ticker (`due.ts`, retired) to schedule-at-activation through `startBrowserPublish`, exactly like YouTube. The Instagram browser flow gains a native-schedule branch that drives Instagram's own Schedule control, reads the time back, and returns `scheduledFor`; the existing `run.ts rowFor` already turns a success with `scheduledFor` into a `SCHEDULED` row. A `BOOKREEL_IG_NATIVE_SCHEDULE` flag gates all of it.

**Tech Stack:** TypeScript, Next.js 16, Prisma (SQLite), Playwright-core (browser engine), node:test + tsx, the existing `tests/helpers/fake-browser.mts` scripted browser.

**Spec:** `docs/superpowers/specs/2026-10-18-instagram-native-scheduling-design.md`

## Global Constraints

- **No real posts/schedules until the operator approves a live test.** All tests use the scripted `makePublisher` seam or `fakeBrowser`; nothing opens a real window or network.
- **Feature flag `BOOKREEL_IG_NATIVE_SCHEDULE`** (truthy = on; unset = off) gates every real Instagram scheduling path. Tests force it on; one test asserts the off-state refusals.
- **Scope: Weekly-Schedule activation only.** The manual Publish Center (`flow.ts planInstagram`) is NOT changed and keeps posting Instagram immediately.
- **Do not edit YouTube code paths.** The Instagram immediate-`Share` path (no `scheduledAt`) stays unchanged.
- **`SCHEDULED`** is the existing status to use (from `src/lib/publish/limits.ts`). No new status, no migration.
- Times: the assigned instant (a UTC `Date`) is the source of truth; Instagram fields are typed/read in the **Instagram account's display timezone**, verified back to the intended instant **to the minute** (60_000 ms).
- Reuse the pure, timezone-aware helpers in `src/lib/schedule/time.ts`: `wallClock(instant, tz) → {date,time}` and `zonedInstant(date, time, tz) → Date`.
- Confirmation is **post-commit**: a `SCHEDULED` result requires Instagram to show the scheduled time back after *Schedule* is clicked; item+id but no parseable time ⇒ `AWAITING_HUMAN`, never `SCHEDULED`.

## Review Focus

- **Flag off + Instagram-containing schedule activated:** activation must refuse up front, naming the flag, and must NOT silently no-op or post live. (Task 4.)
- **Instagram account timezone ≠ Asia/Kolkata:** the typed wall-clock must be the account-tz rendering of the intended instant, and read-back must convert with the account tz; a mismatch across the UTC date line must still verify to the minute. (Task 2.)
- **Instagram confirms scheduling but shows no parseable time:** outcome must be `AWAITING_HUMAN`, not `SCHEDULED`. (Task 3.)
- **One platform stops `AWAITING_HUMAN` during activation:** the other platform's pass must still complete (independence). (Task 4.)
- **Re-activating after a partial run:** a slot already `scheduled`/`skipped` is never re-scheduled or re-validated; a flag-off re-activation of a YouTube-only schedule still works. (Task 4.)

---

## File Structure

- `src/lib/publish/browser/engine.ts` — add `igNativeScheduleEnabled(env)`; in `browserOptionProblems`, allow Instagram `scheduledAt` when the flag is on (validated), refuse it when off.
- `src/lib/publish/browser/instagram.ts` — add timezone-aware schedule helpers (pure), a native-schedule branch in `instagramFlow`, schedule selectors in the `IG` table, `canSchedule: true`, and thread `options` into `instagramFlow`.
- `src/lib/schedule/activate.ts` — generalize the runner to a per-platform pass that schedules YouTube and Instagram ahead; absorb the shared Instagram job helpers moved out of `due.ts`.
- `src/lib/schedule/store.ts` — Instagram activation validation (lead rule + flag refusal), drop `startInstagramTicker`, generalize `healScheduling`.
- `src/lib/schedule/due.ts` — **deleted** (ticker/live-post path retired); its `instagramJob`/`alreadyPostedInstagram`/`instagramOutcome` move to `activate.ts`.
- Tests: `tests/publish-browser.test.mts` (gate + flow via `fakeBrowser`), `tests/schedule.test.mts` (orchestration), extending existing files.

---

### Task 1: Feature flag and Instagram option gate

**Files:**
- Modify: `src/lib/publish/browser/engine.ts` (`browserOptionProblems` ~1053-1119; add `igNativeScheduleEnabled`)
- Test: `tests/publish-browser.test.mts`

**Interfaces:**
- Produces: `igNativeScheduleEnabled(env?: EnvLike): boolean` — true iff `BOOKREEL_IG_NATIVE_SCHEDULE` is set and not `""`/`"0"`/`"false"`.
- `browserOptionProblems(platform, options, now?)` unchanged signature; new behavior for `platform === "instagram"` with `scheduledAt`.

- [ ] **Step 1: Write failing tests** in `tests/publish-browser.test.mts`:
  - `igNativeScheduleEnabled` is false when the var is unset/`"0"`/`"false"`/`""`, true for `"1"`/`"true"`.
  - With the flag ON: `browserOptionProblems("instagram", { scheduledAt: <+1h>, confirmPublic: true }, now)` returns `[]`; a `scheduledAt` less than `MIN_SCHEDULE_LEAD_MS` away returns a `bad_options`; an invalid-date `scheduledAt` returns a `bad_options`; `confirmPublic` missing returns `needs_confirmation`.
  - With the flag OFF: `browserOptionProblems("instagram", { scheduledAt: <+1h>, confirmPublic: true })` returns a `bad_options` whose message names `BOOKREEL_IG_NATIVE_SCHEDULE`.
  - Unchanged: Instagram with no `scheduledAt` + `confirmPublic: true` returns `[]`; YouTube cases are untouched (keep one existing-shape assertion).
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --import tsx --import ./tests/setup/isolated-db.mjs --test tests/publish-browser.test.mts` — Expected: FAIL (new names/behavior absent).
- [ ] **Step 3: Implement.** Add `igNativeScheduleEnabled(env: EnvLike = process.env): boolean`. In `browserOptionProblems`, inside the `platform === "instagram"` block, replace the unconditional `scheduleAsked` refusal: if `scheduleAsked` and `!igNativeScheduleEnabled(...)`, push `bad_options` naming the flag; if `scheduleAsked` and enabled, apply the same `validDate` / `MIN_SCHEDULE_LEAD_MS` checks the YouTube branch uses. Keep the no-private and `confirmPublic` checks. (The env for the flag comes from `options`-independent `process.env`; read it via the same `EnvLike` pattern other engine readers use.)
- [ ] **Step 4: Run tests, verify they pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(publish): gate Instagram scheduledAt behind BOOKREEL_IG_NATIVE_SCHEDULE"`

---

### Task 2: Instagram schedule pure helpers (timezone-aware format + read-back)

**Files:**
- Modify: `src/lib/publish/browser/instagram.ts` (add exported pure helpers near the existing pure readers ~104-157)
- Test: `tests/publish-instagram.test.mts`

**Interfaces:**
- Produces:
  - `igScheduleDateText(instant: Date, timeZone: string): string` — the date string to type into Instagram, from `wallClock(instant, timeZone).date`, in the exact format Instagram's date field expects. *(Format string is a §7 real-site unknown; implement ISO-ish `YYYY-MM-DD` from `wallClock` and leave a single commented line that the live test adjusts it.)*
  - `igScheduleTimeText(instant: Date, timeZone: string): string` — the time string (`HH:mm`, 24h) from `wallClock(instant, timeZone).time`.
  - `judgeInstagramSchedule(shownDate: string, shownTime: string, intended: Date, timeZone: string): { ok: true; scheduledFor: Date } | { ok: false; problem: string }` — parse the shown wall-clock with `zonedInstant(shownDate, shownTime, timeZone)` and accept iff within 60_000 ms of `intended`; `scheduledFor` is the parsed instant.

- [ ] **Step 1: Write failing tests** in `tests/publish-instagram.test.mts`:
  - `igScheduleDateText`/`igScheduleTimeText` for a known instant in `Asia/Kolkata` and in `America/New_York` produce that zone's wall-clock date/time (assert exact strings, including a case that crosses the UTC date line).
  - `judgeInstagramSchedule`: round-trips its own formatted output to `ok: true` with `scheduledFor` equal to the intended instant; a one-minute-off `shownTime` ⇒ `ok: false`; an unparseable `shownTime` ⇒ `ok: false`.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --import tsx --import ./tests/setup/isolated-db.mjs --test tests/publish-instagram.test.mts` — Expected: FAIL.
- [ ] **Step 3: Implement** the three helpers in `instagram.ts`, importing `wallClock` and `zonedInstant` from `@/lib/schedule/time`. No new date math — delegate to those.
- [ ] **Step 4: Run tests, verify they pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(publish): timezone-aware Instagram schedule read-back helpers"`

---

### Task 3: Instagram browser flow drives native Schedule

**Files:**
- Modify: `src/lib/publish/browser/instagram.ts` (`IG` table ~87-102; `capabilities().canSchedule`; `instagramFlow` ~324-490; thread `options` through `publish`→`instagramFlow`)
- Test: `tests/publish-browser.test.mts`

**Interfaces:**
- Consumes: Task 2 helpers; `BrowserPublishOptions.scheduledAt`; `fakeBrowser`/`FakePage` from `tests/helpers/fake-browser.mts`.
- Produces: when `options.scheduledAt` is set, `publish()` returns `{ status: "PUBLISHED", externalId, externalUrl, confirmedAt, scheduledFor, visibility: "scheduled" }` on success, else `AWAITING_HUMAN`. With no `scheduledAt`, behavior is unchanged (live Share → `PUBLISHED` with reel link).

- [ ] **Step 1: Write failing tests** in `tests/publish-browser.test.mts`, using `fakeBrowser(site.page, { profileRoot: root, env: { BOOKREEL_IG_NATIVE_SCHEDULE: "1" } })` and `browserInstagramPublisher({ env, options: { scheduledAt: <instant>, confirmPublic: true }, deps: fake.deps }).publish(prepared("instagram"))` with a `FakePage` keyed by the new schedule selectors and a signed-in handle matching expected:
  - Happy path: the fake schedule fields echo the intended account-tz wall-clock and the confirmation shows the scheduled time; assert the outcome is `status: "PUBLISHED"` with a non-null `scheduledFor` within 60_000 ms of the intended instant and `visibility: "scheduled"`, and that the recorded actions include a click on the **Schedule** selector and **not** the Share selector.
  - Mismatch: the fake read-back shows a time one minute off ⇒ `AWAITING_HUMAN`, no Schedule/Share committed beyond the recorded stop.
  - Confirmed-but-no-time: scheduled item + id present, no parseable time ⇒ `AWAITING_HUMAN`.
  - Unchanged immediate path: no `scheduledAt` ⇒ existing live-Share assertion still holds (keep/mirror the current Instagram publish test).
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --import tsx --import ./tests/setup/isolated-db.mjs --test tests/publish-browser.test.mts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add to `IG`: `scheduleToggle`, `scheduleDateInput`, `scheduleTimeInput`, `scheduleButton` selectors (conventional best-effort; add a comment that §7 validates them, like the file's existing header).
  - Set `capabilities().canSchedule = true`.
  - Thread `ctx.options` into `instagramFlow` (add an `options`/`scheduledAt` parameter, mirroring how `youtubeFlow` receives its options).
  - In `instagramFlow`, after the caption step: if `scheduledAt` is set, read the account's display timezone from Instagram's UI (best-effort; if unreadable, `NeedsHuman` "could not read the account timezone"); open the schedule control; `fillIn` date/time from `igScheduleDateText`/`igScheduleTimeText`; read the fields back and `judgeInstagramSchedule` — on `!ok`, `NeedsHuman`; click `IG.scheduleButton` (set `committed`); then confirm the scheduled state and obtain the platform-shown id for the scheduled item; parse the confirmed time — if absent, `NeedsHuman` ("scheduled, but the time could not be confirmed… do not retry"); return the success outcome with `scheduledFor` and `confirmedAt: new Date()`. If `scheduledAt` is absent, run the existing Share path untouched.
- [ ] **Step 4: Run tests, verify they pass.** Same command — Expected: PASS. Also run `tests/publish-instagram.test.mts` to confirm no regression.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(publish): Instagram browser flow schedules natively and reads the time back"`

---

### Task 4: Schedule both platforms at activation; retire the Instagram ticker

**Files:**
- Modify: `src/lib/schedule/activate.ts` (per-platform runner; absorb `instagramJob`/`alreadyPostedInstagram`/`instagramOutcome`)
- Modify: `src/lib/schedule/store.ts` (`activateSchedule` validation + flag refusal; drop `startInstagramTicker`; generalize `healScheduling`)
- Delete: `src/lib/schedule/due.ts`
- Test: `tests/schedule.test.mts`

**Interfaces:**
- Consumes: `igNativeScheduleEnabled` (Task 1); `startBrowserPublish(userId, episodeId, "instagram", { scheduledAt, confirmPublic: true, waitForCompletion, env, deps, makePublisher })`; `alreadyThere`/`slotOutcome` (reused for both platforms since a scheduled Instagram job is `SCHEDULED` with `scheduledFor`).
- Produces: `runSchedule(scheduleId, options)` now schedules YouTube **and** Instagram slots ahead, each platform in its own pass. `activateSchedule` refuses when the flag is off and any Instagram slot is present.

- [ ] **Step 1: Write failing tests** in `tests/schedule.test.mts` (flag forced on via `process.env.BOOKREEL_IG_NATIVE_SCHEDULE = "1"` in setup for the on-path tests; mocked `makePublisher` returning a scheduled outcome, mirroring the YouTube scripted outcome at ~255):
  - Activate "both": after activation, **both** the YouTube and Instagram slots read `scheduled`, each has a `SCHEDULED` `PublishJob` with `scheduledFor` at the assigned instant, and the Instagram publisher was called **with** `scheduledAt` equal to the slot instant. (Replaces the old "Instagram is left pending" test.)
  - Instagram scheduled only on read-back: a scripted Instagram publisher returning `AWAITING_HUMAN` leaves the Instagram slot `failed`/pending and never `scheduled`; the YouTube slot is untouched (independence).
  - Flag OFF: activating a schedule that contains Instagram slots throws a `bad_options`/`AppError` naming `BOOKREEL_IG_NATIVE_SCHEDULE`, and **nothing** is scheduled; a YouTube-only schedule still activates with the flag off.
  - Re-activation: a slot already `scheduled` is not re-validated or re-scheduled (no second publisher call).
  - Lead rule: an Instagram slot less than 15 minutes away is refused at activation with a naming message (same floor as YouTube).
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --import tsx --import ./tests/setup/isolated-db.mjs --test tests/schedule.test.mts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move `instagramJob`, `alreadyPostedInstagram`, `instagramOutcome` from `due.ts` into `activate.ts` (exported, for `store.ts`). *(Note: a scheduled-ahead Instagram job is now `SCHEDULED`; `alreadyThere`/`slotOutcome` already handle that, so these movers mainly serve `store.ts healScheduling`. Keep `alreadyPostedInstagram`'s externalId-sighting dedupe.)*
  - Generalize `runSlots`/`runSlot` to accept a `platform` and run one pass per platform present in the schedule; a `stop` in one platform's pass must not affect the other's. For Instagram, call `startBrowserPublish(..., "instagram", { scheduledAt: slot.assignedAt, confirmPublic: true, waitForCompletion: true, ... })` (no `madeForKids`). Relax the `runSlots` guard so an Instagram-only schedule (`madeForKids` null) runs its Instagram pass; `madeForKids` stays required for the YouTube pass.
  - In `store.ts activateSchedule`: when `!igNativeScheduleEnabled()` and any slot is Instagram, throw `badBody` naming the flag before marking active. Validate Instagram slots with `MIN_SCHEDULE_LEAD_MS` (like YouTube) rather than "any future". Remove the two `startInstagramTicker()` calls and the `./due` import; generalize `healScheduling` so Instagram uses `alreadyThere`/`slotOutcome` (scheduled semantics). Remove `isInstagramDuePassActive` usage in `viewOf` (the `scheduling` self-heal no longer has a live ticker to wait on; the YouTube in-flight guard remains).
  - Delete `src/lib/schedule/due.ts`.
- [ ] **Step 4: Run tests, verify they pass.** Run the schedule suite, then the full publish+schedule set: `node --import tsx --import ./tests/setup/isolated-db.mjs --test tests/schedule.test.mts tests/publish-browser.test.mts tests/publish-instagram.test.mts tests/publish.test.mts` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(schedule): schedule Instagram natively at activation; retire live-post ticker"`

---

### Task 5: Full-suite regression and typecheck

**Files:** none (verification only)

- [ ] **Step 1: Build the test template.** Run: `node scripts/test-db.mjs` — Expected: "test database template ready".
- [ ] **Step 2: Run the whole suite.** Run: `npm test` — Expected: all pass, 0 fail. Investigate any failure before proceeding; do not edit YouTube behavior to make a test pass.
- [ ] **Step 3: Typecheck.** Run: `npm run typecheck` — Expected: no errors (confirms `due.ts` deletion left no dangling imports).
- [ ] **Step 4: Verify the manual path stayed immediate (spec §10.1).** Inspect `src/lib/publish/flow.ts` (`planInstagram`) and `src/components/PublishFlow.tsx`/`InstagramPublish.tsx`: confirm the manual single-video Instagram path still never sets `scheduledAt` and does not render a schedule control keyed off the now-true `canSchedule`. If a control would light up, gate it so Instagram's manual page stays immediate-only, with a test. Expected: manual Instagram publish is unchanged (immediate).
- [ ] **Step 5: Commit** any lint/type fixups. `git add -A && git commit -m "test: full-suite regression for Instagram native scheduling"`

---

## Notes carried from the spec (not re-derived by the implementer)

- The DOM choreography selectors in Task 3 are **best-effort and unverified against live Instagram** (spec §7). The operator-approved live test validates/adjusts them, the account-timezone read, the scheduled-item id, and Instagram's real lead floor. Unit tests prove the *decisions* (read-back required, Schedule-not-Share, flag gating, independence), not that a selector matches instagram.com.
- There are 0 schedules in the current DB, so retiring the ticker needs no data migration.
