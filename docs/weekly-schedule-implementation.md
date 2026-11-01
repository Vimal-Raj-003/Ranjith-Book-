# BookReel Weekly Schedule: implementation and verification

The source-derived full-page Weekly Schedule and native scheduling path are implemented at `/schedule`. This is not a claim of unrestricted A–Z parity or real-platform success: the differences in item 4 remain. The app is running locally at `http://localhost:3001/schedule`, with Instagram and unattended publishing disabled.

## 1. Discovered reference workflow

The reference is the actual working tree at `<path-to-reporeel-checkout>`, together with the five supplied screenshots. The pre-implementation control inventory and source-to-target mapping are in [weekly-schedule-audit.md](weekly-schedule-audit.md).

1. RepoReel's `pipeline.ts` finishes assets, sets the creation to `DONE`/`Ready`, and exposes the rendered video and metadata. A separate fully automatic generation branch calls `autoPublish`; it is outside the manual Weekly Schedule journey and was not added to BookReel's generation pipeline.
2. Studio's **Schedule** entry opens the authenticated `/schedule` page. The saved-schedule selector chooses an existing plan; **New schedule** toggles the inline form. **Back to the studio** returns to generation.
3. The gallery lists recent creations, including unfinished/unavailable states, with 12 per page, search, thumbnails, preview, selection checkboxes and Select all/Deselect all. Selection is ordered and retained in session storage across pages. Eligibility checks ownership, finished assets and existing platform jobs.
4. The form contains name, first day, 1–31 days, YouTube visibility, three daily windows, Instagram offset, optional seed and inclusive-end choice. Date/time controls have their own calendar/time dialogs. Every scheduling instant is calculated from Asia/Kolkata wall time.
5. **Draw the week** saves a draft with three slots per day. It places only eligible selected videos in selection order, reports exclusions and excess selections, and retains empty slots. There is no separate Save Draft button in the inspected source.
6. The draft displays counts, configuration, profile-presence hints, validation, unavailable-video disclosure and day groups. Video dropdowns can swap assignments or empty a slot. Date/time edits have Save/Undo. Save settings persists draft settings; confirmed redraw changes times while retaining assignments.
7. **Activate** asks for confirmation, rejects validation/conflict errors, freezes approved payloads, persists platform jobs and starts native scheduling. Public YouTube and native Instagram upload ahead of their publication times. A queued job is not platform-confirmed success.
8. The reference's single 30-second publishing scheduler processes due jobs through conditional claims. It checks delayed YouTube confirmations and reaps stale work at startup and periodically. Jobs retain platform references, owner/checkpoint state and errors; missed work is held rather than published in a burst.
9. YouTube can use API or browser execution. API scheduling sends private visibility plus future publication and verifies the saved result. Browser execution verifies the account, handles an already-loaded Studio page, fills upload details, applies scheduling/timezone controls, commits once and reads back the actual saved result.
10. Native Instagram scheduling uses its browser composer and calendar, not YouTube's API mechanism. Its actual account/session and visible scheduling controls must be eligible. It requires date/time and final calendar confirmation. The reference also contains immediate Instagram Graph API publishing and older timed browser Share behavior; these are distinct paths.
11. Active plans expose Retry, Pause/Resume and Cancel; individual slots expose applicable recovery/reschedule controls. Cancellation cannot undo a platform-confirmed schedule. Platform cells show independent statuses, details, links and applicable retry/confirmation controls. The selected plan itself is the status view; there is no separate Schedule Status screen in the inspected source.
12. The generated-video bulk dialog separately offers **Publish now** and **Schedule** at assigned times, with platform, visibility, engine, preview and skip reasons. Source bulk requests are capped at 50 videos. It is separate from drawing a draft.

## 2. Exact reference components and files

All paths below are relative to RepoReel's `src/`:

