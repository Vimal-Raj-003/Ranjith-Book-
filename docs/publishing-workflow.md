# RepoReel → BookReel publishing workflow

This records the earlier engine integration. Its smaller-modal UI limitation is superseded by the full-page implementation described in [weekly-schedule-implementation.md](weekly-schedule-implementation.md). See that report for the current UI, remaining parity differences, migration evidence and final verification results.

Reference inspected: `<path-to-reporeel-checkout>`, including its current working-tree source and tests. Only implementation logic and test fixtures were adapted. No reference account configuration, credentials, database records, cookies, or profiles were copied.

## Component mapping

| RepoReel source | BookReel integration |
| --- | --- |
| Generation completion; `publish/videos.ts`, `video-selection.ts`, `video-file.ts` | Existing `pipeline.ts` completion, `BookAnalysis.tsx` finished-video selection, and `publish/state.ts` ownership, metadata, render and thumbnail validation remain the entry point. |
| `schedule/service.ts`, `plan.ts`, `time.ts` | Existing `schedule/store.ts`, `time.ts` and `WeeklySchedule.tsx`; imported pure `plan.ts` and `reference-time.ts` implement seeded windows, strict timezone conversion, ordering and conflict checks. |
| `publish/create-job.ts`, `jobs.ts`, `queue.ts`, `run.ts`, `checkpoint.ts` | Existing `PublishJob` and `ScheduleSlot` rows, extended with frozen payloads, queue status, progress, heartbeat, owner PID, retry time and remote-draft checkpoint. No second job store. |
| `publish/scheduler.ts`, `schedule/reconcile.ts`, `retry.ts`, `publish/retry-policy.ts` | One `schedule/worker.ts` startup worker, existing `activate.ts` queue runner, `confirm.ts` read-only reconciliation, browser restart recovery and resumable API recovery. `due.ts` is now a compatibility entry point to this same runner. |
| `publish/youtube.ts`, `native-schedule.ts`, browser `youtube.ts`, `youtube-schedule.ts`, `youtube-finish.ts`, `youtube-settings.ts` | Existing BookReel OAuth/resumable API adapter gains native scheduling. Existing browser adapter uses the imported schedule, upload-completion and settings controls through `native-controls.ts`. BookReel retains its strict channel gate and own browser lifecycle. |
| Browser `instagram.ts`, `instagram-calendar.ts`, `instagram-schedule.ts`, crop/cover/settings/prompts helpers | `native-instagram.ts` composes those controls after BookReel's account verification. Existing immediate Graph API/browser paths remain available behind the Instagram execution gate. |
| Reference platform and planner tests | `tests/reference-*.test.mts`, plus BookReel queue, browser, API, identity, generation and UI regression tests. |

## Execution sequence

