/**
 * Everything the Publish Center is told, assembled on the server.
 *
 * This lives outside the route handlers for the same reason `listEpisodes` and
 * `editPoster` do: the routes' other job is `currentUser()`, which reads
 * `cookies()` and cannot run outside a request, so the part worth testing stays
 * here and the handler is five lines.
 *
 * It is also the only module that touches both the database and the disk, which
 * is on purpose. `readiness.ts` is pure and `limits.ts` is pure; the `stat()`
 * calls that make "the render is actually there" a measured fact rather than a
 * stored belief all happen here, and are handed into the pure function as
 * booleans.
 *
 * VISIBILITY. Every entry point goes through `visibleTo`/`canSee` from
 * `episodes/visibility.ts` — not a hand-rolled `where: { userId }`, which is
 * exactly the drift that produced the poster 404s. Note what that module says
 * about DESTRUCTIVE or externally visible writes: they do not get to inherit
 * its generosity about ownerless episodes. Nothing here is externally visible —
 * reading state, editing this app's own metadata columns, and recording that a
 * handoff happened are all local and reversible. The moment a provider can
 * actually post to a platform under someone's account, THAT entry point needs
 * its own ownership rule, and the report says so.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma, assertModels } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { RENDER_DIR } from "@/lib/paths";
import { visibleTo } from "@/lib/episodes/visibility";
import { pickPoster, pickPosterFor } from "@/lib/thumbnails/choose";
import { thumbUrl } from "@/lib/thumbnails/url";
import { parseThumbnails } from "@/lib/thumbnails/store";
import { THUMBS_ROOT } from "@/lib/thumbnails/types";
import {
  FIELD_MAX,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  normaliseHashtags,
  normaliseTags,
  variantFor,
  type PlatformId,
  type PublishMetadata,
  type PublishStatus,
} from "./limits";
import { checkReadiness, type ReadinessInput } from "./readiness";
import { hasRealPublisher, publisherFor, type PublisherContext } from "./registry";
import { studioUrlFor } from "./youtube/config";
import type { AssetRef, HandoffStep, PublishRequest } from "./contract";
import { isPublishRefused } from "./contract";
// The wire shape, imported rather than restated, so the compiler is what keeps
// this module and the browser in step. See `view.ts` for why it is separate.
import {
  isMetadataField,
  platformStatus,
  type MetadataField,
  type PlatformState,
  type PublicThumb,
  type PublishJobView,
  type PublishView,
} from "./view";

export { METADATA_FIELDS, isMetadataField, platformStatus } from "./view";
export type { MetadataField, MetadataEdits, PlatformState, PublishJobView, PublishView } from "./view";

/**
 * How one editable field maps to the columns that store it. One table drives
 * save, regenerate and the hand-edited check, so "which column, what cap, is it
 * a list?" is answered once rather than in three places that can disagree.
 *
 * `max` is a character cap for prose and an item cap for a list (the `normalise`
 * is what marks the difference). The caps are `FIELD_MAX`, which sits above
 * every platform ceiling on purpose — the editor lets the operator overrun and
 * cut while the counter goes red; it is only here to stop a pasted megabyte
 * reaching the database.
 */
interface FieldSpec {
  column: "title" | "description" | "hashtags" | "youtubeTags" | "igHook" | "igCaption" | "igHashtags";
  editedAt:
    | "titleEditedAt"
    | "descriptionEditedAt"
    | "hashtagsEditedAt"
    | "youtubeTagsEditedAt"
    | "igHookEditedAt"
    | "igCaptionEditedAt"
    | "igHashtagsEditedAt";
  max: number;
  /** A human name for the refusal message. */
  label: string;
  /** Present only for a list field; absent means prose. */
  normalise?: (raw: unknown) => string[];
}

