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

/** A spec as it may sit in the column: everything required except `rev`. */
type StoredSpec = Omit<ThumbSpec, "rev"> & { rev?: unknown };

function isSpec(value: unknown): value is StoredSpec {
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
 * `rev` is NOT part of what makes a spec valid. Every row written before the
 * field existed lacks it, and refusing those would empty the library of
 * posters that are sitting on disk, perfectly good. A missing or nonsensical
 * `rev` reads as 0: the URL for that poster is simply the one with no history.
 */
function withRev(spec: StoredSpec): ThumbSpec {
  const rev = typeof spec.rev === "number" && Number.isFinite(spec.rev) ? spec.rev : 0;
  return { ...spec, rev };
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
  return parsed.filter(isSpec).map(withRev);
}

export function serializeThumbnails(specs: ThumbSpec[]): string {
  return JSON.stringify(specs);
}

/**
 * Resolve a requested key to a file, or null.
 *
 * The URL contributes NOTHING to the path, and neither does the stored row. The
 * key is matched, byte for byte, against the keys already recorded on that
 * episode, and the path is then DERIVED: `THUMBS_ROOT/<episodeId>/<key>.jpg`,
 * which is the only path a successful resolution could ever have had.
 *
 * It used to read `spec.path` and reject anything that was not exactly that
 * derived path, which made the stored string redundant — its only possible
 * contribution was a refusal. And it refused a great deal: this install
 * inherited 50 of its 115 postered episodes from a `G:\YT-Book\` copy of the
 * app, so their rows name that install's thumbs directory while all six poster
 * files sit, complete and correct, in the local one. 43% of the library showed
 * an initials tile, and the diagnosis "the data is stale, re-render them" was
 * wrong: the files were never missing, only the string beside them was.
 *
 * Deriving keeps every guarantee the comparison gave and removes a hostile
 * input from the read path rather than adding one:
 *   - `isThumbKey` still gates the key before it is compared or joined;
 *   - the key must still appear, byte for byte, in this episode's own stored
 *     specs, so an unrecorded key resolves to nothing even if a file with that
 *     name exists on disk;
 *   - the filename is still pinned to `<key>.jpg`, so a record can never name
 *     another file;
 *   - `episodeId` must still name one directory directly under `THUMBS_ROOT`,
 *     which is now checked here instead of falling out of the comparison. It
 *     always comes from a row this process just read, but deriving a path from
 *     it makes it part of the path, so it is confined like anything else.
 *
 * A row that points at `/etc/passwd` is therefore no longer a refusal — it is
 * simply ignored, and the episode's own poster is served.
 */
export function selectThumb(specs: ThumbSpec[], key: unknown, episodeId: string): ThumbSpec | null {
  if (!isThumbKey(key)) return null;

  const spec = specs.find((s) => s.key === key);
  if (!spec) return null;

  const root = path.resolve(THUMBS_ROOT);
  const dir = path.resolve(root, episodeId);
  if (path.dirname(dir) !== root) return null;

  return { ...spec, path: path.join(dir, `${key}.jpg`) };
}
