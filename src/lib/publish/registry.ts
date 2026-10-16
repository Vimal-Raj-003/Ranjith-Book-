/**
 * Which publisher serves which platform.
 *
 * YouTube and Instagram each have a real provider. Each entry below is the ONLY
 * line outside its own folder (`youtube/`, `instagram/`) that knows that
 * integration exists. `state.ts` asks the registry rather than naming a
 * platform, the routes go through `Publisher`, and `PublishCenter` renders
 * whatever capabilities come back as data.
 *
 * Having a provider does not mean being able to use it. An Instagram publisher
 * on an install with no Meta app, with nothing connected, or connected to the
 * wrong account still offers exactly the assisted handoff it always did: its
 * `capabilities()` are the handoff's until a connected, identity-verified account
 * exists, and its `prepare()` returns the same steps in every state.
 *
 * `publisherFor` never returns null. A platform with no real provider falls
 * back to the assisted handoff, which is a genuine publisher with
 * `canUpload: false` — so every caller gets something that works, and the thing
 * it gets is honest about what it cannot do. The alternative (null, and a
 * special case at every call site) is how a surface ends up with a button that
 * throws.
 *
 * `hasRealPublisher` is "does code exist that could upload here", and it is
 * deliberately a DIFFERENT question from `isConfigured()`, which is "can this
 * install do it right now". YouTube answers true to the first on every install
 * and false to the second until the operator has a Google project AND a
 * consent. Both end in REQUIRES_CONNECTION, with different sentences, which is
 * the whole reason the two questions are kept apart.
 *
 * BROWSER MODE is a second, explicitly chosen way to reach the same platforms:
 * `publisherFor(platform, { mode: "browser" })` returns a provider that drives the
 * platform's own web uploader in a Chromium window the operator signs in to. It
 * is never the default and never a fallback; the API providers above remain what
 * every caller gets without asking, and what the Publish Center recommends.
 *
 * WHY THE FACTORY TAKES A CONTEXT. A real provider acts on behalf of ONE user:
 * the grant it uses is that user's. The alternative — a module-level provider
 * that looks the current user up itself — would mean a credential lookup inside
 * something that is constructed at import time, and no way for a test to drive
 * it. So the caller, which already knows who is asking, says so. `ctx` is
 * optional, and a provider given no user id reports itself unconfigured rather
 * than reaching for whatever grant it can find.
 */
import type { PlatformId, PublishMode } from "./limits";
import type { Publisher } from "./contract";
import { manualHandoff } from "./manual";
import { instagramPublisher } from "./instagram/publisher";
import { youTubePublisher } from "./youtube/publisher";
import type { EnvLike } from "./youtube/secrets";
import { chromiumProblem, isHeadless } from "./browser/engine";
import type { BrowserDeps, BrowserPublishOptions, BrowserPublisher } from "./browser/engine";
import { browserInstagramPublisher } from "./browser/instagram";
import { browserYouTubePublisher } from "./browser/youtube";
import type { BrowserModeView } from "./view";

/** Who a publisher is acting for. */
export interface PublisherContext {
  /** The signed-in user whose platform grant is to be used. */
  userId?: string | null;
  /** Injectable for tests: the whole provider can be driven against a mocked API. */
  fetchImpl?: typeof fetch;
  env?: EnvLike;
  /**
   * How to publish. `api` (or absent) is the official-API provider and is the
   * default; `browser` is the explicitly chosen Chromium-window provider. An
   * unrecognised value is treated as `api` -- never as a silent upgrade to
   * browser automation.
   */
  mode?: PublishMode;
  /** What a browser publish is asked to do, and the seams a test replaces. Ignored for `api`. */
  browser?: { options?: BrowserPublishOptions; deps?: BrowserDeps };
}

/**
 * The real, uploading providers.
 *
 * A factory rather than an instance, so a provider that reads a token does it
 * per request rather than once at module load — the credential it reads is
 * editable (connect, disconnect, revoke) while the server runs.
 */
const PUBLISHERS: Partial<Record<PlatformId, (ctx: PublisherContext) => Publisher>> = {
  youtube: (ctx) =>
    youTubePublisher({ userId: ctx.userId ?? null, env: ctx.env, fetchImpl: ctx.fetchImpl }),
  instagram: (ctx) =>
    instagramPublisher({ userId: ctx.userId ?? null, env: ctx.env, fetchImpl: ctx.fetchImpl }),
};

/**
 * The OPTIONAL browser-window providers.
 *
 * Reached only by asking for `mode: "browser"`. They are not consulted for
 * `hasRealPublisher`, for the default `publisherFor`, or for a platform's
 * `isConfigured` badge: the API provider stays the answer to all three.
 */
const BROWSER_PUBLISHERS: Partial<Record<PlatformId, (ctx: PublisherContext) => BrowserPublisher>> = {
  youtube: (ctx) =>
    browserYouTubePublisher({ env: ctx.env, options: ctx.browser?.options, deps: ctx.browser?.deps }),
  instagram: (ctx) =>
    browserInstagramPublisher({ env: ctx.env, options: ctx.browser?.options, deps: ctx.browser?.deps }),
};

/** Is there a provider for this platform that could actually upload? */
export function hasRealPublisher(platform: PlatformId): boolean {
  return PUBLISHERS[platform] !== undefined;
}

/** Does this platform have a browser-window provider? */
export function hasBrowserPublisher(platform: PlatformId): boolean {
  return BROWSER_PUBLISHERS[platform] !== undefined;
}

/** The browser provider for a platform, or null when it has none. Typed with the stage hook the job runner uses. */
export function browserPublisherFor(platform: PlatformId, ctx: PublisherContext = {}): BrowserPublisher | null {
  const make = BROWSER_PUBLISHERS[platform];
  return make ? make(ctx) : null;
}

/**
 * The provider for this platform.
 *
 * `mode: "browser"` returns the browser provider when the platform has one --
 * even if no Chromium is installed, in which case that provider reports itself
 * unconfigured and refuses to publish, rather than this function quietly handing
 * back the API provider and posting by a route the caller did not choose.
 * Anything else (no mode, `api`, an unknown value, a platform with no browser
 * provider) is the existing behaviour: the real API provider if there is one,
 * otherwise the handoff.
 */
export function publisherFor(platform: PlatformId, ctx: PublisherContext = {}): Publisher {
  if (ctx.mode === "browser") {
    const browser = browserPublisherFor(platform, ctx);
    if (browser) return browser;
  }
  const make = PUBLISHERS[platform];
  return make ? make(ctx) : manualHandoff(platform);
}

/** What the card needs to offer (or explain the absence of) the browser-window route. */
export function browserModeFor(platform: PlatformId, ctx: PublisherContext = {}): BrowserModeView | null {
  const publisher = browserPublisherFor(platform, ctx);
  if (!publisher) return null;
  const problem = chromiumProblem(ctx.browser?.deps);
  return {
    available: problem === null,
    reason: problem,
    canSchedule: publisher.capabilities().canSchedule,
    headless: isHeadless(ctx.env ?? process.env),
  };
}