const FIELD_SPECS: Record<MetadataField, FieldSpec> = {
  title: { column: "title", editedAt: "titleEditedAt", max: FIELD_MAX.title, label: "title" },
  description: { column: "description", editedAt: "descriptionEditedAt", max: FIELD_MAX.description, label: "description" },
  igHook: { column: "igHook", editedAt: "igHookEditedAt", max: FIELD_MAX.igHook, label: "Instagram hook" },
  igCaption: { column: "igCaption", editedAt: "igCaptionEditedAt", max: FIELD_MAX.igCaption, label: "Instagram caption" },
  hashtags: { column: "hashtags", editedAt: "hashtagsEditedAt", max: FIELD_MAX.hashtags, label: "hashtags", normalise: normaliseHashtags },
  igHashtags: { column: "igHashtags", editedAt: "igHashtagsEditedAt", max: FIELD_MAX.igHashtags, label: "Instagram hashtags", normalise: normaliseHashtags },
  tags: { column: "youtubeTags", editedAt: "youtubeTagsEditedAt", max: FIELD_MAX.tags, label: "tags", normalise: normaliseTags },
};

/** The two per-platform cover-choice keys the publish PUT accepts beside the metadata fields. */
const THUMB_CHOICE_KEYS = ["thumbChoiceYouTube", "thumbChoiceInstagram"] as const;
type ThumbChoiceKey = (typeof THUMB_CHOICE_KEYS)[number];
function isThumbChoiceKey(k: string): k is ThumbChoiceKey {
  return (THUMB_CHOICE_KEYS as readonly string[]).includes(k);
}

/**
 * Raised when this process's Prisma client predates `PublishJob`.
 *
 * A long-running `next dev` keeps the client it booted with, so adding a model
 * and running `prisma generate` leaves `prisma.publishJob` undefined and every
 * route that touches it throws "Cannot read properties of undefined". That is a
 * genuinely baffling thing to debug from a browser, which is why `db.ts`
 * already has `assertModels` and why this wraps it in a 503 the UI can show as
 * a sentence: a restart is needed, and nothing is broken.
 *
 * It is a 503 rather than a 500 because it is temporary and the operator can
 * fix it — and because answering 500 would make it indistinguishable from a bug
 * in the publish code itself.
 */
export class PublishClientStale extends AppError {
  constructor(message: string) {
    super("publish_client_stale", message, 503);
  }
}

function requirePublishModel(): void {
  try {
    // `platformAccount` and `oAuthState` are in the same bucket: a dev server
    // that booted before the YouTube tables existed answers "undefined" for
    // all three, and the operator's fix is the same restart.
    assertModels("publishJob", "platformAccount", "oAuthState");
  } catch (err) {
    throw new PublishClientStale(err instanceof Error ? err.message : String(err));
  }
}

const text = (v: string | null | undefined): string => (typeof v === "string" ? v : "");

