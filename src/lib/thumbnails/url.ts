/**
 * The URL a poster is fetched, shown and downloaded by.
 *
 * The delivery route answers with `Cache-Control: private, max-age=31536000,
 * immutable`, and a redo overwrites `<key>.jpg` in place under the SAME path.
 * `immutable` is a promise that a URL's bytes never change, so the only honest
 * way to redo a poster is to change its URL: `v` is the file's revision
 * (`ThumbSpec.rev`), which moves whenever the file is rewritten. The route
 * ignores `v`; it exists to be a different cache key.
 *
 * Every link to a poster goes through here -- the `<img src>` AND the download
 * `<a href>`. Versioning only the preview would leave the full-resolution file
 * an operator saves and uploads to YouTube pinned to its first headline for a
 * year.
 *
 * Client-safe: no imports, no filesystem.
 */
export function thumbUrl(episodeId: string, thumb: { key: string; rev: number }, size?: "grid"): string {
  const base = `/api/episodes/${episodeId}/thumbnail/${thumb.key}?v=${thumb.rev}`;
  return size ? `${base}&size=${size}` : base;
}
