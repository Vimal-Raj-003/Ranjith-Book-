/**
 * Picking an icon that means what the narration means.
 *
 * Tabler Icons (MIT) ships 5,166 outline icons, each with a category and about
 * ten tags — "acorn" carries oak, nut, seed, forest, autumn, tree. That tag
 * text is what makes semantic matching possible at all: the icon named
 * `chart-line` is found by "things compound over time" because its tags say
 * growth and trend, which no filename match would ever reach.
 *
 * Matching uses the same local embedder as book analysis (`analysis/embed`),
 * so this needs no API and no new model. The 5,166 vectors are computed once
 * and cached under CACHE_ROOT; after that a lookup is one embedding plus a dot
 * product over the index.
 *
 * Below `MIN_SCORE` nothing is returned. An icon that only nearly means the
 * right thing is worse than no icon: the caller falls back to a template that
 * cannot be wrong about meaning (kinetic text of the sentence itself).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CACHE_ROOT } from "../../paths";
import { cosine, lexicalEmbedder, transformersEmbedder, type Embedder } from "../../analysis/embed";
import type { SceneIcon } from "./types";

/**
 * Below this cosine similarity, there is no honest icon for the query.
 *
 * Measured over the filtered index: genuine matches land at 0.41–0.64
 * ("a barrier blocking a path" → `barrier-block` 0.64, "an open book" → `book`
 * 0.43, "two roads diverging" → `road` 0.41), while deliberate nonsense still
 * finds its best neighbour at 0.35–0.38 ("qwertyuiop asdfghjkl" →
 * `question-mark` 0.378). 0.40 separates the two on that sample, so a query
 * with no real picture behind it returns nothing rather than something
 * plausible-looking.
 */
export const MIN_SCORE = 0.4;
/** Lexical matching scores lower for the same relevance; it gets its own floor. */
export const MIN_SCORE_LEXICAL = 0.18;

/**
 * Categories that can never illustrate a concept. Brand marks are logos —
 * a narration about "focus" must not surface a company's logo — and the
 * alphabet/number sets are glyphs, not pictures.
 */
const SKIP_CATEGORIES = new Set(["Brand", "Letters", "Numbers", "Currencies", "Flags"]);

/**
 * Names that must never be matched, whatever they score.
 *
 * `-off` is Tabler's convention for the struck-through variant of an icon:
 * `book-off` is "no book", the NEGATION of what its tags say. Its tags are the
 * same as `book`'s, so it scores the same — and measured on real queries the
 * struck-through variant frequently won ("reading a book" → `book-off`),
 * putting a crossed-out picture on screen under narration that means the
 * opposite. Numbered variants (`clock-hour-9`, `rewind-forward-20`) are
 * arbitrary members of a family whose base icon says the same thing more
 * plainly, and they crowd the results with near-identical ties.
 */
const SKIP_NAME = /(^|-)off$|-\d+$/;

interface TablerEntry {
  name?: string;
  category?: string;
  tags?: string[];
}

export interface IconIndex {
  embedderId: string;
  names: string[];
  /** Query text per icon, parallel to `names`. */
  texts: string[];
  vectors: Float32Array[];
  /** False when the tag metadata could not be read and names alone were used. */
  tagged: boolean;
}

let cached: Promise<IconIndex> | null = null;

/**
 * The package's directory on disk, VERIFIED rather than derived.
 *
 * `@tabler/icons` declares `"exports": { "./*": ["./icons/*"] }`, so the only
 * importable subpaths are the icons themselves — `@tabler/icons/icons.json`
 * and even `@tabler/icons/package.json` do not resolve through Node at all.
 * The metadata is shipped (it is listed in the package's `files`) but is
 * reachable only by path, which means the path has to be right.
 *
 * Deriving it as "three directories above a resolved icon" was wrong inside
 * Next.js: the pipeline runs in the server runtime, where the module's own
 * `import.meta.url` points into Turbopack's virtual space, so the resolver
 * returned a path carrying a `[project]` segment and the arithmetic produced
 * `<cwd>/[project]/node_modules/@tabler/icons` — a directory that does not
 * exist. Every standalone `tsx` run resolved correctly, which is exactly why
 * it survived to a real render before being caught.
 *
 * So: gather candidates from the filesystem, and return the first that
 * actually CONTAINS an icon. A path that cannot be checked is never used.
 * `BOOKREEL_TABLER_DIR` overrides, for an install layout this does not guess.
 */
