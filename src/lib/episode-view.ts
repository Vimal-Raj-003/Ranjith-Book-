import type { ThumbSpec } from "@/lib/thumbnails/types";

/** What a thumbnail looks like to the browser. */
export interface PublicThumb {
  key: string;
  aspect: ThumbSpec["aspect"];
  variant: ThumbSpec["variant"];
  width: number;
  height: number;
  /** Goes in the poster's URL so a redone poster is a new URL. See `ThumbSpec.rev`. */
  rev: number;
}

/**
 * The operator-edited poster fields, as every reader should see them.
 *
 * `||`, not `??`, on purpose: an empty string in either column means "nothing
 * was set", exactly as NULL does. A hand-edited row or an older writer can leave
 * `""` where the default is NULL, and the readers that disagreed about that
 * would show a blank headline field or select a poster called "". One function,
 * so the list, the detail route and the edit route cannot drift.
 */
export function posterFields(row: { thumbChoice?: string | null; thumbHeadline?: string | null }): {
  thumbChoice: string | null;
  thumbHeadline: string | null;
} {
  return { thumbChoice: row.thumbChoice || null, thumbHeadline: row.thumbHeadline || null };
}

/**
 * Strip `path` before a thumbnail crosses the wire.
 *
 * `ThumbSpec.path` is an absolute filesystem path under `WORK_ROOT`. The
 * client never needs it — it fetches bytes from
 * `/api/episodes/[id]/thumbnail/[key]`, which resolves the path server-side
 * from the same stored record. Sending it anyway would publish the operator's
 * directory layout to every page, and would invite a future client to send a
 * path back as if it were trustworthy input.
 */
export function publicThumbs(specs: ThumbSpec[]): PublicThumb[] {
  return specs.map(({ key, aspect, variant, width, height, rev }) => ({
    key,
    aspect,
    variant,
    width,
    height,
    rev,
  }));
}
