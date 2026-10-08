/**
 * The assisted handoff: the only publisher this build ships.
 *
 * It does exactly what an operator with no API connection does by hand —
 * download the video, download the poster, copy the three pieces of text, open
 * the platform — except that it validates the metadata against that platform's
 * real limits first, and records what was handed over and when.
 *
 * WHAT IT DOES NOT DO, and why that is deliberate rather than unfinished:
 *
 *  - It never signs in. It collects no Google or Meta password, stores none,
 *    types none into anything, and transmits none. The `open` step is an
 *    ordinary link to the platform's own page; what happens there happens in
 *    the operator's browser, under the operator's own session.
 *  - It never drives a page. There is no automation of YouTube Studio or
 *    Instagram here — no scripted clicks, no DOM, no scraping. Both platforms
 *    forbid it and it would mean holding a logged-in session this app has no
 *    business holding. The official APIs are the only route, and they are a
 *    later workstream.
 *  - It never reports success. `publish()` returns `REQUIRES_CONNECTION`, every
 *    time, by construction: `PublishOutcome`'s PUBLISHED variant needs an
 *    `externalId` from the platform and this provider has no platform to get
 *    one from. The honest record of a handoff is "the operator was given the
 *    files and the text at this time", and that is exactly what it writes.
 *
 * It is `capabilities().canUpload === false`, which is what every reader above
 * it keys off to decide between offering a Publish button and offering the
 * handoff. Nothing here is marked as working that is not working.
 */
import {
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  PLATFORM_REQUIREMENTS,
  PLATFORM_STUDIO_URL,
  hashtagLine,
  instagramCaption,
  variantProblems,
  type PlatformId,
} from "./limits";
import {
  PublishRefused,
  type HandoffStep,
  type PlatformCapabilities,
  type PreparedPublish,
  type PublishOutcome,
  type PublishRequest,
  type PublishValidation,
  type Publisher,
} from "./contract";

/**
 * The steps, in the order an operator actually performs them: get the files,
 * then the text, then go.
 *
 * Instagram gets ONE copy step rather than three, because its caption is one
 * field — offering "copy title" for a platform with no title field would be a
 * control that does nothing useful, which is the thing this surface is not
 * allowed to have.
 *
 * EXPORTED, because the YouTube provider reuses it verbatim rather than writing
 * a second set of steps. An install with no Google credentials, and an install
 * with credentials but nothing connected, must both still offer the operator
 * exactly the handoff they had before the integration existed — and the only
 * way to guarantee "exactly" is for it to be the same function.
 */
export function handoffSteps(platform: PlatformId, request: PublishRequest): HandoffStep[] {
  const steps: HandoffStep[] = [
    { kind: "download", label: "Download video", href: request.video.url },
  ];
  if (request.poster) {
    steps.push({ kind: "download", label: "Download selected poster", href: request.poster.url });
  }

  if (platform === "instagram") {
    steps.push({ kind: "copy", label: "Copy caption", text: instagramCaption(request.metadata) });
  } else {
    steps.push({ kind: "copy", label: "Copy title", text: request.metadata.title });
    steps.push({ kind: "copy", label: "Copy description", text: request.metadata.description });
  }
  steps.push({ kind: "copy", label: "Copy hashtags", text: hashtagLine(request.metadata.hashtags) });

  steps.push({
    kind: "open",
    label: platform === "youtube" ? "Open YouTube Studio" : "Open Instagram",
    href: PLATFORM_STUDIO_URL[platform],
    external: true,
  });
  return steps;
}

export function manualHandoff(platform: PlatformId): Publisher {
  const capabilities = (): PlatformCapabilities => ({
    id: platform,
    label: PLATFORM_LABELS[platform],
    // All four false, and all four true facts. This provider hands work to a
    // person; it cannot do any of these itself.
    canUpload: false,
    canSetThumbnail: false,
    canSchedule: false,
    canReportBack: false,
    limits: PLATFORM_LIMITS[platform],
    requires: PLATFORM_REQUIREMENTS[platform],
  });

  const validate = (request: PublishRequest): PublishValidation => {
    const problems: string[] = [];
    // The handoff cannot hand over a file that is not there.
    if (request.video.bytes === 0) problems.push("The rendered video is empty, so there is nothing to hand over.");
    if (!request.poster) {
      problems.push(`${PLATFORM_LABELS[platform]} needs a thumbnail, and this episode has no poster to download.`);
    }
    // The platform's own limits. Same function the UI shows the counters from,
    // so the refusal and the red number can never disagree.
    problems.push(...variantProblems(platform, request.metadata));
    return { ok: problems.length === 0, problems };
  };

  return {
    capabilities,
    /**
     * Always true. A handoff needs no credentials — the operator already has
     * the only account involved. This is NOT the platform being configured:
     * `state.ts` keeps those two apart, and a platform with no real publisher
     * is reported as REQUIRES_CONNECTION however available the handoff is.
     */
    isConfigured: async () => true,
    validate,
    prepare: async (request) => {
      const verdict = validate(request);
      if (!verdict.ok) throw new PublishRefused(verdict.problems);
      return {
        platform,
        episodeId: request.episodeId,
        metadata: request.metadata,
        video: request.video,
        poster: request.poster,
        preparedAt: new Date(),
        // Not READY: nothing is connected, and a state that said READY would
        // read as "press the button and it goes out".
        status: "REQUIRES_CONNECTION",
        handoff: handoffSteps(platform, request),
      } satisfies PreparedPublish;
    },
    /**
     * There is nothing to publish TO, and saying so is the whole job.
     *
     * The return type is why this is safe rather than merely well-behaved: the
     * PUBLISHED variant requires an `externalId` this function has no way to
     * obtain, so no edit to this body can make it claim a post happened.
     */
    publish: async (): Promise<PublishOutcome> => ({
      status: "REQUIRES_CONNECTION",
      error:
        `Nothing is connected to ${PLATFORM_LABELS[platform]}, so this app cannot post for you. ` +
        "The video, the poster and the text are ready to hand over — finish it in the platform's own uploader.",
    }),
  };
}