/** `Episode.hashtags` is a JSON string[]; a malformed or legacy row degrades to empty. */
export function parseHashtags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Zero bytes if it is not there. `stat` throwing IS the answer, not an error. */
async function sizeOf(file: string | null): Promise<number | null> {
  if (!file) return null;
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * Confine a stored path to the directory it is supposed to be in before
 * stat-ing it.
 *
 * These paths came out of the database and cannot traverse today, but the same
 * belt-and-braces resolve the video route applies is cheap and means a row
 * edited by hand cannot make this module reach outside the work root.
 */
function confined(file: string, root: string): string | null {
  const resolved = path.resolve(file);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

const EPISODE_FIELDS = {
  id: true,
  userId: true,
  status: true,
  error: true,
  title: true,
  hook: true,
  description: true,
  hashtags: true,
  youtubeTags: true,
  igHook: true,
  igCaption: true,
  igHashtags: true,
  durationSec: true,
  videoPath: true,
  thumbnails: true,
  thumbChoice: true,
  thumbChoiceYouTube: true,
  thumbChoiceInstagram: true,
  titleEditedAt: true,
  descriptionEditedAt: true,
  hashtagsEditedAt: true,
  youtubeTagsEditedAt: true,
  igHookEditedAt: true,
  igCaptionEditedAt: true,
  igHashtagsEditedAt: true,
  book: { select: { title: true } },
} as const;

type EpisodeRow = {
  id: string;
  userId: string | null;
  status: string;
  error: string | null;
  title: string | null;
  hook: string | null;
  description: string | null;
  hashtags: string | null;
  youtubeTags: string | null;
  igHook: string | null;
  igCaption: string | null;
  igHashtags: string | null;
  durationSec: number | null;
  videoPath: string | null;
  thumbnails: string | null;
  thumbChoice: string | null;
  thumbChoiceYouTube: string | null;
  thumbChoiceInstagram: string | null;
  titleEditedAt: Date | null;
  descriptionEditedAt: Date | null;
  hashtagsEditedAt: Date | null;
  youtubeTagsEditedAt: Date | null;
  igHookEditedAt: Date | null;
  igCaptionEditedAt: Date | null;
  igHashtagsEditedAt: Date | null;
  book: { title: string };
};

async function loadEpisode(userId: string, episodeId: string): Promise<EpisodeRow> {
  // The same rule the library lists by, read from `episodes/visibility.ts`
  // rather than spelled out again. `userId` alone matches nothing for an
  // episode with no owner, and most of this operator's library has none.
  const row = await prisma.episode.findFirst({
    where: { id: episodeId, ...visibleTo(userId) },
    select: EPISODE_FIELDS,
  });
  if (!row) throw new AppError("not_found", "Not found", 404);
  return row as EpisodeRow;
}

function metadataOf(row: EpisodeRow): PublishMetadata {
  return {
    title: text(row.title),
    description: text(row.description),
    hashtags: parseHashtags(row.hashtags),
    hook: text(row.hook),
    tags: normaliseTags(parseHashtags(row.youtubeTags)),
    igHook: text(row.igHook),
    igCaption: text(row.igCaption),
    igHashtags: parseHashtags(row.igHashtags),
  };
}

/**
 * The render and the chosen poster, measured.
 *
 * The video path is derived the way the video route derives it
 * (`RENDER_DIR/<id>.mp4`) rather than trusted from `videoPath`, so what is
 * checked here is the file that would actually be served. `videoPath` is still
 * read: it is how "no render was ever recorded" is told apart from "the render
 * is recorded and gone", which are different sentences for the operator.
 */
/** One rendered poster, as `parseThumbnails` yields them. */
type Spec = ReturnType<typeof parseThumbnails>[number];
/** One resolved cover: its spec, its confined file path, its measured size, its URL. */
type CoverAsset = { spec: Spec; file: string | null; bytes: number | null; url: string } | null;

async function assets(row: EpisodeRow) {
  const specs = parseThumbnails(row);
  const chosen = pickPoster(specs, row.thumbChoice);

  const renderFile = confined(path.join(RENDER_DIR, `${row.id}.mp4`), RENDER_DIR);
  const videoBytes = row.videoPath ? await sizeOf(renderFile) : null;

  const posterFile = chosen ? confined(chosen.path, THUMBS_ROOT) : null;
  const posterBytes = await sizeOf(posterFile);

  // The whole set, as the browser needs it for the per-platform cover picker.
  // No disk `path` is carried — only the session-guarded, versioned URL, the
  // same rule the single `poster` follows.
  const thumbnails: PublicThumb[] = specs.map((s) => ({
    key: s.key,
    aspect: s.aspect,
    url: thumbUrl(row.id, s),
    width: s.width,
    height: s.height,
  }));

  // Measure ONE cover (its file size, for the request/handoff). Cheap: a hit is
  // one stat, and the same poster shared by both platforms is stat-ed twice at
  // most, which is nothing beside a model call or a render.
  const coverAsset = async (spec: Spec | null): Promise<CoverAsset> => {
    if (!spec) return null;
    const file = confined(spec.path, THUMBS_ROOT);
    return { spec, file, bytes: await sizeOf(file), url: thumbUrl(row.id, spec) };
  };

  // The cover each platform will actually use: its own override, else the
  // episode-wide choice, else the first poster of the aspect it favours.
  const covers: Record<PlatformId, CoverAsset> = {
    youtube: await coverAsset(pickPosterFor(specs, row.thumbChoiceYouTube, row.thumbChoice, "16:9")),
    instagram: await coverAsset(pickPosterFor(specs, row.thumbChoiceInstagram, row.thumbChoice, "9:16")),
  };

  return {
    specs,
    chosen,
    thumbnails,
    covers,
    renderFile,
    videoBytes,
    posterFile,
    posterBytes,
    videoUrl: `/api/episodes/${row.id}/video`,
    posterUrl: chosen ? thumbUrl(row.id, chosen) : null,
  };
}

type Assets = Awaited<ReturnType<typeof assets>>;

function readinessInput(row: EpisodeRow, a: Assets): ReadinessInput {
  return {
    status: row.status,
    error: row.error,
    durationSec: row.durationSec,
    videoPath: row.videoPath,
    videoOnDisk: a.videoBytes !== null,
    videoBytes: a.videoBytes ?? 0,
    posterCount: a.specs.length,
    posterKey: a.chosen?.key ?? null,
    posterOnDisk: a.posterBytes !== null && a.posterBytes > 0,
    title: row.title,
    description: row.description,
    hashtags: parseHashtags(row.hashtags),
  };
}

/**
 * The request a publisher is handed, carrying the cover for THAT platform.
 *
 * `cover` is the per-platform resolved poster (see `assets().covers`), so the
 * handoff hands off, and the YouTube upload sets, the poster the operator chose
 * for that platform — not a single shared one. Null when there is no file to
 * hand over at all.
 */
function requestFor(row: EpisodeRow, a: Assets, meta: PublishMetadata, cover: CoverAsset): PublishRequest | null {
  if (!a.renderFile || a.videoBytes === null) return null;
  const video: AssetRef = {
    path: a.renderFile,
    bytes: a.videoBytes,
    url: a.videoUrl,
    contentType: "video/mp4",
  };
  const poster: AssetRef | null =
    cover && cover.file && cover.bytes !== null
      ? { path: cover.file, bytes: cover.bytes, url: cover.url, contentType: "image/jpeg" }
      : null;
  return { episodeId: row.id, metadata: meta, durationSec: row.durationSec, video, poster };
}

export type PublishJobRow = {
  status: string;
  externalId: string | null;
  externalUrl: string | null;
  attempts: number;
  lastError: string | null;
  preparedAt: Date | null;
  publishedAt: Date | null;
  metadata: string | null;
  uploadedBytes: number | null;
  totalBytes: number | null;
  thumbnailStatus: string | null;
  thumbnailError: string | null;
  privacyStatus: string | null;
};

function jobView(job: PublishJobRow | null, platform: PlatformId): PublishJobView | null {
  if (!job) return null;
  let metadata: PublishMetadata | null = null;
  if (job.metadata) {
    try {
      const parsed = JSON.parse(job.metadata) as Partial<PublishMetadata>;
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
      metadata = {
        title: text(parsed.title),
        description: text(parsed.description),
        hashtags: strings(parsed.hashtags),
        hook: text(parsed.hook),
        tags: strings(parsed.tags),
        igHook: text(parsed.igHook),
        igCaption: text(parsed.igCaption),
        igHashtags: strings(parsed.igHashtags),
      };
    } catch {
      // A snapshot that will not parse is shown as absent rather than breaking
      // the whole panel it sits in.
      metadata = null;
    }
  }
  return {
    // Read back through the vocabulary, so a value written by hand into the
    // column cannot make the UI claim a status it does not know.
    status: (job.status as PublishStatus) ?? "REQUIRES_CONNECTION",
    externalId: job.externalId,
    externalUrl: job.externalUrl,
    attempts: job.attempts,
    lastError: job.lastError,
    preparedAt: job.preparedAt?.toISOString() ?? null,
    publishedAt: job.publishedAt?.toISOString() ?? null,
    metadata,
    // Measured, both of them, or both absent. A reader with one and not the
    // other must show nothing rather than guess the denominator.
    uploadedBytes: job.uploadedBytes,
    totalBytes: job.totalBytes,
    thumbnailStatus: job.thumbnailStatus,
    thumbnailError: job.thumbnailError,
    privacyStatus: job.privacyStatus,
    // Derived from the id the platform returned, never stored, so it cannot
    // outlive or disagree with it. Only YouTube has a review surface.
    reviewUrl: platform === "youtube" && job.externalId ? studioUrlFor(job.externalId) : null,
  };
}

/** The whole surface, for one episode. */
export async function publishView(
  userId: string,
  episodeId: string,
  ctx: PublisherContext = {},
): Promise<PublishView> {
  requirePublishModel();
  const row = await loadEpisode(userId, episodeId);
  const a = await assets(row);
  const meta = metadataOf(row);
  const readiness = checkReadiness(readinessInput(row, a));

  const jobs = await prisma.publishJob.findMany({ where: { episodeId: row.id } });
  const byPlatform = new Map(jobs.map((j) => [j.platform, j]));

  const platforms: PlatformState[] = [];
  for (const platform of PLATFORM_IDS) {
    // The cover THIS platform will use, and a request carrying it — so the
    // handoff and (for YouTube) the upload act on the per-platform poster.
    const cover = a.covers[platform];
    const request = requestFor(row, a, meta, cover);

    // The viewer's own id, so a provider resolves the viewer's grant and
    // nobody else's. `ctx` lets a test substitute a mocked API boundary.
    const publisher = publisherFor(platform, { userId, ...ctx });
    const caps = publisher.capabilities();
    // Never allowed to throw: a provider whose credential store is unreachable
    // is "not configured", which is an answer.
    const configured = await publisher.isConfigured().catch(() => false);
    const real = hasRealPublisher(platform);
    const recorded = byPlatform.get(platform) ?? null;

    const verdict = request ? publisher.validate(request) : { ok: false, problems: [] as string[] };
    let handoff: HandoffStep[] = [];
    // The handoff is only offered for an episode that would genuinely pass. An
    // operator handed a Download button for a video that is not on disk gets a
    // 404 instead of an explanation.
    if (readiness.ready && request && verdict.ok) {
      try {
        handoff = (await publisher.prepare(request)).handoff;
      } catch (err) {
        if (!isPublishRefused(err)) throw err;
        verdict.problems.push(...err.problems);
      }
    }

    platforms.push({
      platform,
      label: PLATFORM_LABELS[platform],
      // `real && configured` on purpose: the handoff answers `isConfigured`
      // true (it needs nothing), and that must not be mistaken for the platform
      // being connected.
      status: platformStatus(readiness, real && configured, recorded ? (recorded.status as PublishStatus) : null),
      capabilities: caps,
      hasPublisher: real,
      configured: real && configured,
      problems: verdict.problems,
      variant: variantFor(platform, meta),
      cover:
        cover && cover.bytes !== null
          ? { key: cover.spec.key, url: cover.url, aspect: cover.spec.aspect, width: cover.spec.width, height: cover.spec.height }
          : null,
      handoff,
      requires: caps.requires,
      job: jobView(recorded as PublishJobRow | null, platform),
    });
  }

  return {
    episodeId: row.id,
    title: row.title,
    bookTitle: row.book.title,
    status: row.status,
    durationSec: row.durationSec,
    videoUrl: a.videoBytes !== null ? a.videoUrl : null,
    videoBytes: a.videoBytes,
    poster:
      a.chosen && a.posterUrl && a.posterBytes !== null
        ? { key: a.chosen.key, url: a.posterUrl, width: a.chosen.width, height: a.chosen.height }
        : null,
    thumbnails: a.thumbnails,
    thumbChoices: {
      youtube: row.thumbChoiceYouTube ?? null,
      instagram: row.thumbChoiceInstagram ?? null,
      default: row.thumbChoice ?? null,
    },
    metadata: meta,
    edits: {
      title: row.titleEditedAt?.toISOString() ?? null,
      description: row.descriptionEditedAt?.toISOString() ?? null,
      hashtags: row.hashtagsEditedAt?.toISOString() ?? null,
      tags: row.youtubeTagsEditedAt?.toISOString() ?? null,
      igHook: row.igHookEditedAt?.toISOString() ?? null,
      igCaption: row.igCaptionEditedAt?.toISOString() ?? null,
      igHashtags: row.igHashtagsEditedAt?.toISOString() ?? null,
    },
    readiness,
    platforms,
    // Strict, not `canSee`. See the note on `PublishView.owned`.
    owned: row.userId === userId,
  };
}

/**
 * Load an episode for a PUBLISH, which requires genuine ownership.
 *
 * `loadEpisode` above uses `visibleTo`, which matches the viewer's episodes AND
 * every ownerless one. That is right for reading state and for recording a
 * handoff — both local, both reversible. It is NOT right here: an API publish
 * puts a file on YouTube under somebody's channel and cannot be undone from
 * this app, and an ownerless episode handed to whoever signs in first is not a
 * risk worth taking for convenience.
 *
 * So the rule is `userId === user.id`, and the two refusals are deliberately
 * different sentences:
 *
 *  - no such episode → 404, which says nothing about what exists;
 *  - an episode that exists but is not the viewer's → 403 naming the reason,
 *    because on this install that is the COMMON case (most of the library has
 *    no owner at all) and "not found" would send the operator looking for a bug
 *    that is not there.
 *
 * `tests/publish-youtube.test.mts` drives all three cases, including the
 * ownerless one, because this is the exact generosity the prior workstream's
 * report flagged as something publishing must not inherit.
 */
export async function loadEpisodeForPublish(userId: string, episodeId: string): Promise<EpisodeRow> {
  const row = await prisma.episode.findUnique({ where: { id: episodeId }, select: EPISODE_FIELDS });
  if (!row) throw new AppError("not_found", "Not found", 404);
  if (row.userId !== userId) {
    throw new AppError(
      "not_owned",
      row.userId === null
        ? "This episode has no owner, so it cannot be published to a platform from this account. " +
          "Publishing posts under your own channel and is not reversible from here, so it is only " +
          "offered for episodes this account owns. The assisted handoff still works for this one."
        : "This episode belongs to another account, so it cannot be published from this one.",
      403,
    );
  }
  return row as EpisodeRow;
}

/**
 * Everything a publish attempt needs about one episode, with ownership already
 * enforced and the files already measured.
 *
 * It is here rather than in `youtube/` because none of it is YouTube-specific:
 * the readiness rule, the asset measurement and the ownership rule are the same
 * for whatever platform gets a real provider next.
 */
export async function loadPublishRequest(
  userId: string,
  episodeId: string,
  platform: PlatformId = "youtube",
): Promise<{ row: EpisodeRow; request: PublishRequest }> {
  requirePublishModel();
  const row = await loadEpisodeForPublish(userId, episodeId);
  const a = await assets(row);
  const meta = metadataOf(row);

  const readiness = checkReadiness(readinessInput(row, a));
  if (!readiness.ready) {
    throw new AppError(
      "not_ready",
      `This episode is not ready to publish: ${readiness.issues.map((i) => i.message).join(" ")}`,
      409,
    );
  }
  // The cover for the platform being published to, so the upload sets the
  // thumbnail the operator chose for it (YouTube, by default).
  const request = requestFor(row, a, meta, a.covers[platform]);
  if (!request) throw new AppError("not_ready", "There is no rendered video to upload.", 409);
  return { row, request };
}

/**
 * Store an operator's edit to one or more metadata fields, and mark each one as
 * hand-edited.
 *
 * The mark is the whole reason this is not a bare `prisma.episode.update`: once
 * a field carries an edit timestamp, Regenerate will not overwrite it without
 * being asked twice. A field whose new value is identical to the stored one is
 * left alone, timestamp included — re-saving the same text is not an edit, and
 * marking it would quietly make a generated field "hand-edited" and start
 * demanding confirmations for a change nobody made.
 *
 * Validation refuses, never truncates: `FIELD_MAX` is a hard cap far above
 * every platform limit, so hitting it means something pasted a document into a
 * title, and cutting that to 300 characters silently would be worse than saying
 * no.
 */
export async function saveMetadata(
  userId: string,
  episodeId: string,
  body: unknown,
): Promise<PublishView> {
  requirePublishModel();
  const row = await loadEpisode(userId, episodeId);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("bad_body", "Expected a JSON object.", 400);
  }
  const input = body as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((k) => !isMetadataField(k) && !isThumbChoiceKey(k));
  if (unknownKeys.length) {
    throw new AppError("bad_field", `Not an editable field: ${unknownKeys.join(", ")}.`, 400);
  }

  const now = new Date();
  const data: Record<string, unknown> = {};
  const columnValue = (column: FieldSpec["column"]): string | null =>
    (row as unknown as Record<string, string | null>)[column];

  for (const key of Object.keys(input)) {
    if (!isMetadataField(key)) continue;
    const spec = FIELD_SPECS[key];
    const value = input[key];

    if (spec.normalise) {
      // A list field — hashtags, YouTube tags or Instagram hashtags.
      if (!Array.isArray(value) && typeof value !== "string") {
        throw new AppError("bad_value", `The ${spec.label} must be a list, or one line of text.`, 400);
      }
      const next = spec.normalise(value);
      if (next.length > spec.max) {
        throw new AppError("bad_value", `At most ${spec.max} ${spec.label}.`, 400);
      }
      const before = spec.normalise(parseHashtags(columnValue(spec.column)));
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        data[spec.column] = JSON.stringify(next);
        data[spec.editedAt] = now;
      }
    } else {
      // A prose field — title, description, Instagram hook or caption.
      if (typeof value !== "string") throw new AppError("bad_value", `The ${spec.label} must be text.`, 400);
      const next = value.trim();
      if ([...next].length > spec.max) {
        throw new AppError("bad_value", `The ${spec.label} may be at most ${spec.max} characters.`, 400);
      }
      if (next !== text(columnValue(spec.column))) {
        data[spec.column] = next;
        data[spec.editedAt] = now;
      }
    }
  }

  // Per-platform cover choice. Not a metadata field and carries no edit mark:
  // it is only a pointer to one of this episode's own posters, so the single
  // check is that the key names one that exists. `null` or "" clears the
  // override, falling back to the episode-wide `thumbChoice`.
  const thumbKeys = parseThumbnails(row).map((t) => t.key);
  for (const key of THUMB_CHOICE_KEYS) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (value === null || value === "") {
      data[key] = null;
      continue;
    }
    if (typeof value !== "string" || !thumbKeys.includes(value)) {
      throw new AppError("bad_value", "That poster is not one this episode has.", 400);
    }
    data[key] = value;
  }

  if (Object.keys(data).length > 0) {
    await prisma.episode.update({ where: { id: episodeId }, data });
  }
  return publishView(userId, episodeId);
}

