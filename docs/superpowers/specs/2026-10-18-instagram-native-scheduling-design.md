# Instagram native scheduling — design

**Status:** draft for approval
**Date:** 2026-10-18
**Repo:** BookReel (`bookreel`), this workspace
**Requested by:** the operator, who confirmed the target Instagram account is a
Professional (Business/Creator) account with the native **Schedule** option in
the web Create flow.

---

## 1. What this is, and why

Today BookReel schedules **YouTube** natively — it uploads each video at
activation and drives YouTube Studio's own *Schedule* control, then marks the
job `SCHEDULED` only after Studio's page reads the chosen time back. **Instagram
does the opposite:** it is *not* scheduled. A background ticker
([`due.ts`](../../../src/lib/schedule/due.ts)) waits until each slot's moment and
posts the Reel **live** by clicking *Share*, because the code was written for
accounts whose web uploader has no schedule option.

The operator now has an Instagram account that **does** have native scheduling,
and wants Instagram to behave exactly like YouTube: at activation, each assigned
video is **scheduled on Instagram** for its exact Weekly-Schedule date and time
(Asia/Kolkata), and the slot is marked successful **only after Instagram's own UI
confirms the post is scheduled for that time** — never on a hopeful "we clicked
Schedule".

**Why now:** the current live-post design means Instagram only goes out if the
server and a signed-in Chrome are both up at the exact minute, the post lands
slightly late, and — verified in this repo — the one real attempt stalled at
`AWAITING_HUMAN` and posted nothing. Native scheduling hands the timing to
Instagram, the same guarantee YouTube already gives.

## 2. Goals