function candidateRoots(): string[] {
  const override = process.env.BOOKREEL_TABLER_DIR?.trim();
  if (override) return [override];

  // Walk up from the working directory looking for the package. Parents are
  // included so a monorepo that hoists dependencies above the app still finds
  // it. Deliberately NOT `require.resolve`: the package's only export map
  // entry points at `.svg` files, and asking a bundler to resolve an asset is
  // what produced the virtual `[project]` path in the first place — and what
  // Turbopack warns about even when the call is inside a try/catch, because
  // it analyses the call statically.
  const out: string[] = [];
  let dir = process.cwd();
  for (let up = 0; up < 6; up++) {
    out.push(path.join(dir, "node_modules", "@tabler", "icons"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

let rootCache: string | null = null;

/** The package directory, or null when it cannot be found on this machine. */
function packageRoot(): string | null {
  if (rootCache) return rootCache;
  for (const dir of candidateRoots()) {
    if (existsSync(path.join(dir, "icons", "outline", "clock.svg"))) {
      rootCache = dir;
      return dir;
    }
  }
  return null;
}

function outlineDir(): string | null {
  const root = packageRoot();
  return root ? path.join(root, "icons", "outline") : null;
}

/** The text an icon is matched on: its name in words, its category, its tags. */
export function iconText(name: string, entry: TablerEntry): string {
  const words = name.replace(/-/g, " ");
  const tags = (entry.tags ?? []).join(", ");
  return [words, entry.category ?? "", tags].filter(Boolean).join(". ");
}

export class NoIconsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoIconsError";
  }
}

/**
 * The searchable catalogue: every drawable outline icon and the text it is
 * matched on.
 *
 * The icons themselves are the package's supported surface (`./icons/*`) and
 * are read from the directory. The tag metadata is not exported and is read by
 * path — so if it cannot be read, the catalogue is still built from the icon
 * NAMES alone. Matching is then weaker (a name carries "barrier block" but not
 * "obstacle, barricade, roadblock") and `tagged` says so, but icons still
 * work. Losing the tags must not cost the whole feature.
 */
async function readCatalogue(): Promise<{ names: string[]; texts: string[]; tagged: boolean }> {
  const dir = outlineDir();
  if (!dir) {
    throw new NoIconsError(
      "The @tabler/icons package could not be found. Run `npm install` — scenes fall back to showing the narration until it is there.",
    );
  }

  const available = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".svg"))
    .map((f) => f.slice(0, -4))
    .filter((name) => !SKIP_NAME.test(name));

  let meta: Record<string, TablerEntry> | null = null;
  try {
    const root = packageRoot()!;
    meta = JSON.parse(await fs.readFile(path.join(root, "icons.json"), "utf8")) as Record<string, TablerEntry>;
  } catch {
    meta = null;
  }

  const names: string[] = [];
  const texts: string[] = [];
  for (const name of available) {
    const entry = meta?.[name];
    if (entry?.category && SKIP_CATEGORIES.has(entry.category)) continue;
    names.push(name);
    texts.push(entry ? iconText(name, entry) : name.replace(/-/g, " "));
  }
  return { names, texts, tagged: meta !== null };
}

function cacheFile(embedderId: string, tagged: boolean): string {
  const id = embedderId.replace(/[^a-z0-9]+/gi, "-");
  // The suffix matters: an index built from names alone must never be reused
  // once the tag metadata is readable again, and vice versa.
  return path.join(CACHE_ROOT, "models", `tabler-index-${id}${tagged ? "" : "-untagged"}.bin`);
}

/**
 * The index, built once and cached. The cache stores the icon names beside the
 * vectors and is rejected whole if the two disagree — a Tabler upgrade that
 * adds icons must rebuild rather than silently match new names to old vectors.
 */