/** The marks, and nothing else: anything carrying them can be asked. */
export interface EditMarks {
  titleEditedAt: Date | null;
  descriptionEditedAt: Date | null;
  hashtagsEditedAt: Date | null;
  youtubeTagsEditedAt: Date | null;
  igHookEditedAt: Date | null;
  igCaptionEditedAt: Date | null;
  igHashtagsEditedAt: Date | null;
}

/** Has the operator typed over this field? Looked up through the one spec table. */
export function wasHandEdited(row: EditMarks, field: MetadataField): boolean {
  return (row as unknown as Record<string, Date | null>)[FIELD_SPECS[field].editedAt] !== null;
}

/**
 * Write a regenerated field back, clearing its hand-edited mark.
 *
 * Clearing is correct: after a regenerate what is stored is the writer's words
 * again, not the operator's, so the next Regenerate has nothing to protect and
 * must not demand a confirmation for overwriting a machine-written value.
 */
export async function storeRegenerated(
  episodeId: string,
  field: MetadataField,
  value: string | string[],
): Promise<void> {
  const spec = FIELD_SPECS[field];
  const stored = spec.normalise ? JSON.stringify(spec.normalise(value)) : String(value);
  await prisma.episode.update({
    where: { id: episodeId },
    data: { [spec.column]: stored, [spec.editedAt]: null },
  });
}

