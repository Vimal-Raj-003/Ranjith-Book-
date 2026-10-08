/**
 * SERVER-ONLY. The resumable upload, and the thumbnail that follows it.
 *
 * THE PROGRESS IN THIS FILE IS THE PLATFORM'S OWN ACCOUNTING, not a timer and
 * not an estimate. YouTube's resumable protocol answers every chunk with either
 * `308 Resume Incomplete` and a `Range: bytes=0-N` header naming exactly how
 * many bytes it now holds, or a `200/201` carrying the finished video resource.
 * `onProgress` is called with that N. There is no interpolation between chunks,
 * no "almost done", and no percentage invented on the client — a reader divides
 * acknowledged bytes by the file size, and when it has neither it shows no bar.
 *
 * WHY RESUMABLE AND NOT A SINGLE POST. Two reasons, and the second is the one
 * that matters. A 38 MB `multipart` POST reports nothing until it finishes, so
 * the UI would have to lie or say nothing for a minute. And a POST that dies at
 * 90% has to start again, every time — whereas a resumable session can be asked
 * "how much do you have?" and continued. That is what makes the hard rule
 * "retry must not re-upload an already-uploaded video" implementable rather
 * than aspirational: `resumeFrom` takes a session URL recorded by the previous
 * attempt, asks YouTube where it got to, and sends only the remainder. If that
 * session has already completed, this returns the video id YouTube gives back
 * and uploads NOTHING.
 *
 * WHAT IS DELIBERATELY NOT SET ON THE VIDEO:
 *  - `privacyStatus` is `private`, always, from a constant. There is no code
 *    path in this integration that sends anything else.
 *  - `selfDeclaredMadeForKids` is NOT sent. It is a legal declaration about the
 *    operator's content and this app has no business making it on their behalf;
 *    leaving it unset means YouTube asks them for it in Studio, which is
 *    exactly where this design wants them to finish.
 *
 * The `fetch` is injectable throughout, which is what lets the test suite drive
 * every branch — a dead session, a 308 with no `Range`, a mid-upload network
 * loss, a quota refusal, a thumbnail that fails on an unverified channel —
 * without a single byte going to a real Google endpoint.
 */
import fsp from "node:fs/promises";
import { GOOGLE, UPLOAD_PRIVACY } from "./config";
import { mapApiError, mapTransportError, type MappedFailure } from "./errors";
import type { Fetcher } from "./oauth";

/**
 * 8 MiB. A multiple of 256 KiB, which Google's protocol requires for every
 * chunk but the last. Large enough that a 38 MB render is five requests rather
 * than 150, small enough that a lost connection costs at most 8 MB of retransmit
 * and that progress moves visibly.
 */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/** Per-chunk retries for a transient refusal (5xx, 429, a dropped socket). */
const CHUNK_RETRIES = 4;

/** YouTube's own ceiling on the combined length of `snippet.tags`. */
export const TAGS_MAX_CHARS = 500;

export class YouTubeApiError extends Error {
  readonly failure: MappedFailure;
  /** Bytes YouTube had acknowledged when this failed, so a retry can say so. */
  readonly sentBytes: number | null;
  constructor(failure: MappedFailure, sentBytes: number | null = null) {
    super(failure.message);
    this.name = "YouTubeApiError";
    this.failure = failure;
    this.sentBytes = sentBytes;
  }
}

export interface VideoSnippet {
  title: string;
  description: string;
  /** Plain words, with no leading `#`: that is the form `snippet.tags` takes. */
  tags: string[];
  categoryId: string;
}

export interface UploadHooks {
  /** Called once, the moment a resumable session exists, so a retry can resume. */
  onSession?: (sessionUrl: string) => void | Promise<void>;
  /** Called with the bytes YOUTUBE SAYS it holds, after every chunk. */
  onProgress?: (acknowledgedBytes: number, totalBytes: number) => void | Promise<void>;
  /** A session URL from an earlier attempt. Null or absent starts a new one. */
  resumeFrom?: string | null;
}

export interface UploadResult {
  videoId: string;
  channelId: string | null;
  channelTitle: string | null;
  privacyStatus: string | null;
  /** True when `resumeFrom` turned out to be a session YouTube had already finished. */
  alreadyComplete: boolean;
}