- At **activation**, every Instagram slot is scheduled on Instagram for its exact
  assigned instant (the same UTC instant already persisted for the YouTube slot,
  derived from the operator's Asia/Kolkata wall-clock time).
- A slot/job is recorded `SCHEDULED` **only after Instagram's own UI reads the
  scheduled date and time back and they match the intended minute** — the same
  read-back discipline as YouTube (`judgeReadback` / `sameSchedule`).
- Instagram and YouTube schedule **independently**: one platform's failure never
  changes the other's slot, and each has its own `PublishJob` row.
- The existing honesty guarantees hold: no `SCHEDULED` without platform
  confirmation, no invented ids, failures surfaced with the real reason, and the
  flow never silently turns a *schedule* request into a live post.

## 3. Non-goals

- **Not** changing YouTube's working implementation in any way.
- **Not** touching the Instagram **Graph API** publisher
  ([`instagram/publisher.ts`](../../../src/lib/publish/instagram/publisher.ts)):
  the Meta Content Publishing API has no scheduled-publish for standard media,
  so native scheduling is a **browser-only** capability.
- **Not** building a fallback for accounts *without* native scheduling in this
  change. The target account has it; a fallback can come later.
- **Not** performing any real-platform scheduling or publish until the operator
  explicitly approves a live test. All automated tests are mocked.

## 4. Anti-goals (these would make it a failure even if it "works")

- Marking a slot `SCHEDULED` when Instagram did not confirm the scheduled time.
- Recording an id Instagram did not show, to satisfy the "needs an id" contract.
- Posting the Reel **live/immediately** when a schedule was requested (the exact
  failure mode the current refusal was protecting against).
- Changing the persisted assigned instant, or introducing any offset between the
  intended Asia/Kolkata time and what is entered on Instagram.

## 5. Constraints

- **No real posts/schedules until explicit approval.** The real-platform test is
  a separate, gated step.
- SQLite, Prisma; `PublishJob.status` is a free string, and **`SCHEDULED` already
  exists** in the vocabulary ([`limits.ts`](../../../src/lib/publish/limits.ts)) —
  no migration and no new status is needed. (The operator's phrase
  "`PLATFORM_SCHEDULED`" maps to this existing `SCHEDULED` state, which already
  means "the platform itself confirmed the post is scheduled for later".)
- The Instagram browser flow is **unverified against the live site**; selectors
  are conventional, and the native-schedule controls are an additional unknown.
- One Chrome window per platform; a dedicated BookReel profile (channel mode) or
  an attached operator Chrome (CDP), exactly as today.

## 6. The design (decided — my calls unless noted)

### 6.1 Architecture: Instagram moves to schedule-at-activation, like YouTube

- **`activate.ts`** (the activation runner) is generalized to schedule **both**
  platforms' slots ahead at activation, each with
  `scheduledAt = slot.assignedAt`. Instagram slots stop being left `pending` for
  a ticker.
- **The Instagram due-runner (`due.ts`, the 30-second post-live ticker) is
  retired** from the scheduling path, along with `startInstagramTicker()` and its
  call sites in [`store.ts`](../../../src/lib/schedule/store.ts). Instagram is no
  longer posted live at slot time. (There are **0** schedules in the current DB,
  so there is nothing live to migrate.)
- Slot resolution (`store.ts healScheduling`, `view.ts`) uses the **same**
  `alreadyThere` / `slotOutcome` logic for Instagram as for YouTube, so an
  Instagram slot reads `scheduled` once its job is `SCHEDULED`. The `scheduled`
  slot status already exists.

### 6.2 Allow Instagram scheduling in the option gate

- In [`engine.ts browserOptionProblems`](../../../src/lib/publish/browser/engine.ts)
  (lines ~1062–1070), remove the Instagram-specific refusal of `scheduledAt`.
  Instagram with `scheduledAt` becomes valid, subject to:
  - a valid future date,
  - a minimum lead time (Instagram's own floor; **my call: reuse the 15-minute
    `MIN_SCHEDULE_LEAD_MS`** unless the real-platform test shows Instagram needs
    more — Instagram commonly requires ≥ ~20 min and ≤ 75 days; the exact floor
    is a real-platform unknown, see §7),
  - `confirmPublic: true` (unchanged — a scheduled Reel still goes public).
  - Instagram still has no private/unlisted; that refusal stays.

### 6.3 The Instagram browser flow drives native Schedule

In [`instagram.ts`](../../../src/lib/publish/browser/instagram.ts), when
`options.scheduledAt` is set, the flow mirrors YouTube's Studio scheduling:

1. Through *New post → attach render → Next → cover → Next → caption* as today.
2. **Open Instagram's native schedule control** (toggle / "Advanced settings")
   and **enter the date and time** for the intended instant, expressed in the
   **Instagram account's display timezone** (see §6.4).
3. **Read the entered date/time back** from Instagram's own fields and verify
   they equal the intended instant **to the minute** — a new pure helper pair
   mirroring `studioDateText`/`studioTimeText` + `sameSchedule`/`judgeReadback`.
   A mismatch, or an unreadable value, is `AWAITING_HUMAN` ("nothing was
   scheduled"), never a guess.
4. Click **Schedule** (not *Share*). `committed = true` only at this click.
5. **Confirm the scheduled state** from Instagram's own UI — Instagram's
   confirmation and/or its *Scheduled content* listing showing an entry with this
   caption at this time — and obtain an identifier Instagram shows for the
   scheduled item (see §6.5).
6. Return `{ status: "PUBLISHED", externalId, scheduledFor: <read-back time>,
   visibility: "scheduled" }`. [`run.ts rowFor`](../../../src/lib/publish/browser/run.ts)
   already turns a success **with** `scheduledFor` into a `SCHEDULED` row (not
   `PUBLISHED`, `publishedAt` stays null) — no change needed there.
7. Set the publisher's `canSchedule: true` (it is driven now).

When `options.scheduledAt` is **absent**, the flow is unchanged (live *Share*).
So the immediate-post path still exists and is unaffected.

### 6.4 Timezone correctness (the correctness crux)

The assigned instant is a UTC `Date` built from the operator's **Asia/Kolkata**
wall-clock time (`zonedInstant`). Instagram's schedule UI shows and accepts times
in the **account's own timezone** (set in the professional account settings),
which is **not guaranteed** to be Asia/Kolkata and is independent of the server's
timezone.

- **Decision:** compute the wall-clock date/time to **type** by converting the
  intended UTC instant into the **Instagram account's display timezone**, read
  from Instagram's own UI where possible; then the **read-back** re-derives the
  intended instant from what Instagram shows and compares to the intended UTC
  instant to the minute. The instant is the source of truth; the displayed
  wall-clock is only a means to enter it.
- If the account timezone cannot be read, the flow does **not** assume one — it
  stops `AWAITING_HUMAN` with a clear message, rather than risk scheduling at the
  wrong absolute time. (The operator can set the account timezone to Asia/Kolkata
  to make this unambiguous; whether to *require* that is an operator decision —
  see §7.)

### 6.5 The scheduled-item identifier

The `PublishOutcome` success variant requires an `externalId` Instagram showed.
A scheduled-but-not-live Reel has **no public `/reel/` permalink yet**, so the
current "find the new reel link" step does not apply to a scheduled post.

- **Decision:** record the identifier Instagram exposes for the **scheduled
  item** (e.g. an id/handle in the *Scheduled content* listing, or the
  confirmation). This is a real platform-shown id, satisfying the contract and
  blocking a second schedule of the same video.
- If Instagram exposes **no** stable id for the scheduled item, the outcome is
  **`AWAITING_HUMAN`** ("scheduled, but its entry could not be confirmed — check
  Scheduled content; do not retry"), consistent with how the code already treats
  "shared but no link found". **No id is ever invented.** Which identifier
  Instagram actually exposes is a real-platform unknown (§7).

### 6.6 Activation validation

Instagram slots are validated at activation like YouTube's: each must be a
finished video of this book owned by this account, and at least the minimum lead
away (§6.2), not merely "in the future". Settled/failed slots are not
re-validated (unchanged rule).

## 7. What's left to the builder / the real-platform test

These cannot be settled from code and are the agenda for the **operator-approved
real-platform session** (one real schedule, then delete it):

1. **The native-schedule selectors and steps** — where the Schedule control is
   (toggle vs "Advanced settings"), the date/time field markup, and the final
   *Schedule* button label/selector. Captured as a selector table like
   `IG`/`YT`, validated and adjusted live.
2. **The account display timezone** — how Instagram exposes it on the page, and
   confirmation that read-back to the minute holds across the UTC date line.
3. **The scheduled-item identifier** — what, if anything, Instagram shows for a
   scheduled post, and where (confirmation vs *Scheduled content*).
4. **Instagram's minimum/maximum lead** — the real floor/ceiling, to set the
   validation precisely.
5. Whether the operator wants to **require** the Instagram account timezone to be
   Asia/Kolkata (simplest, unambiguous) or support any account timezone via
   read-back conversion. *(Operator decision.)*

## 8. Testing (all mocked — no real platform)

Mirror [`schedule.test.mts`](../../../tests/schedule.test.mts)'s scripted-publisher
approach (`makePublisher`), plus `publish-browser`/`publish-instagram` unit style:

- **Pure helpers:** Instagram date/time formatting and the schedule read-back
  verifier (`sameSchedule`-equivalent) — correct across timezones and the date
  line; a one-minute mismatch is rejected.
- **Option gate:** Instagram with a valid future `scheduledAt` + `confirmPublic`
  is accepted; too-soon / invalid-date / missing-confirm are refused with the
  right codes; YouTube behavior unchanged.
- **Browser flow (scripted):** a scripted publisher returning
  `{ scheduledFor: <read-back> }` yields a `SCHEDULED` job; a mismatch or missing
  id yields `AWAITING_HUMAN`; `scheduledFor` absent still yields the live path.
- **Orchestration:** activation schedules **both** platforms ahead; an Instagram
  slot reads `scheduled` only when its job is `SCHEDULED`; per-platform
  independence and dedupe hold; re-activation does not reschedule a settled slot.
- **Regression:** YouTube scheduling tests still pass unchanged; the retired
  due-runner's removed behavior is replaced by activation-time scheduling tests.

## 9. Rollout / safety

- Land behind the **`BOOKREEL_IG_NATIVE_SCHEDULE` feature flag** (§10.2); no real
  schedule until the §7 session, which the operator explicitly approves and which
  creates exactly one schedule and then deletes it.
- YouTube code paths are not edited; the Instagram immediate-`Share` path is kept
  for the no-`scheduledAt` case.
- Reversible: the change is additive in the engine/flow; re-enabling the
  due-runner is a revert if ever needed.

---

## 10. Decisions from the builder review (2026-10-18)

The operator answered the two scope questions the review surfaced; the rest are
my calls, recorded here so the builder does not have to re-derive them.

### 10.1 Scope: Weekly-Schedule activation only (operator decision)

Instagram native scheduling applies **only to the Weekly-Schedule activation
path**. The manual single-video **Publish Center is unchanged** and keeps posting
Instagram immediately (its `planInstagram` in
[`flow.ts`](../../../src/lib/publish/flow.ts) still routes Instagram to the
immediate API/`Share` path and never sets `scheduledAt`).

- **Added non-goal:** reworking the manual publish path to schedule Instagram.
- Because the Instagram browser publisher now advertises `canSchedule: true`
  (§6.3 step 7), the builder must confirm the **manual** Publish page does not
  light up a schedule control for Instagram off the back of that capability. If
  any manual-page control keys off `canSchedule`, gate it so Instagram's manual
  page stays immediate-only. Weekly Schedule is the sole entry point that passes
  `scheduledAt` for Instagram.

### 10.2 Safety: `BOOKREEL_IG_NATIVE_SCHEDULE` feature flag (operator decision)

A real Instagram schedule is attempted **only when the env flag
`BOOKREEL_IG_NATIVE_SCHEDULE` is set** (truthy). Default/unset = off.

- **Option gate:** when the flag is **off**, `browserOptionProblems` refuses
  Instagram `scheduledAt` with a clear message (the same place the old refusal
  lived), so no code path can start a real Instagram schedule.
- **Activation:** when the flag is **off**, `activateSchedule` refuses, up front,
  to activate a schedule that contains Instagram slots — naming the flag — rather
  than silently doing nothing (the due-runner is retired, so an un-flagged
  Instagram slot would otherwise be a no-op). **YouTube-only schedules are
  unaffected.**
- **Tests force the flag on** to exercise the real scheduling path; one test
  asserts the off-state refusals.
- This is the code-level guarantee that merging cannot cause a premature live
  Instagram schedule before the operator flips the flag for the §7 session.

### 10.3 Time confirmation must be post-commit (my call, resolves review item 3)

The recorded `scheduledFor` must come from a **post-commit** confirmation of the
time (after *Schedule* is clicked), mirroring YouTube's `judgeReadback`. A
pre-commit field echo alone never stands in for platform confirmation. If, after
committing, Instagram surfaces the scheduled item and an id but **no parseable
time**, the outcome is **`AWAITING_HUMAN`** ("scheduled, but the time could not be
confirmed — check Scheduled content; do not retry"), never `SCHEDULED`.

### 10.4 Builder-level mechanics (my calls — no operator input needed)

- **Per-platform activation passes.** Generalize `activate.ts` so YouTube and
  Instagram each run their own pass; one platform stopping `AWAITING_HUMAN` must
  not strand the other (required by the §2 independence goal).
- **`madeForKids` run guard.** Relax `runSlots`' guard so an Instagram-only
  schedule (which activates with `madeForKids` null per `store.ts`) can still run
  its Instagram pass; "made for kids" stays required for YouTube only.
- **Pass `options` into `instagramFlow`.** It currently does not receive them
  (unlike `youtubeFlow`); the schedule time/flag travel through `options`.
- **Relocate the shared Instagram helpers.** `instagramJob`,
  `alreadyPostedInstagram`, `instagramOutcome` currently live in the retired
  `due.ts` but are used by `store.ts`; move them to `activate.ts` (or a small
  shared module) so retiring the ticker does not remove them.
- **`confirmedAt` on the scheduled outcome.** Include it to satisfy the
  `PublishOutcome` type even though `rowFor` leaves `publishedAt` null for a
  scheduled result.
