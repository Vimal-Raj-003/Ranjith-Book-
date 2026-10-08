/**
 * What each platform will and will not accept, and the vocabulary the whole
 * publish surface speaks.
 *
 * This module has NO imports and must keep it that way: `PublishCenter` is a
 * `"use client"` component and imports it directly, so anything pulled in here
 * lands in the browser bundle — the trap `tests/client-ui.test.mts` guards and
 * that this codebase has already paid a 500 for once. Everything in here is
 * pure string and number handling, which is why that costs nothing.
 *
 * The numbers are the platforms' documented ceilings as of this workstream.
 * They are stated as data, in one place, rather than spelled into a component,
 * so correcting one when a platform moves it is a one-line change that every
 * reader picks up. What is DELIBERATELY ABSENT is as important: there is no
 * duration ceiling per platform here, because this build has no connection to
 * either platform and so no way to confirm what theirs currently is. An
 * invented limit that refused a good video, or admitted a bad one, would be
 * worse than the honest silence — see the report's list of what a real
 * integration still has to establish.
 */

/** The platforms the Publish Center shows. `manual` is not one — see `contract.ts`. */
export const PLATFORM_IDS = ["youtube", "instagram"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

/**
 * Where one episode stands on one platform.
 *
 * The order is the lifecycle, and the gap between the first three and the rest
 * is the point of the vocabulary:
 *
 *  - `NOT_READY` — the episode itself is not finished or is missing something
 *    (`readiness.ts` says exactly what). Nothing may be attempted.
 *  - `READY` — the episode would pass, and a configured publisher exists.
 *  - `REQUIRES_CONNECTION` — the episode would pass, but nothing is connected,
 *    so the only thing on offer is the assisted handoff. This is the state
 *    every row in this build is in, and it says so plainly rather than dressing
 *    itself up as progress.
 *  - `PREPARING` / `UPLOADING` — work is genuinely in flight. Nothing in this
 *    build can set either, because nothing in this build uploads; they exist so
 *    the platform workstreams do not have to widen the vocabulary (and so a
 *    reader written now already handles them).
 *  - `PUBLISHED` — the platform confirmed it, and `externalId` holds the id it
 *    returned. There is no other way to reach this value: see `PublishOutcome`.
 *  - `FAILED` — an attempt was made and the platform or the transport refused.
 */
export const PUBLISH_STATUSES = [
  "NOT_READY",
  "READY",
  "REQUIRES_CONNECTION",
  "PREPARING",
  "UPLOADING",
  "PUBLISHED",
  "FAILED",
] as const;

export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export function isPublishStatus(value: unknown): value is PublishStatus {
  return typeof value === "string" && (PUBLISH_STATUSES as readonly string[]).includes(value);
}

/**
 * The statuses that are in-flight work. A reader may show a spinner for these
 * and for nothing else — which is why the list is here rather than being a
 * condition re-derived in a component, where "and also REQUIRES_CONNECTION,
 * probably" is one careless edit away.
 */
export function isInFlight(status: PublishStatus): boolean {
  return status === "PREPARING" || status === "UPLOADING";
}

/** The one status that claims a platform has the video. Nothing else may imply it. */
export function isPublished(status: PublishStatus): boolean {
  return status === "PUBLISHED";
}

export interface PlatformLimits {
  /** Characters allowed in the title field, or null where the platform has no separate title. */
  title: number | null;
  /** Characters allowed in the long text field — YouTube's description, Instagram's caption. */
  body: number;
  /** The most hashtags the platform counts. Beyond it they are ignored or the post is refused. */
  hashtags: number;
}

/**
 * YouTube: a 100-character title and a 5,000-character description.
 * Instagram: no title at all — the caption is the only text field, 2,200
 * characters, and at most 30 hashtags counted anywhere in it.
 */
export const PLATFORM_LIMITS: Record<PlatformId, PlatformLimits> = {
  youtube: { title: 100, body: 5000, hashtags: 60 },
  instagram: { title: null, body: 2200, hashtags: 30 },
};

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
};

/**
 * Where the operator finishes the job by hand, with no connection configured.
 *
 * These are the platforms' own upload surfaces and nothing else. They are
 * opened in a new tab for the operator to use themselves: this app never drives
 * them, never fills them in and never sees a password. Automating either one
 * means scraping a logged-in session, which is both against those platforms'
 * terms and a credential hazard — the official APIs are the only honest route
 * and they are a later workstream.
 */
export const PLATFORM_STUDIO_URL: Record<PlatformId, string> = {
  youtube: "https://studio.youtube.com/channel/UC/videos/upload",
  instagram: "https://www.instagram.com/",
};

/** What a real connection to each platform will need, named so the state is explicable. */
export const PLATFORM_REQUIREMENTS: Record<PlatformId, string[]> = {
  youtube: [
    "A Google Cloud project with the YouTube Data API v3 enabled",
    "An OAuth client, and a one-time consent granting youtube.upload",
  ],
  instagram: [
    "An Instagram professional account linked to a Facebook Page",
    "A Meta app with the Instagram Content Publishing API and a long-lived token",
    "A publicly reachable URL for the video file — the API fetches it rather than accepting an upload",
  ],
};