interface VideoResource {
  id?: string;
  snippet?: { channelId?: string; channelTitle?: string };
  status?: { privacyStatus?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

/**
 * `Range: bytes=0-8388607` means YouTube holds 8388608 bytes.
 *
 * An absent header on a 308 means it holds NONE — which is a real answer and
 * not a missing one, and reading it as "keep whatever offset we had" is how a
 * resumed upload ends up writing the wrong bytes at the wrong place.
 */
export function offsetFromRange(header: string | null): number {
  if (!header) return 0;
  const m = /bytes=(\d+)-(\d+)/.exec(header.trim());
  if (!m) return 0;
  const last = Number(m[2]);
  return Number.isFinite(last) ? last + 1 : 0;
}

function videoFrom(body: unknown, alreadyComplete: boolean): UploadResult {
  const resource = (body ?? {}) as VideoResource;
  const videoId = typeof resource.id === "string" ? resource.id : "";
  if (videoId === "") {
    // The ONE place a success could be faked, closed: no id, no success.
    throw new YouTubeApiError({
      code: "platform_error",
      message:
        "YouTube accepted the upload but did not return a video id, so this app cannot confirm " +
        "it was published. Check the channel's content in YouTube Studio before trying again.",
      retryable: false,
    });
  }
  return {
    videoId,
    channelId: resource.snippet?.channelId ?? null,
    channelTitle: resource.snippet?.channelTitle ?? null,
    privacyStatus: resource.status?.privacyStatus ?? null,
    alreadyComplete,
  };
}

/**
 * Open a resumable session and return its URL.
 *
 * The metadata goes in this request's JSON body; the bytes do not. YouTube
 * answers with a `Location` header, which IS the session: everything after this
 * is a `PUT` to that URL, and the access token is not needed again (though it is
 * sent, since sessions are account-scoped and a token costs nothing).
 */
export async function createSession(
  accessToken: string,
  snippet: VideoSnippet,
  totalBytes: number,
  contentType: string,
  doFetch: Fetcher = fetch,
): Promise<string> {
  const url = `${GOOGLE.videosUpload}?uploadType=resumable&part=snippet%2Cstatus`;
  const body = JSON.stringify({
    snippet,
    status: {
      // Review-first. From a constant, so there is no literal here to edit.
      privacyStatus: UPLOAD_PRIVACY,
      // The operator declares "made for kids" in Studio; this app does not
      // declare it for them. See the header comment.
    },
  });

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(totalBytes),
        "X-Upload-Content-Type": contentType,
      },
      body,
    });
  } catch (err) {
    throw new YouTubeApiError(mapTransportError(err, 0), 0);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new YouTubeApiError(mapApiError(res.status, await readBody(res), "upload"), 0);
  }
  const location = res.headers.get("location");
  if (!location) {
    throw new YouTubeApiError({
      code: "platform_error",
      message: "YouTube accepted the upload request but gave no session to send the file to. Try again.",
      retryable: true,
    });
  }
  return location;
}

/**
 * Ask an existing session how much it holds.
 *
 * Returns `{ done: result }` when the session has already completed — the case
 * that makes a retry safe, because it means the video is up and the only thing
 * left is to record the id YouTube just handed back.
 */