| Reference | Role inspected/adapted |
|---|---|
| `components/Studio.tsx`, `app/schedule/page.tsx` | Entry point, authentication and navigation |
| `components/ScheduleBoard.tsx` | Form, draft/active states, slot controls, confirmations and polling |
| `components/SchedulePickers.tsx` | Calendar, month/year and time subdialogs, keyboard/focus behavior |
| `components/GeneratedVideos.tsx`, `app/globals.css` | Gallery, thumbnail choices, bulk dialog, progress and visual rules |
| `lib/pipeline.ts` | Completion boundary and separate automatic-post branch |
| `lib/schedule/service.ts` | `normalizeSettings`, `candidateVideos`, `unavailableVideos`, `createSchedule`, `updateSettings`, `redrawTimes`, `editSlot`, `getScheduleView`, `activateSchedule`, `releaseQueuedPosts`, plan/slot pause/resume/cancel, `rescheduleSlot`, `startSlotNow` |
| `lib/schedule/plan.ts`, `time.ts`, `job-timing.ts` | Seeded draws, wall-clock conversion, spacing/order checks and displayed job timing |
| `lib/schedule/retry.ts`, `reconcile.ts` | Retry eligibility, missed/held jobs and reconciliation |
| `lib/publish/videos.ts`, `video-selection.ts`, `bulk.ts` | Gallery eligibility, ordered selection, `publishSelected` and `scheduleSelected` |
| `lib/publish/scheduler.ts`, `run.ts`, `jobs.ts`, `create-job.ts`, `queue.ts`, `checkpoint.ts`, `duplicate.ts`, `retry-policy.ts` | Queue lifecycle, `processDue`, `runJob`, claims, checkpoints, retries and restart safety |
| `lib/publish/youtube.ts`, `instagram.ts`, `native-schedule.ts` | API/platform distinctions and confirmation contracts |
| `lib/publish/browser/youtube-schedule.ts`, `youtube-finish.ts`, `youtube-settings.ts` | Overlay handling, Studio timezone/date/time controls and saved-result verification |
| `lib/publish/browser/instagram-schedule.ts`, `instagram-calendar.ts`, `instagram-settings.ts`, `instagram-cover.ts`, `instagram-crop.ts`, `instagram-prompts.ts` | Composer eligibility, `enableScheduleContent`, `setReelDate`, `setReelTime`, `judgeReelSchedule`, `pressSchedule`, calendar confirmation and upload controls |

Existing adapted reference tests and the earlier [engine report](publishing-workflow.md) remain part of the evidence. An unauthenticated read of the running reference `/schedule` returned its sign-in page. Its authenticated browser journey was not replayed, and its credentials/sessions were not copied.

## 3. BookReel files changed in this phase

| Files | Change |
|---|---|
| `src/app/schedule/page.tsx`, `schedule.css` | Authenticated full page; scoped reference colors/layout; desktop document scrolling without changing the studio shell |
| `src/components/schedule/ScheduleBoard.tsx`, `SchedulePickers.tsx`, `GeneratedVideos.tsx` | Adapted reference UI and interactions; audience answer, truthful disabled states, persisted selection/configuration, attempt history and bounded 30-second requests |
| `src/components/Sidebar.tsx`, `BookAnalysis.tsx` | Weekly Schedule navigation in expanded/collapsed sidebar and the book workflow |
| `src/app/api/schedule-board/[[...path]]/route.ts` | Owned read/edit/control/bulk/history endpoints over the existing scheduling system |
| `src/lib/schedule/board-types.ts`, `board-read.ts`, `board-store.ts`, `board-publish.ts`, `board-retry.ts`, `video-selection.ts`, `job-timing.ts` | Reference-shaped page contracts, full-grid drafts, gallery, validation, swaps, controls, selection and bulk adaptation |
| `src/lib/schedule/store.ts`, `activate.ts`, `worker.ts`, `confirm.ts`, `reconcile.ts` | Existing queue extended for full grids, visibility, per-slot controls and explicit immediate jobs; missed-job reconciliation and known-upload protection |
| `src/lib/publish/history.ts`, `immediate-queue.ts` | Durable attempt receipts and approved immediate-job processing inside the existing worker; no second timer |
| `src/lib/publish/state.ts` | Shared canonical-asset/readiness measurement so gallery and uploader use the same checks |
| `src/lib/publish/browser/engine.ts`, `browser/run.ts` | Approved queue-origin metadata and attempt recording |
| `src/lib/publish/youtube/publisher.ts`, `youtube/run.ts`, `youtube/upload.ts` | Queue metadata/history and explicit audience answers, preserving the existing private API default |
| `prisma/schema.prisma` | Additive plan name/privacy/grid/activation fields, slot control state and `PublishAttempt` |
| `scripts/migrate-weekly-board.mjs` | Previewable additive migration, database backup and original-record fingerprints |
| `scripts/e2e-weekly-schedule.mjs`, `tests/schedule-board.test.mts` | Isolated browser journey and focused domain/safety regressions |
| `docs/weekly-schedule-audit.md`, this report, `docs/publishing-workflow.md` | Audit/mapping, final evidence and clarification that the older modal report is superseded |