export async function iconIndex(embedder: Embedder = transformersEmbedder): Promise<IconIndex> {
  if (cached) return cached;
  cached = (async () => {
    const { names, texts, tagged } = await readCatalogue();
    const file = cacheFile(embedder.id, tagged);
    try {
      const buf = await fs.readFile(file);
      const headerLen = buf.readUInt32LE(0);
      const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8")) as {
        names: string[];
        dim: number;
      };
      if (header.names.length === names.length && header.names[0] === names[0] && header.names[header.names.length - 1] === names[names.length - 1]) {
        const floats = new Float32Array(
          buf.buffer.slice(buf.byteOffset + 4 + headerLen, buf.byteOffset + buf.byteLength),
        );
        const vectors = names.map((_, i) => floats.subarray(i * header.dim, (i + 1) * header.dim));
        return { embedderId: embedder.id, names, texts, vectors, tagged };
      }
    } catch {
      /* no cache, or an unreadable one — rebuild below */
    }

    const vectors = await embedder.embed(texts);
    try {
      const dim = vectors[0]?.length ?? 0;
      const header = Buffer.from(JSON.stringify({ names, dim }), "utf8");
      const body = new Float32Array(names.length * dim);
      vectors.forEach((v, i) => body.set(v, i * dim));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(header.length, 0);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.concat([len, header, Buffer.from(body.buffer)]));
    } catch {
      /* the index is usable in memory even if it cannot be cached */
    }
    return { embedderId: embedder.id, names, texts, vectors, tagged };
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/**
 * Test seam: drop everything this module remembers — the built index AND the
 * located package directory. The directory has to go too, or a later call
 * keeps using the one found first and ignores `BOOKREEL_TABLER_DIR`.
 */
export function resetIconIndex(): void {
  cached = null;
  rootCache = null;
}

/** The inner markup of an icon's 24×24 outline SVG, minus Tabler's spacer path. */
export async function iconPaths(name: string): Promise<string | null> {
  try {
    const dir = outlineDir();
    if (!dir) return null;
    const svg = await fs.readFile(path.join(dir, `${name}.svg`), "utf8");
    const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
    return inner
      .replace(/<path\s+stroke="none"[^>]*\/>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  }
}

export interface IconMatch {
  name: string;
  score: number;
}

/**
 * The best icons for a phrase, best first, each above the floor. `exclude`
 * keeps one video from using the same picture for two different ideas.
 */
export async function findIcons(
  query: string,
  count: number,
  opts: { embedder?: Embedder; exclude?: Set<string>; minScore?: number } = {},
): Promise<IconMatch[]> {
  const embedder = opts.embedder ?? transformersEmbedder;
  const text = query.trim();
  if (!text) return [];

  // Anything that goes wrong here — the package missing, the index
  // unreadable, the embedder unavailable — means "no icon for this phrase",
  // never a failed video. The caller already has an honest answer for that:
  // it shows the narration itself. This is not a swallowed bug; the whole
  // template is optional by design, and `iconTrouble` records what happened
  // so a run that quietly lost its icons still says so.
  try {
    return await search(text, count, embedder, opts);
  } catch (err) {
    noteTrouble(err);
    return [];
  }
}

/** The last reason icons were unavailable, for the episode's notes. */
let trouble: string | null = null;

function noteTrouble(err: unknown): void {
  trouble = err instanceof Error ? err.message : String(err);
}

/** What went wrong with icons in this process, if anything. Cleared when read. */
export function takeIconTrouble(): string | null {
  const t = trouble;
  trouble = null;
  return t;
}

async function search(
  text: string,
  count: number,
  embedder: Embedder,
  opts: { exclude?: Set<string>; minScore?: number },
): Promise<IconMatch[]> {
  const index = await iconIndex(embedder);
  const [q] = await embedder.embed([text]);
  const floor = opts.minScore ?? (embedder.id === lexicalEmbedder.id ? MIN_SCORE_LEXICAL : MIN_SCORE);

  const scored: (IconMatch & { rank: number })[] = [];
  for (let i = 0; i < index.names.length; i++) {
    if (opts.exclude?.has(index.names[i])) continue;
    const score = cosine(q, index.vectors[i]);
    if (score < floor) continue;
    // Ties broken toward the plainer name. `clock` and `clock-pin` score
    // within a thousandth of each other on "a clock ticking"; the one with
    // nothing extra bolted on is the one that reads at phone size.
    const parts = index.names[i].split("-").length;
    scored.push({ name: index.names[i], score, rank: score - parts * 0.004 });
  }
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, count).map(({ name, score }) => ({ name, score }));
}

/** Resolve a phrase to one drawable icon, or null when nothing fits well enough. */
export async function resolveIcon(
  query: string,
  opts: { embedder?: Embedder; exclude?: Set<string>; minScore?: number } = {},
): Promise<SceneIcon | null> {
  for (const match of await findIcons(query, 5, opts)) {
    const paths = await iconPaths(match.name);
    if (paths) return { name: match.name, paths, query, score: Math.round(match.score * 1000) / 1000 };
  }
  return null;
}
