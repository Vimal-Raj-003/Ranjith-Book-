import type { ThumbSpec } from "@/lib/thumbnails/types";

/** What a thumbnail looks like to the browser. */
export interface PublicThumb {
  key: string;
  aspect: ThumbSpec["aspect"];
  variant: ThumbSpec["variant"];
  width: number;
  height: number;
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
  return specs.map(({ key, aspect, variant, width, height }) => ({
    key,
    aspect,
    variant,
    width,
    height,
  }));
}
