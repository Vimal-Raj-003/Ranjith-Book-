# Weekly Schedule automation repair — 27 October 2026

## Finding and scope

The current failure is after channel verification and after file selection, not a dashboard-loading problem. `.bookreel/channel-config-server.log` records successful verification of `UCRYJBrMBdtXHa5rYFbmV_iA`, upload/details steps, and the scheduling timezone `(GMT+0530) Local Time`. It then records `tp-yt-iron-overlay-backdrop` intercepting date/time clicks. Studio still displayed `00:00` instead of the requested `05:39`.

The existing job `cmvqd69x3001hn6zgjkusa59t` for “The 8-8-8 Rule for Designing Your Day” is `AWAITING_HUMAN`, with checkpoint `youtube-upload-unconfirmed`, no external video ID and no confirmed scheduled time. A private unfinished upload may exist. This repair does not retry, delete, clear or reinterpret that checkpoint. Later jobs in its YouTube lane wait because the first job requires review.

## Reference inspected

Source root: `<path-to-reporeel-checkout>`. Only source was inspected; no reference credentials or browser profiles were copied.

| RepoReel source | BookReel implementation retained |
| --- | --- |
| `src/components/ScheduleBoard.tsx`, schedule pickers and GeneratedVideos | `src/components/schedule/ScheduleBoard.tsx`, existing board/selection controls |
| `src/lib/schedule/service.ts` (`activateSchedule`), plan/time/job-timing | `src/lib/schedule/board-store.ts`, `store.ts`, reference plan/time modules |
| `src/lib/publish/scheduler.ts`, schedule retry/reconcile | `src/lib/schedule/activate.ts`, `worker.ts`, `board-publish.ts`, existing job/recovery helpers |
| `src/lib/publish/youtube.ts` | `src/lib/publish/youtube/accounts.ts`, `upload.ts`, `publisher.ts`, `run.ts` |
| `src/lib/publish/browser/youtube.ts`, `youtube-schedule.ts`, `youtube-finish.ts`, `schedule-retry.ts` | Existing browser orchestration, `youtube-schedule.ts`, `youtube-finish.ts`, `native-controls.ts`, checkpoint/recovery rules |
| `src/lib/publish/browser/instagram.ts`, scheduling/calendar/settings helpers | `instagram.ts`, `native-instagram.ts`, existing Instagram scheduling/calendar/settings helpers |

The reference opens Schedule, reads Studio's timezone, sets and verifies date/time, waits for upload/checks, presses Schedule once, then reads back the saved video. BookReel already had that sequence; it was not intentionally handing the final click to a person. Both copies of the scheduling helper checked `.dialog-scrim`, which misses the current Polymer backdrop shown by the live failure. Copying the reference unchanged would retain this bug.

The existing end-to-end architecture remains: generated-video eligibility → ordered selection and IST slots → persisted draft → explicit activation and immutable upload snapshots → persistent per-platform jobs → independent queue lanes → account verification → upload/native scheduling → exact platform confirmation → stored receipt/status. API-ready public YouTube schedules use private uploads with `publishAt`; otherwise they use Studio. Retry and restart paths preserve known receipts and hold uncertain uploads instead of creating duplicates. No second scheduler was added.

## Changes in this repair

1. `src/lib/publish/browser/youtube-schedule.ts`: recognize visible Polymer backdrops as well as legacy scrims; dismiss a nested picker only when it covers upload controls; preserve the upload dialog's own background; stop with an actionable error after four unsuccessful Escape attempts. Clean up an unrecognized timezone popup and refuse to edit/submit scheduling fields without a verified timezone.
2. `src/lib/publish/browser/youtube.ts`: capture modern Shorts/watch/video links inside the current upload dialog, excluding dashboard videos; persist the draft ID again before scheduling controls run. Existing final Schedule, confirmation, audience, metadata and account verification behavior remains intact.
3. `tests/reference-youtube-schedule-scrim.test.mts`: real-browser Polymer overlay, background preservation and bounded-failure regressions.
4. `tests/youtube-studio-workflow.test.mts`: intercepted Studio fixture exercising the production publisher and controls, including automatic date/time entry, final Schedule click, exact saved-time confirmation, wrong-time rejection, unknown-zone hold and known-draft resume without selecting a file again. All requests are fulfilled locally.
5. `tests/schedule-board.test.mts`: isolated activation prefers a configured, connected API account; every selected slot gets the exact native scheduled receipt; another queue pass does not upload again; disabled Instagram does not block YouTube.
6. This report.