/** Everything a regenerate needs about the episode, loaded through the visibility rule. */
export async function loadForRegenerate(userId: string, episodeId: string) {
  requirePublishModel();
  const row = await prisma.episode.findFirst({
    where: { id: episodeId, ...visibleTo(userId) },
    select: {
      id: true,
      userId: true,
      title: true,
      hook: true,
      cta: true,
      script: true,
      voScript: true,
      description: true,
      hashtags: true,
      titleEditedAt: true,
      descriptionEditedAt: true,
      hashtagsEditedAt: true,
      youtubeTagsEditedAt: true,
      igHookEditedAt: true,
      igCaptionEditedAt: true,
      igHashtagsEditedAt: true,
      book: { select: { title: true, author: true, authorVerified: true, archetype: true, bookLink: true } },
    },
  });
  if (!row) throw new AppError("not_found", "Not found", 404);
  return row;
}

/**
 * Record that the metadata and the files were handed to the operator for one
 * platform.
 *
 * This is the only writer of `PublishJob` in this build, and what it records is
 * carefully NOT a claim about the platform. `status` comes from the publisher's
 * own outcome, which for the handoff is `REQUIRES_CONNECTION`; `publishedAt`
 * and `externalId` stay NULL because nothing confirmed anything. `preparedAt`
 * is the honest fact: at this moment, this exact metadata was handed over.
 *
 * `attempts` increments because a second handoff IS a second attempt — the
 * operator came back, which usually means the first one did not land.
 */
