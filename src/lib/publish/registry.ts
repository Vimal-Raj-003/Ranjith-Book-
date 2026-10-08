/**
 * Which publisher serves which platform.
 *
 * YouTube now has a real provider; Instagram still does not, and so still falls
 * back to the assisted handoff. That asymmetry is the registry doing its job:
 * the entry below is the ONLY line outside `youtube/` that knows a YouTube
 * integration exists. `state.ts` asks the registry rather than naming a
 * platform, the routes go through `Publisher`, and `PublishCenter` renders
 * whatever capabilities come back as data.
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
 * WHY THE FACTORY TAKES A CONTEXT. A real provider acts on behalf of ONE user:
 * the grant it uses is that user's. The alternative — a module-level provider
 * that looks the current user up itself — would mean a credential lookup inside
 * something that is constructed at import time, and no way for a test to drive
 * it. So the caller, which already knows who is asking, says so. `ctx` is
 * optional, and a provider given no user id reports itself unconfigured rather
 * than reaching for whatever grant it can find.
 */
import type { PlatformId } from "./limits";
import type { Publisher } from "./contract";
import { manualHandoff } from "./manual";
import { youTubePublisher } from "./youtube/publisher";
import type { EnvLike } from "./youtube/secrets";

/** Who a publisher is acting for. */
export interface PublisherContext {
  /** The signed-in user whose platform grant is to be used. */
  userId?: string | null;
  /** Injectable for tests: the whole provider can be driven against a mocked API. */
  fetchImpl?: typeof fetch;
  env?: EnvLike;
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
};

/** Is there a provider for this platform that could actually upload? */
export function hasRealPublisher(platform: PlatformId): boolean {
  return PUBLISHERS[platform] !== undefined;
}

/** The provider for this platform: the real one if there is one, otherwise the handoff. */
export function publisherFor(platform: PlatformId, ctx: PublisherContext = {}): Publisher {
  const make = PUBLISHERS[platform];
  return make ? make(ctx) : manualHandoff(platform);
}