The initial 46 modified tracked files plus untracked earlier implementation were reviewed. Existing generation, engine-selection, analysis, inspector, settings and media changes were retained. The old modal component remains for compatibility but its book entry now navigates to the full page. Build-generated Next type references were refreshed.

The migration backed up the database to `.bookreel/backups/before-weekly-board-1793079423537.db`. Before/after fingerprints match for all original columns of 21 books, 90 uploads, 235 episodes, 386 content ideas, 10 publishing jobs, 2 schedules and 14 slots. No existing status or asset was rewritten by migration. Evidence: `.bookreel/weekly-migration.json`.

## 4. Remaining differences and limits

| Behavior | Current BookReel behavior and exact reason |
|---|---|
| Reference bulk scheduling/Start Now can arm individual draft posts | BookReel requires explicit Activate first. Automatic approval review rejected allowing the worker to publish draft slots because it bypassed the required activation boundary. Bulk Schedule can recover eligible posts in an already active plan. |
| Timed private/unlisted uploads | BookReel waits until the assigned time to begin uploading. It does not reproduce the reference's early upload followed by a browser-held final commit. Public native YouTube scheduling does reproduce upload-ahead/platform-confirmed timing. The nonpublic difference preserves BookReel's existing private-review publisher contract. |
| Immediate YouTube API visibility | API Publish now remains private; public/unlisted immediate posting uses the browser. Public scheduled publication is supported through the existing native API path. |
| Optional Instagram Graph API engine in the reference bulk dialog | Weekly Schedule prepares Instagram's native browser path. It does not expose the reference's optional Graph API bulk engine; BookReel's existing separate Instagram API publishing surface is retained. There are currently no connected API accounts. Full optional API-engine parity is not claimed. |
| Screenshot History/additional-post controls | The inspected `GeneratedVideos.tsx` does not contain those screenshot controls. BookReel provides durable attempt history going forward, but does not fabricate earlier receipts or introduce repeated posts around its existing one-job-per-episode/platform model. |
| Human confirmation | A click alone cannot mark a post successful. Known native YouTube uploads can be checked against platform evidence. Unknown uploads, Instagram uncertainty and legacy outcomes require platform inspection; unsupported automatic confirmation is refused. |
| Historical schedules | Existing version-1 plans stay excluded from automatic processing. Pause/Resume and slot recovery cannot silently turn an unactivated draft or historical plan into a new worker-enabled plan. |
| Final publication versus a saved native schedule | A confirmed future schedule is displayed as scheduled, not published merely because the clock passes its target. Live publication has not been verified. |

There is no new schedule-level channel chooser because the reference has none. BookReel uses its own configured account and retains its explicit made-for-kids question. Per-platform poster overrides are preserved and disclosed. Source-specific repository topics and automatic generation-to-publish behavior were not transplanted into BookReel's generation pipeline.

## 5. Verification results

