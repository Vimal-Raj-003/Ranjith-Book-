import type { EnvLike } from "./youtube/secrets";
import type { PlatformId } from "./limits";
import { AppError } from "../errors";

/** Instagram is prepared but never executes until the operator explicitly enables it. */
export function publishingEnabled(platform: PlatformId, env: EnvLike = process.env): boolean {
  return platform !== "instagram" || env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED === "1";
}

export function assertPublishingEnabled(platform: PlatformId, env: EnvLike = process.env): void {
  if (!publishingEnabled(platform, env)) {
    throw new AppError("publishing_disabled", "Instagram publishing is disabled. YouTube scheduling can continue independently.", 409);
  }
}
