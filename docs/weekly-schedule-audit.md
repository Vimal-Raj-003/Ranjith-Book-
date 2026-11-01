# Weekly Schedule source audit and implementation mapping

Reference inspected: `<path-to-reporeel-checkout>`, including its actual source rather than an assumed publishing API. This document records the mapping **before** the UI implementation. User screenshots dated 2026-10-27 are the visual reference. No reference credentials, databases, browser profiles or account information are reusable assets.

## Existing change-set review

The starting tree contains 46 modified tracked files plus untracked implementation files; the earlier request calls this the 56-file change set. `docs/publishing-workflow.md` describes that earlier work. It implements the native scheduling engine, account checks, bounded browser steps, Instagram's execution gate, recovery and tests, but explicitly retains a smaller per-book modal. It is not a complete reproduction of the reference UI.

Existing generation, engine-selection, analysis, inspector, settings and media changes are outside this task and must be preserved. The moved ideas-selection helper fixes a Next route-export build error and should stay. The existing `WeeklySchedule`, `ScheduleSlot` and `PublishJob` tables and `schedule/worker.ts` remain authoritative. New page adapters must not introduce another timer, scheduler or publishing queue. Existing version-1 schedules must not silently become worker-eligible. Existing account sessions and generated files stay in place.

## Actual reference journey and control inventory

| Screen/control | Source and actual behavior | BookReel mapping |
|---|---|---|
| Studio Schedule entry | `components/Studio.tsx`, `app/schedule/page.tsx`: authenticated full-page `/schedule`, back-to-studio link | Add full page and navigation; replace per-book modal entry with link, preserving generation |
| Page layout | `components/ScheduleBoard.tsx`: max width 1200, responsive padding, display headings, mono labels, slab cards; `app/globals.css` supplies theme tokens, colorful purple borders/glass and magenta/blue buttons | Adapt actual components using BookReel's existing theme tokens |
| Saved schedule selector | GET `/api/schedules`; newest noncancelled selected, name/status/occupied slots; New schedule toggles inline form | List existing schedules, including legacy plans, using existing tables |
| New schedule form | Name/default Week of DATE; first day defaults tomorrow; days 1–31; public/private/unlisted visibility; three time windows; Instagram offset 0–180 minutes; optional integer seed; inclusive-end checkbox | Same controls and validation; explicit BookReel audience answer retained |
| Date/time subdialogs | `SchedulePickers.tsx`: portal calendar, month/year selection, today/clear, keyboard navigation; 24h time spinner, quick minutes, clear/apply, Escape/focus restore | Reuse source; adapt time helper import only |
| Draw the week | `service.normalizeSettings/createSchedule/pickSelected`; seeded `plan.generatePlan`; saves draft, never publishes; uses tick order from session selection; no automatic substitute videos; empty slots retained | Persistent full grid over existing per-platform slots, ordered BookReel episode IDs; allow empty draft |
| Draft summary | Counts, zone, visibility, native-upload explanation, offset, minimum gap, grace, profile-presence indicators, seed | Derived DTO from BookReel records; profile existence is not account verification |
| Save settings / redraw | Draft-only name, visibility, offset; redraw asks confirmation, changes times but preserves videos | Update same schedule/slots transactionally |
| Draft slot editing | Day groups, date/time picker with save/undo, video dropdown with empty option; assigning a video already in another slot swaps them | Group paired BookReel platform slots into one visible video slot; transactional swap |
| Validation/conflicts | `plan.checkSlots/checkAgainst/checkOrder`; 30-minute gap with default lead; invalid/past/too-close times are errors, outside-window edits produce warnings; empty slots warned/skipped; unavailable video disclosure; queued-only release confirmation | Reuse pure checks, preserve ownership and duplicate protection; disabled Instagram cannot create YouTube conflicts |
| Activate | Explicit browser confirmation; refuses errors/conflicts; `service.activateSchedule` snapshots metadata, persists jobs and starts native upload lanes | Existing `store.activateSchedule` and `activate.runSchedule`, extended for grid slots and visibility; no live activation during tests |
| Active/paused summary | Retry, Pause/Resume, Cancel schedule confirmations; cancel cannot undo a remote platform schedule | Same operations over existing jobs; preserve remote IDs and receipts |
| Per-slot controls | Reschedule/Move/Undo, Pause/Resume, Cancel, Bring back at new time, OK Start Now recovery; already scheduled YouTube cannot be moved locally | Slot lifecycle separate from platform result; checked rearming through same worker |
| Platform cells | Independent YouTube/Instagram chips; upload start vs target time; remote link; short error, Details/Hide, retry and human confirmation | Translate BookReel statuses accurately; disabled Instagram explicit; confirmation reads platform evidence rather than assuming success |
| Status refresh | Active/paused page polls every 5s; no browser-owned publishing timer | Same bounded read polling; existing server worker only |
| Generated videos | `GeneratedVideos.tsx`, `publish/videos.ts`: newest first, 12/page, search, count, selectable checkboxes, all/deselect, session-persisted selection across pages | All owned BookReel generated episodes, file checks, thumbnails and platform jobs |
| Thumbnail and preview | Actual available image variants, saved choice, optimistic rollback on error; selection locked during upload; inline video preview | Existing BookReel poster selection/media routes; preserve per-platform overrides |
| Publish Selected Videos | Sticky action opens dialog, re-reads selection; no platform selected by default; YouTube/Instagram/both; YouTube visibility; available browser/API engine options; per-video assigned time and skip reasons | Same dialog, BookReel account capabilities and execution gates |
| Schedule vs Publish now | Separate buttons/plans: Schedule uses persisted slot instant and native flow, rejects no-slot/past/nonpublic-YouTube; Publish now ignores assigned slot but needs explicit confirmation; bulk does not activate whole schedule | Same existing publishers and slots; route rechecks eligibility, ownership and duplicates |
| Batch progress | Per-video/platform progress, finished/failed counts, refused/skipped reasons, Dismiss | Actual job results; no estimated success |
| Platform actions | Retry failed; human confirmation; cancel queued/uncertain; “I deleted it there” explicitly confirms remote removal | Safe BookReel equivalents; retain uncertain remote IDs until checked |