## Verification and operational state

- 351 relevant tests passed, zero failures/skips: board, schedule, browser/API publishing, account safety, reference date/time/Instagram controls, recovery and the new Studio fixtures. Command and output: `.bookreel/scheduling-fix-tests.log`.
- `npx.cmd tsc --noEmit` passed.
- ESLint passed for all five changed source/test files. Repository-wide `npm.cmd run lint` failed with 98 errors and 2,888 warnings in other files, including stored browser-extension sources that the current lint command scans; full output is `.bookreel/scheduling-fix-lint.log`. No unrelated lint fixes were made.
- Production build passed: `node ../../node_modules/next/dist/bin/next build --webpack`, run from an isolated same-drive source copy with an empty test database and publishing disabled, preserving the live server's `.next` output. Its result is recorded in `.bookreel/scheduling-fix-build.log`. An initial cross-drive temporary copy failed Windows module resolution; the same-drive build resolved that environment issue without changing application code.

These are fixture/mock confirmations, not new real-platform scheduling confirmations. No live schedule was activated or retried and no real file was uploaded during this repair. The running server is not restarted by these checks.

The before/after read-only fingerprint matches for the complete schedule, slot and publishing-job records plus episode IDs/statuses/update times: 1 schedule, 6 slots, 16 jobs, 235 episodes; SHA-256 `6085ed7f97342096d093ee3525a12e177fc3a706b279a51e41441c1f6655af02`. Both temporary build copies were removed after verification; the original server build was retained.

## Requirements before real use

- The project-root `.env.local` already contains `BOOKREEL_YOUTUBE_CHANNEL_ID="UCRYJBrMBdtXHa5rYFbmV_iA"`, the intended Between Pages channel. The browser verifies that ID before choosing a file and keeps BookReel's own persistent session.
- This install currently has no connected YouTube API account. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` and `BOOKREEL_TOKEN_KEY` are missing. For the optional preferred API route, configure those locally, register the matching `/api/publish/youtube/callback` URL for port 3001, and connect the intended channel with upload and readonly scopes. Do not reuse RepoReel's tokens or encryption key. Platform permissions/quota/restrictions still have to allow native scheduled publishing. The browser route does not require this API setup.
- Retain the explicit audience answer and public schedule visibility for native YouTube scheduled publication. Private/unlisted workflows retain their existing behavior.
- Review the already-uploaded private draft in Studio before attempting any recovery of the held job. Its actual video ID was not captured by the old code, so automatic retry remains deliberately blocked. The repair cannot retroactively prove that draft's identity or scheduled status.
- Deploy the source with the normal production build and restart BookReel on port 3001 to load the fix. This verification build intentionally does not replace the running application's output or restart it.
- `BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=0` and `BOOKREEL_IG_NATIVE_SCHEDULE=0` remain unchanged. The existing native Instagram account checks, caption/cover/crop, schedule controls and calendar confirmation remain prepared and tested. The real account and native scheduling eligibility have not been verified here; explicit enablement is still required. Instagram's disabled lane never blocks YouTube.
- `BOOKREEL_SCHEDULE_WORKER_ENABLED=0` remains unchanged. Explicit activation handles the selected jobs through the existing queue; automatic background/restart execution is not enabled by this repair.