| Check | Result |
|---|---|
| Relevant publishing/scheduling/reference regression run | **489 passed, 0 failed** across 14 test files |
| Final focused Weekly Schedule run | **21 passed, 0 failed**, including final cancellation and activation-boundary changes |
| Production UI journey | **17 checks passed** with an isolated database, synthetic videos and fresh Chrome context; publishing/activation requests intercepted |
| Standalone `tsc --noEmit` | Passed |
| Lint for touched scheduling/publishing files and new scripts/tests | Passed, no diagnostics |
| Application-wide lint | Still fails on **5 pre-existing errors and 11 warnings**: errors in `EngineSelectorModal.tsx` (3), `EpisodeCard.tsx` (1), `Studio.tsx` (1). Unrelated files were not rewritten to hide these. |
| `next build --webpack` | Passed, including TypeScript and route generation |
| Local smoke check | `/` and `/schedule` return HTTP 200; schedule remains sign-in protected |

The UI check covers scrolling, pagination, calendar/time dialogs, actual IST edits, ordered draft creation, swaps, redraw, settings, preview/history, disabled Instagram, bulk confirmation, reload/reopen persistence, cancelled activation, mocked confirmed statuses, pause/resume and 390px layout without horizontal overflow. Desktop/mobile screenshots were visually reviewed against the supplied reference screenshots.

Artifacts are under `.bookreel/`: `weekly-publishing-tests.log`, `weekly-board-final-tests.log`, `weekly-typecheck.log`, `weekly-focused-lint.log`, `weekly-lint.log`, `weekly-build.log`, and `weekly-ui/results.json` plus screenshots. Tests used `tests/setup/isolated-db.mjs`; they did not use production videos or accounts.

## 6. Remaining YouTube setup

The current configured/default target is **`@betweenpages08-l4d`**. A BookReel YouTube browser profile exists, but profile presence is not proof of a current authenticated channel. No immutable channel ID is configured. OAuth configuration and connected API accounts are absent.

- Confirm that this handle is the intended BookReel channel and sign in through BookReel's existing browser-profile flow if needed. The upload gate must verify the active identity before selecting a file. An immutable `BOOKREEL_YOUTUBE_CHANNEL_ID` can strengthen the configured target.
- To use the API instead, configure BookReel's Google client, redirect URI and token-encryption configuration, then connect BookReel's own account with upload/read-only scopes. No RepoReel token or profile is reusable.
- Inspect the existing **8 YouTube needs-review jobs, 1 failed YouTube job and 1 Instagram needs-review job** before retrying or replacing them. There is no active upload to blindly restart, and these records were not cleared.
- Open Weekly Schedule, choose eligible videos, draw/review the draft, answer the audience question and use a future public schedule. A real Activate action is the operator's authorization to upload; it was not exercised on production data.
- Keep the server awake. Enable `BOOKREEL_SCHEDULE_WORKER_ENABLED=1` only when unattended processing is deliberately wanted; the current local server explicitly runs with it set to `0`.

## 7. Instagram rollout

The native browser composer/calendar workflow, separate platform statuses and configuration are prepared. Actual execution remains disabled through both `BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=0` and `BOOKREEL_IG_NATIVE_SCHEDULE=0`. The background worker is also disabled. Instagram cannot block YouTube activation, scheduling, retries or confirmation.

Before a future explicit enablement, BookReel's own Instagram account must be verified in its own profile and must actually expose eligible native scheduling controls. Missing controls, challenges or uncertain results hold/refuse the post. Optional Graph API bulk-engine parity remains the separate limitation above.

## 8. Tested versus live-platform evidence

Verified: application logic, persisted state transitions, canonical generated-file integration, date/time/order rules, identity/selector/confirmation safeguards against fixtures, native confirmation parsers, retry/duplicate/restart behavior, UI interactions, production build and local serving.

Not verified against live platforms: current signed-in channel/account identity, real upload acceptance, real native scheduling eligibility, or actual publication. **No real video was uploaded, no production schedule was activated, and no real post was published during this work.** No RepoReel credentials, cookies, private account records or browser sessions were copied.

The earlier dashboard investigation had no active reference upload available to identify an exact current blocking call. Historical evidence pointed to final schedule/readback verification, not proof that the dashboard was still loading. Loaded-dashboard continuation, bounded waits and step logs are retained and tested; an exact live blocking step is not invented.