export async function recordHandoff(
  userId: string,
  episodeId: string,
  platform: PlatformId,
): Promise<PublishView> {
  requirePublishModel();
  const row = await loadEpisode(userId, episodeId);
  const a = await assets(row);
  const meta = metadataOf(row);

  const readiness = checkReadiness(readinessInput(row, a));
  if (!readiness.ready) {
    throw new AppError(
      "not_ready",
      `This episode is not ready to publish: ${readiness.issues.map((i) => i.message).join(" ")}`,
      409,
    );
  }

  const request = requestFor(row, a, meta, a.covers[platform]);
  if (!request) throw new AppError("not_ready", "There is no rendered video to hand over.", 409);

  const publisher = publisherFor(platform);
  let prepared;
  try {
    prepared = await publisher.prepare(request);
  } catch (err) {
    if (isPublishRefused(err)) throw new AppError("refused", err.problems.join(" "), 409);
    throw err;
  }

  const outcome = await publisher.publish(prepared);
  const snapshot = JSON.stringify(prepared.metadata);

  // One upsert, keyed by the unique pair, so two clicks in the same second
  // cannot create two rows for one platform.
  const base = {
    metadata: snapshot,
    preparedAt: prepared.preparedAt,
    // A new attempt's error is the new outcome's, never a leftover.
    lastError: outcome.status === "PUBLISHED" ? null : outcome.error,
    status: outcome.status,
    // Both stay null unless the platform itself confirmed. The PUBLISHED
    // variant of `PublishOutcome` cannot exist without an `externalId`, so
    // this cannot be reached with an invented one.
    externalId: outcome.status === "PUBLISHED" ? outcome.externalId : null,
    externalUrl: outcome.status === "PUBLISHED" ? outcome.externalUrl : null,
    publishedAt: outcome.status === "PUBLISHED" ? outcome.confirmedAt : null,
  };

  await prisma.publishJob.upsert({
    where: { episodeId_platform: { episodeId: row.id, platform } },
    create: { episodeId: row.id, platform, attempts: 1, ...base },
    update: { attempts: { increment: 1 }, ...base },
  });

  return publishView(userId, episodeId);
}