The source has no separate Save Draft or Schedule Status button: Draw the week saves the draft and the selected schedule is the status view. It has no schedule-level channel chooser or made-for-kids question; audience/account behavior comes from publishing configuration. BookReel's existing explicit audience requirement is retained. Screenshots show History/additional-post controls absent from the inspected `GeneratedVideos.tsx`; these cannot be claimed as existing source behavior. BookReel will expose recorded attempt history without fabricating historical receipts.

## Execution mapping

| Reference implementation | BookReel implementation retained/adapted |
|---|---|
| `schedule/service.ts`: candidates, create/settings/redraw/edit/view/list/activate, release, pause/resume/cancel/delete, reschedule/start-now | Page service adapter over `schedule/store.ts`, existing tables and existing activation runner |
| `schedule/plan.ts`, `time.ts` | Already adapted `plan.ts`, `reference-time.ts`; keep deterministic seed, local calendar arithmetic and exact UTC instants |
| `publish/scheduler.ts`, `schedule/job-timing.ts`, `job-times`/native scheduling | Existing opt-in `schedule/worker.ts`, `activate.ts`, `due.ts`; one worker with independent platform lanes |
| `publish/bulk.ts`, `videos.ts`, `video-selection.ts`, duplicate locks | BookReel generated-video DTO/bulk adapter; preserve unique episode/platform job, conditional claims and remote checkpoints |
| `publish/youtube/*` API | Existing BookReel OAuth account, strict intended-channel gate, resumable upload and publishAt verification; no reference tokens |
| `publish/browser/youtube*` | Existing BookReel persistent profile, loaded-dashboard handling, account gate, selectors/settings, upload checkpoint, native schedule/readback, bounded waits |
| `publish/browser/instagram*` | Existing native composer/calendar adapter and BookReel profile/account verification; execution stays disabled globally |
| `schedule/retry.ts`, `reconcile.ts`, publish retry policy/recovery | Existing PID/heartbeat recovery and API retry delays, known-remote confirmation; UI retry must not blindly reupload uncertain jobs |
| `PublishJob` history and status | Existing authoritative job plus durable attempt snapshots; historical missing data labelled unavailable, never reconstructed as platform success |

Reference public YouTube schedules upload ahead and set private + future publication; nonpublic schedules wait for their upload start and save their chosen visibility. Instagram requests its own native schedule in the web composer; older nonnative jobs use timed Share. Both require their own platform confirmation. They do not use the same platform API. API eligibility and browser sessions are separate. An existing profile only establishes that it has been used, not that the intended account is currently signed in.

## Rollout and verification boundaries

Tests must use isolated SQLite and generated fixture media, mocked publishers/platform pages and an isolated browser context. Do not activate production drafts or invoke live bulk actions. Keep `BOOKREEL_SCHEDULE_WORKER_ENABLED=0`, `BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=0` and `BOOKREEL_IG_NATIVE_SCHEDULE=0` during implementation. YouTube identity is checked before file input/API upload; platform success requires remote readback. No live YouTube/Instagram result will be claimed from mocks.

Verification will cover draft persistence, ordered selection, empty slots, picker interactions, settings/redraw/swap, 31-day dates and Asia/Kolkata, pause/cancel/retry, platform separation, duplicate prevention, restart recovery, accurate history and desktop/mobile page behavior. Typecheck, lint and production build follow focused tests. Runtime authentication limitations and any source/screenshot differences will be reported explicitly.