1. BookReel's existing generation pipeline records a completed render and metadata. `BookAnalysis` offers finished episodes to Weekly Schedule. Save and activation independently enforce ownership and usable generated assets.
2. Save a draft with the ordered episode IDs, timezone, fixed times or seeded windows, platform selection, Instagram offset and explicit YouTube audience answer. Client preview and server expansion use the same pure planner. Nonexistent DST times are rejected. Activation checks future lead time, ordering, a 30-minute minimum gap (RepoReel's default 20-minute preparation lead plus 10), and other active/paused plans.
3. Activation freezes each approved platform payload, reserves videos, and creates ordinary `QUEUED` jobs transactionally. YouTube chooses BookReel's connected API when available, otherwise BookReel's browser route. A failure never silently changes engines. Native uploads start ahead of publication time on both platforms.
4. Separate platform lanes claim slots and jobs conditionally. A platform failure does not stop the other lane. Disabled Instagram does not contribute readiness, timing or reservation failures to YouTube activation.
5. **YouTube API:** verify the live BookReel channel; create or resume the encrypted upload session; send private + exact `publishAt` + the saved audience answer; upload thumbnail; accept scheduling only from the platform's exact timestamp receipt. A missing receipt retains the known video ID and requires review.
6. **YouTube browser:** open or reuse the loaded Studio dashboard → verify BookReel's exact configured channel ID or handle → inspect a known prior draft before retry → Create/Upload → persist an uncertainty marker before selecting the file → fill and read back approved metadata, thumbnail, audience and tags → configured BookReel details → Visibility/Schedule → resolve and verify Studio's timezone/date/time → wait for upload completion → press Schedule once → read the saved video's title and exact publication time. Only confirmed readback becomes `SCHEDULED`.
7. **Instagram browser:** verify BookReel's active handle → inspect open drafts and the complete scheduled-content calendar → adopt an exact existing receipt or refuse conflicts → checkpoint before file selection → original crop and cover → full caption and offered AI label → require the eligible account's native Schedule control → set and read date/time → press **Schedule** once → verify caption, account user ID, remote ID and UTC timestamp in the calendar. Missing or differing confirmation remains uncertain. A scheduled request never falls back to Share.
8. Progress and heartbeat are persisted. Browser actions default to 15 seconds, navigation to 45 seconds; specific upload/processing controls have explicit longer limits. The whole browser job has a 45-minute watchdog. API requests and queue settlement are bounded. Failures identify the step and preserve the checkpoint.
9. Restart recovery distinguishes live owners from interrupted jobs. A durable API session is probed before bytes resume; a missing/dead/unreadable native session cannot authorize a replacement upload. Transient API failures with durable sessions get bounded 1/5/15-minute retries. Browser uncertainty is held for an acknowledged inspection. Every ten minutes the enabled worker can verify up to four known YouTube IDs using read-only checks; it skips windows owned by a person or another job. It never selects a file during confirmation.
10. Pause/cancel stops remaining local queue work. It does not undo a schedule already held by a platform. Resume and retry revalidate unfinished enabled slots. Known posted/scheduled IDs and conditional claims prevent duplicate uploads. Native jobs that have become too late are refused, never published late as an immediate fallback.

## Runtime configuration and preserved data

- `BOOKREEL_SCHEDULE_WORKER_ENABLED=0` during debugging. Explicitly set `1` for startup/30-second background recovery after reviewing plans. An explicit Activate action still starts its approved queue immediately.
- `BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=0` and `BOOKREEL_IG_NATIVE_SCHEDULE=0` remain off. Instagram publishing must be explicitly enabled by the operator. Native browser scheduling also requires its own flag and an eligible logged-in account.
- Historical schedules keep `workflowVersion=1`; the new background worker only processes version 2 plans explicitly activated through the new validation.
- Existing BookReel OAuth tokens, handle configuration, CDP endpoint and persistent browser-profile paths are retained. No account switch, credential migration or cookie copying was added.
- Optional Studio detail settings use only `BOOKREEL_YOUTUBE_VIDEO_LANGUAGE`, `BOOKREEL_YOUTUBE_VIDEO_CATEGORY`, `BOOKREEL_YOUTUBE_VIDEO_LOCATION`, and `BOOKREEL_YOUTUBE_AI_DISCLOSURE`. Unset values preserve existing defaults. RepoReel's channel-specific metadata defaults are not inherited.
- Run `node --import tsx scripts/upgrade-publishing-workflow.mts` for a schema preview, or add `--apply` for the additive SQLite upgrade. The script first makes a local database backup and never activates schedules.

## Boundaries and verification

Tests use isolated databases, fake account tokens, scripted browser pages and intercepted local Chromium fixtures. No real video was uploaded, published or scheduled while implementing this workflow. The unchanged generation and metadata tests verify the existing generation boundary; scheduling tests verify selected generated files and approved metadata reach the persisted queue.

The implementation and fixtures cannot establish live Google API project audit eligibility, Instagram's account-specific native-scheduling eligibility, session freshness, or a platform's current production DOM. Those require an explicitly authorized account check or real publication trial. In particular, an API upload can remain private without a `publishAt`; this is recorded as uncertain rather than claimed as scheduled.

BookReel retains its existing one-job-per-episode/platform model and explicit audience answer. RepoReel's repository-content selection, repository URL matching, account defaults, randomized interaction helpers, legacy timed immediate publishing, and broader job-history UI are not transplanted. These either depend on RepoReel's content/schema or would change BookReel's established publishing contract. Native scheduling, shared queue execution, confirmation, safe retries and restart recovery are adapted to BookReel's existing rows instead.

There was no active RepoReel upload job/browser wait available to inspect at the initial process/job check. Historical evidence showed a run reaching the final scheduling/readback stage and failing to verify the saved date/time; it did not establish that a dashboard was still loading. An exact current blocking call therefore cannot be claimed. The new loaded-dashboard and timeout tests reproduce that distinction without restarting or repeating a live upload.

## Completed verification

- Reference control/planner and watchdog/channel-gate suite: 136 passed.
- Schedule/API recovery regression run: 112 passed.
- Broader publishing run: 427 tests; 415 initially passed. Its 12 failures were outdated expectations for the new queue status, pure planner imports, Instagram execution gate and quick-publish wording. All affected files were corrected and rerun together with book-analysis tests: 186 passed, zero failures. The new conflict, disabled-platform reservation and read-only confirmation tests also passed in the broader run.
- Existing pipeline-stage and metadata-generation tests passed in the initial regression run. No generation implementation was changed by this integration.
- `npx tsc --noEmit`: passed.
- ESLint on changed workflow modules and the route compatibility fix: passed with zero errors or warnings.
- `node node_modules/next/dist/bin/next build --webpack`: passed. A pre-existing invalid named export in the ideas route was moved unchanged into `src/lib/ideas-selection.ts`; its existing test now imports the library module.
- Local production server: `http://127.0.0.1:3001/` returned HTTP 200 with BookReel content; unauthenticated `/api/schedules` returned HTTP 401.
- Local database upgrade backed up to `.bookreel/backups/before-publishing-workflow-1793025292230.db`. Post-upgrade counts exactly match inspection: YouTube 8 `AWAITING_HUMAN` + 1 `FAILED`, Instagram 1 `AWAITING_HUMAN`, and 2 historical active version-1 schedules. None were activated or retried.

Additional changed integration files include `prisma/schema.prisma`, `.env.example`, `src/instrumentation.ts`, `src/app/api/schedules/[id]/control/route.ts`, `src/lib/publish/execution.ts`, `src/lib/publish/contract.ts`, `src/lib/publish/limits.ts`, `src/lib/publish/registry.ts`, the existing Instagram execution entry points, `src/lib/strings.ts`, and the isolated test database builder. Generated Next route type references were refreshed by the build. Pre-existing unrelated working-tree changes were retained.
