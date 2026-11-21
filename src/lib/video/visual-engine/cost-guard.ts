/**
 * SERVER-ONLY. Hard cost-protection guardrails for the Automatic Cinematic Visual Engine.
 *
 * BookReel's visual engine is strictly 100% FREE-ONLY:
 *  1. AI image/video generation may ONLY talk to a loopback ComfyUI instance
 *     (`127.0.0.1`, `localhost`, `::1`). Pointing ComfyUI at a remote or cloud GPU
 *     host is refused before a socket is opened.
 *  2. Visual reference discovery may ONLY query permitted free reference APIs
 *     (Openverse, Wikimedia Commons, optional free Pexels API, optional official
 *     Pinterest API v5) and fetch public thumbnail bytes for ephemeral local
 *     palette/composition analysis through `fetch-guard.ts`.
 *  3. Known paid AI generation/inference domains are explicitly denylisted so no
 *     future caller or misconfiguration can trigger a paid external request.
 */

export class PaidApiBlockedError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Blocked external request (${reason}): ${url}`);
    this.name = "PaidApiBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

/** Explicit denylist of paid AI / pay-as-you-go media and LLM API hosts. */
const BLOCKED_PAID_HOSTS: readonly string[] = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "fal.run",
  "queue.fal.run",
  "rest.alpha.fal.ai",
  "fal.ai",
  "api.replicate.com",
  "replicate.delivery",
  "api.stability.ai",
  "api.runwayml.com",
  "api.dev.runwayml.com",
  "api.lumalabs.ai",
  "api.klingai.com",
  "api.minimaxi.chat",
  "api.elevenlabs.io",
  "api.bfl.ml",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.midjourney.com",
  "api.heygen.com",
  "cloud.hyperframes.heygen.com",
];

/** Permitted free API endpoints for reference search metadata queries. */
const PERMITTED_REFERENCE_API_HOSTS: ReadonlySet<string> = new Set([
  "api.openverse.org",
  "commons.wikimedia.org",
  "api.pexels.com",
  "api.pinterest.com",
]);

/** Loopback hostnames permitted for local ComfyUI communication. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function isBlockedPaidHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return BLOCKED_PAID_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/**
 * Verify a ComfyUI server URL is strictly local loopback HTTP.
 * Throws `PaidApiBlockedError` if pointed at any external or cloud GPU host.
 */
export function assertLocalComfyUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PaidApiBlockedError(rawUrl, "invalid ComfyUI URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PaidApiBlockedError(rawUrl, `unsupported ComfyUI protocol ${parsed.protocol}`);
  }
  const host = normalizeHost(parsed.hostname);
  if (isBlockedPaidHost(host)) {
    throw new PaidApiBlockedError(rawUrl, `paid AI host "${host}" is forbidden`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new PaidApiBlockedError(
      rawUrl,
      `ComfyUI host "${host}" is not local loopback (only 127.0.0.1 / localhost is allowed in free-only mode)`,
    );
  }
  return parsed;
}

/**
 * Verify a reference search API URL belongs to the permitted free reference catalog
 * and is never a paid AI endpoint.
 */
export function assertFreeReferenceApiUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PaidApiBlockedError(rawUrl, "invalid reference API URL");
  }
  if (parsed.protocol !== "https:") {
    throw new PaidApiBlockedError(rawUrl, "reference API calls must use https:");
  }
  const host = normalizeHost(parsed.hostname);
  if (isBlockedPaidHost(host)) {
    throw new PaidApiBlockedError(rawUrl, `paid AI host "${host}" is forbidden`);
  }
  if (!PERMITTED_REFERENCE_API_HOSTS.has(host)) {
    throw new PaidApiBlockedError(
      rawUrl,
      `host "${host}" is not in the permitted free reference API allowlist`,
    );
  }
  return parsed;
}

/**
 * Verify an ephemeral reference thumbnail URL is safe to inspect for clean-room
 * colour/lighting analysis (HTTPS/HTTP public URL, never a paid AI host).
 * Callers must ALSO pass this URL through `fetch-guard.ts` (`assertPublicUrl`)
 * to prevent SSRF against private networks.
 */
export function assertFreeThumbnailUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PaidApiBlockedError(rawUrl, "invalid reference thumbnail URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PaidApiBlockedError(rawUrl, `unsupported thumbnail protocol ${parsed.protocol}`);
  }
  const host = normalizeHost(parsed.hostname);
  if (isBlockedPaidHost(host)) {
    throw new PaidApiBlockedError(rawUrl, `paid AI host "${host}" is forbidden`);
  }
  if (LOOPBACK_HOSTS.has(host)) {
    throw new PaidApiBlockedError(rawUrl, "reference thumbnails cannot target loopback");
  }
  return parsed;
}

/**
 * Coerce render mode to strictly `"local"` so HyperFrames Cloud (a paid cloud
 * rendering service) is never invoked by the automatic visual pipeline.
 */
export function enforceFreeRenderMode(requestedMode?: string | null): "local" {
  void requestedMode;
  return "local";
}
