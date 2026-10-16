/**
 * SERVER-ONLY. Which account each platform is meant to publish to.
 *
 * THE RULE THIS FILE EXISTS FOR: a display label is not an identity. Anyone can
 * name a YouTube channel "@between_pages", and an upload response happily echoes
 * the title back. So the expected handle lives here, in the environment, and the
 * thing it is compared with is a handle the platform's own API returned for the
 * stored credential — see `ConnectionView.verifiedHandle` and `judgeIdentity`.
 *
 * The defaults are the two accounts this install publishes to. They are
 * overridable, not hidden: an operator who moves the brand to a new handle
 * changes one variable and restarts, and nothing in the code needs to know.
 */
import { displayHandle } from "./connect";
import type { PlatformId } from "./limits";
import type { EnvLike } from "./youtube/secrets";

/** The environment variables that override the expected handle. Names, not values. */
export const EXPECTED_HANDLE_ENV: Record<PlatformId, string> = {
  youtube: "BOOKREEL_YOUTUBE_HANDLE",
  instagram: "BOOKREEL_INSTAGRAM_HANDLE",
};

export const DEFAULT_EXPECTED_HANDLE: Record<PlatformId, string> = {
  youtube: "@betweenpages08-l4d",
  instagram: "@between_pages",
};

/**
 * The handle this install expects on a platform, in `@handle` display form.
 *
 * A blank or whitespace-only override falls back to the default rather than
 * becoming an empty expectation. (`judgeIdentity` independently refuses to match
 * against an empty one, so even a bug here fails closed.)
 */
export function expectedHandle(platform: PlatformId, env: EnvLike = process.env): string {
  const override = displayHandle(env[EXPECTED_HANDLE_ENV[platform]]);
  return override !== "" ? override : DEFAULT_EXPECTED_HANDLE[platform];
}