/**
 * A video shorter than this is not a video — it is a render that went wrong and
 * produced a frame or two. Longer than this and `durationSec` is not describing
 * a vertical short at all, which means something upstream mis-measured.
 *
 * Deliberately WIDE. An earlier draft of this check used the writer's own
 * ceiling (`VIDEO_MAX_SECONDS`, 90 s), and the first finished episode in the
 * operator's library is 116.22 s — a perfectly good video that a 90 s gate
 * would have called NOT_READY. The writing target and "is this file a plausible
 * video" are different questions, and only the second one belongs in a
 * readiness check.
 */
export const SANE_DURATION = { min: 3, max: 1800 } as const;

/** Trim, drop blanks, and put back the `#` a hand-typed tag may be missing. */
export function normaliseHashtags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().replace(/^#+/, "");
    if (trimmed === "") continue;
    const tag = `#${trimmed}`;
    // Case-insensitively unique: "#Focus" and "#focus" are one tag to both
    // platforms, and a list that shows both has silently wasted one of the
    // thirty Instagram counts.
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** The one-line form the operator copies and both platforms accept. */
export function hashtagLine(hashtags: string[]): string {
  return normaliseHashtags(hashtags).join(" ");
}

/** The episode metadata every platform variant is derived from. */
export interface PublishMetadata {
  title: string;
  description: string;
  hashtags: string[];
  /** The spoken opening line. Instagram's caption leads with it; YouTube does not use it. */
  hook: string;
}

/**
 * Instagram has no title field, so its caption is the hook, the description and
 * the hashtags in one block.
 *
 * This composition is byte-for-byte the one `PublishPanel` has always used
 * (`[hook, description, hashtags].filter(Boolean).join("\n\n")`), moved here
 * unchanged. An operator who has been pasting that text for months must get the
 * same text out of the new surface, so this is the one piece of the old panel
 * that was not allowed to be improved while it was being moved.
 */
export function instagramCaption(meta: PublishMetadata): string {
  return [meta.hook, meta.description, hashtagLine(meta.hashtags)].filter(Boolean).join("\n\n");
}

export type VariantFieldKey = "title" | "description" | "caption" | "hashtags";

/**
 * One text field as one platform will receive it, with the measurement beside
 * it. `over` is computed here rather than by the reader so the number shown and
 * the verdict given can never disagree.
 */
export interface VariantField {
  key: VariantFieldKey;
  label: string;
  value: string;
  /** Characters in `value`, and the platform's ceiling (null = no documented ceiling). */
  length: number;
  limit: number | null;
  /** Items and their ceiling. Only set for `hashtags`. */
  count?: number;
  countLimit?: number;
  over: boolean;
}

function textField(key: VariantFieldKey, label: string, value: string, limit: number | null): VariantField {
  const length = [...value].length; // code points, so an emoji counts once
  return { key, label, value, length, limit, over: limit !== null && length > limit };
}

function tagField(label: string, hashtags: string[], limit: number): VariantField {
  const tags = normaliseHashtags(hashtags);
  const value = tags.join(" ");
  return {
    key: "hashtags",
    label,
    value,
    length: [...value].length,
    limit: null,
    count: tags.length,
    countLimit: limit,
    over: tags.length > limit,
  };
}

/**
 * The metadata shaped for one platform, measured against that platform's own
 * limits.
 *
 * Nothing is truncated. A title of 140 characters comes back whole, with
 * `over: true` and both numbers, because silently cutting an operator's words
 * at 100 and calling it success is the kind of quiet lie this surface exists
 * not to tell — and because the operator may want to edit which 100 characters
 * survive rather than take the first 100.
 */
export function variantFor(platform: PlatformId, meta: PublishMetadata): VariantField[] {
  const limits = PLATFORM_LIMITS[platform];
  if (platform === "instagram") {
    return [
      textField("caption", "Instagram caption", instagramCaption(meta), limits.body),
      tagField("Hashtags", meta.hashtags, limits.hashtags),
    ];
  }
  return [
    textField("title", "YouTube title", meta.title, limits.title),
    textField("description", "YouTube description", meta.description, limits.body),
    tagField("Hashtags", meta.hashtags, limits.hashtags),
  ];
}

/** Every field of this variant that is over a limit. Empty means it fits. */
export function variantProblems(platform: PlatformId, meta: PublishMetadata): string[] {
  return variantFor(platform, meta)
    .filter((f) => f.over)
    .map((f) =>
      f.countLimit !== undefined
        ? `${f.label}: ${f.count} tags, ${f.countLimit} is the most ${PLATFORM_LABELS[platform]} counts`
        : `${f.label}: ${f.length} characters, ${PLATFORM_LABELS[platform]} allows ${f.limit}`,
    );
}

/**
 * The hard caps on what the metadata editor will store.
 *
 * Above every platform ceiling on purpose — the editor is not the place to
 * enforce YouTube's 100 characters, because an operator drafting a title should
 * be able to type 130 and then cut it while seeing the counter go red. These
 * are only there so a pasted megabyte never reaches the database.
 */
export const FIELD_MAX = { title: 300, description: 10_000, hashtags: 60 } as const;
