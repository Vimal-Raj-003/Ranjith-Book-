import path from "node:path";
import { THUMBS_ROOT, type ThumbSpec } from "./types";

/**
 * A key is only ever a bare filename stem. This is defence in depth — the real
 * guarantee is the exact-match against the keys stored on the episode below —
 * but it means a crafted key is rejected before it is ever compared, string
 * matched, or joined to a path.
 *
 * Anything with a slash, a backslash, a dot-segment, a NUL, or a leading dot
 * fails: `..%2Fetc%2Fpasswd` arrives here already percent-decoded by the router.
 */
const KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;

export function isThumbKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  if (key.includes("..") || key.includes("/") || key.includes("\\") || key.includes("\0")) return false;
  return KEY_RE.test(key);
}

function isSpec(value: unknown): value is ThumbSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.path === "string" &&
    (v.aspect === "9:16" || v.aspect === "16:9") &&
    (v.variant === "quote" || v.variant === "bold" || v.variant === "split") &&
    typeof v.width === "number" &&
    typeof v.height === "number"
  );
}

/**
 * An episode row, as far as this module is concerned. Structural rather than
 * Prisma's `Episode` so it compiles both before and after the client is
 * regenerated for the new column.
 *
 * Naming the parameter type at all is the point: `parseThumbnails` used to take
 * `unknown`, and every call site that passed `episode.thumbnails` — the column
 * — instead of `episode` — the row — typechecked perfectly and silently
 * returned no thumbnails. Both API routes shipped with exactly that mistake,
 * so the library and the inspector showed nothing while six images sat on disk.
 */
export interface ThumbnailRow {
  thumbnails?: unknown;
}

/**
 * Read the JSON column off an episode row.
 *
 * Takes `unknown` and reads the field structurally rather than typing against
 * Prisma's `Episode`, so this compiles both before and after the client is
 * regenerated for the new column — a row without the field has no thumbnails.
 * Malformed JSON is not an error worth a 500: it means no thumbnails.
 */
export function parseThumbnails(row: ThumbnailRow | null | undefined): ThumbSpec[] {
  const raw = row && typeof row === "object" ? (row as { thumbnails?: unknown }).thumbnails : undefined;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSpec);
}

export function serializeThumbnails(specs: ThumbSpec[]): string {
  return JSON.stringify(specs);
}

/**
 * Resolve a requested key to a file, or null.
 *
 * The URL contributes NOTHING to the path. The key is matched, byte for byte,
 * against the keys already recorded on that episode; the path comes from the
 * matched record and is then confined to `THUMBS_ROOT/<episodeId>` anyway, so
 * even a poisoned database row cannot be used to read an arbitrary file.
 */
export function selectThumb(specs: ThumbSpec[], key: unknown, episodeId: string): ThumbSpec | null {
  if (!isThumbKey(key)) return null;

  const spec = specs.find((s) => s.key === key);
  if (!spec) return null;

  const dir = path.resolve(path.join(THUMBS_ROOT, episodeId));
  const file = path.resolve(spec.path);
  if (path.dirname(file) !== dir) return null;
  if (path.basename(file) !== `${key}.jpg`) return null;

  return { ...spec, path: file };
}