export async function querySession(
  sessionUrl: string,
  totalBytes: number,
  doFetch: Fetcher = fetch,
): Promise<{ offset: number } | { done: UploadResult }> {
  let res: Response;
  try {
    res = await doFetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${totalBytes}`, "Content-Length": "0" },
    });
  } catch (err) {
    throw new YouTubeApiError(mapTransportError(err), null);
  }

  if (res.status === 308) return { offset: offsetFromRange(res.headers.get("range")) };
  if (res.status === 200 || res.status === 201) return { done: videoFrom(await readBody(res), true) };
  throw new YouTubeApiError(mapApiError(res.status, await readBody(res), "upload"), null);
}

/**
 * Put the file on YouTube, in chunks, reporting what YouTube acknowledges.
 *
 * The loop is written so that the offset is always YOUTUBE'S, never this
 * process's running total: after every chunk the next position comes from the
 * `Range` header rather than from `offset + chunk.length`. If YouTube accepted
 * only part of a chunk — which the protocol permits — the next request still
 * sends the right bytes.
 */
export async function uploadVideo(
  accessToken: string,
  filePath: string,
  totalBytes: number,
  contentType: string,
  snippet: VideoSnippet,
  hooks: UploadHooks = {},
  doFetch: Fetcher = fetch,
): Promise<UploadResult> {
  if (totalBytes <= 0) {
    throw new YouTubeApiError({
      code: "invalid_metadata",
      message: "The rendered video is empty, so there is nothing to upload.",
      retryable: false,
    });
  }

  let sessionUrl: string;
  let offset = 0;

  if (hooks.resumeFrom) {
    try {
      const probe = await querySession(hooks.resumeFrom, totalBytes, doFetch);
      if ("done" in probe) return probe.done;
      sessionUrl = hooks.resumeFrom;
      offset = probe.offset;
      await hooks.onProgress?.(offset, totalBytes);
    } catch (err) {
      // A session YouTube has forgotten (404/410) is not a failure — it is a
      // reason to start a new one. Anything else is a real refusal.
      const dead = err instanceof YouTubeApiError && err.failure.code === "upload_session_gone";
      if (!dead) throw err;
      sessionUrl = await createSession(accessToken, snippet, totalBytes, contentType, doFetch);
      await hooks.onSession?.(sessionUrl);
      offset = 0;
    }
  } else {
    sessionUrl = await createSession(accessToken, snippet, totalBytes, contentType, doFetch);
    await hooks.onSession?.(sessionUrl);
  }

  const handle = await fsp.open(filePath, "r");
  try {
    let attempts = 0;
    while (offset < totalBytes) {
      const size = Math.min(CHUNK_BYTES, totalBytes - offset);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      if (bytesRead !== size) {
        throw new YouTubeApiError({
          code: "invalid_metadata",
          message:
            "The rendered video changed size while it was being uploaded, so the upload was stopped " +
            "rather than sending a file that does not match what was measured.",
          retryable: false,
        });
      }

      const first = offset;
      const last = offset + size - 1;
      let res: Response;
      try {
        res = await doFetch(sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(size),
            "Content-Range": `bytes ${first}-${last}/${totalBytes}`,
            "Content-Type": contentType,
          },
          body: new Uint8Array(buffer),
        });
      } catch (err) {
        attempts += 1;
        if (attempts > CHUNK_RETRIES) throw new YouTubeApiError(mapTransportError(err, offset), offset);
        await sleep(Math.min(8000, 500 * 2 ** (attempts - 1)));
        // Re-ask YouTube where it got to rather than assuming nothing landed.
        const probe = await querySession(sessionUrl, totalBytes, doFetch);
        if ("done" in probe) return probe.done;
        offset = probe.offset;
        await hooks.onProgress?.(offset, totalBytes);
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        const result = videoFrom(await readBody(res), false);
        await hooks.onProgress?.(totalBytes, totalBytes);
        return result;
      }
      if (res.status === 308) {
        attempts = 0;
        const next = offsetFromRange(res.headers.get("range"));
        // A 308 that does not advance is YouTube telling us nothing landed; a
        // loop that ignored that would spin forever on a dead session.
        if (next <= offset && next !== 0) {
          attempts += 1;
          if (attempts > CHUNK_RETRIES) {
            throw new YouTubeApiError(
              {
                code: "platform_error",
                message: "YouTube stopped accepting this upload without saying why. Try again to resume it.",
                retryable: true,
              },
              offset,
            );
          }
        }
        offset = next;
        await hooks.onProgress?.(offset, totalBytes);
        continue;
      }

      const failure = mapApiError(res.status, await readBody(res), "upload");
      if (failure.retryable && attempts < CHUNK_RETRIES) {
        attempts += 1;
        await sleep(Math.min(8000, 500 * 2 ** (attempts - 1)));
        continue;
      }
      throw new YouTubeApiError(failure, offset);
    }
  } finally {
    await handle.close().catch(() => {});
  }

  // The loop exited with every byte acknowledged but no final resource, which
  // happens if the last 308 covered the whole file. Ask once, properly.
  const probe = await querySession(sessionUrl, totalBytes, doFetch);
  if ("done" in probe) return probe.done;
  throw new YouTubeApiError({
    code: "platform_error",
    message:
      "YouTube acknowledged the whole file but has not confirmed the video. Check YouTube Studio " +
      "before uploading again, so this episode is not published twice.",
    retryable: false,
  });
}

export interface ThumbnailOutcome {
  applied: boolean;
  /** Why not, when not. Null on success. */
  reason: string | null;
  /** The mapped code, so a reader can tell "unverified channel" from "quota". */
  code: MappedFailure["code"] | null;
}

/**
 * Set the chosen poster as the video's thumbnail.
 *
 * NEVER THROWS. A thumbnail is a nice-to-have on a video that is already up,
 * and the commonest refusal — a channel that is not phone-verified, which
 * YouTube requires for any custom thumbnail — is a property of the account that
 * no retry will change. Failing the publish over it would throw away a
 * successful 38 MB upload and tell the operator their video did not go out,
 * which would be false.
 *
 * So the outcome is returned beside the video's, recorded separately in
 * `PublishJob.thumbnailStatus`, and shown as its own line in the Publish
 * Center.
 */
export async function setThumbnail(
  accessToken: string,
  videoId: string,
  filePath: string,
  contentType: string,
  doFetch: Fetcher = fetch,
): Promise<ThumbnailOutcome> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(filePath);
  } catch (err) {
    return {
      applied: false,
      reason: `The chosen poster could not be read from disk (${err instanceof Error ? err.message : String(err)}).`,
      code: "invalid_metadata",
    };
  }

  const url = `${GOOGLE.thumbnailsSet}?videoId=${encodeURIComponent(videoId)}&uploadType=media`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
      },
      body: new Uint8Array(bytes),
    });
    if (res.status >= 200 && res.status < 300) return { applied: true, reason: null, code: null };
    const failure = mapApiError(res.status, await readBody(res), "thumbnail");
    return { applied: false, reason: failure.message, code: failure.code };
  } catch (err) {
    const failure = mapTransportError(err);
    return { applied: false, reason: failure.message, code: failure.code };
  }
}
