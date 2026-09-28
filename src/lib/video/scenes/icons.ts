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
import path from "node:path";
import { createRequire } from "node:module";
import { CACHE_ROOT } from "../../paths";
import { cosine, lexicalEmbedder, transformersEmbedder, type Embedder } from "../../analysis/embed";
import type { SceneIcon } from "./types";

const require = createRequire(import.meta.url);

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
}

let cached: Promise<IconIndex> | null = null;

/**
 * The package root, found by resolving an icon rather than the metadata file.
 * `@tabler/icons` declares `"exports": { "./*": ["./icons/*"] }`, so every
 * subpath resolves INSIDE `icons/` — `@tabler/icons/icons.json` and even
 * `@tabler/icons/package.json` do not resolve at all. One known icon does, and
 * the root is two directories above it.
 */
function packageRoot(): string {
  return path.dirname(path.dirname(path.dirname(require.resolve("@tabler/icons/outline/clock.svg"))));
}

function iconsJsonPath(): string {
  return path.join(packageRoot(), "icons.json");
}

function outlineDir(): string {
  return path.join(packageRoot(), "icons", "outline");
}

/** The text an icon is matched on: its name in words, its category, its tags. */
export function iconText(name: string, entry: TablerEntry): string {
  const words = name.replace(/-/g, " ");
  const tags = (entry.tags ?? []).join(", ");
  return [words, entry.category ?? "", tags].filter(Boolean).join(". ");
}

async function readCatalogue(): Promise<{ names: string[]; texts: string[] }> {
  const json = JSON.parse(await fs.readFile(iconsJsonPath(), "utf8")) as Record<string, TablerEntry>;
  const available = new Set(
    (await fs.readdir(outlineDir())).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)),
  );
  const names: string[] = [];
  const texts: string[] = [];
  for (const [name, entry] of Object.entries(json)) {
    if (!available.has(name)) continue;
    if (entry.category && SKIP_CATEGORIES.has(entry.category)) continue;
    if (SKIP_NAME.test(name)) continue;
    names.push(name);
    texts.push(iconText(name, entry));
  }
  return { names, texts };
}

function cacheFile(embedderId: string): string {
  return path.join(CACHE_ROOT, "models", `tabler-index-${embedderId.replace(/[^a-z0-9]+/gi, "-")}.bin`);
}

/**
 * The index, built once and cached. The cache stores the icon names beside the
 * vectors and is rejected whole if the two disagree — a Tabler upgrade that
 * adds icons must rebuild rather than silently match new names to old vectors.
 */
export async function iconIndex(embedder: Embedder = transformersEmbedder): Promise<IconIndex> {
  if (cached) return cached;
  cached = (async () => {
    const { names, texts } = await readCatalogue();
    const file = cacheFile(embedder.id);
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
        return { embedderId: embedder.id, names, texts, vectors };
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
    return { embedderId: embedder.id, names, texts, vectors };
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** Test seam: drop the in-process index (and let a different embedder be used). */
export function resetIconIndex(): void {
  cached = null;
}

/** The inner markup of an icon's 24×24 outline SVG, minus Tabler's spacer path. */
export async function iconPaths(name: string): Promise<string | null> {
  try {
    const svg = await fs.readFile(path.join(outlineDir(), `${name}.svg`), "utf8");
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
