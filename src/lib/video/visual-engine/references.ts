/**
 * 100% Free & Permitted Visual Reference Discovery + Clean-Room Style Extraction.
 *
 * Discovery chain (official APIs only — ZERO scraping, ZERO paid APIs):
 *   1. Official Pinterest API v5 (`https://api.pinterest.com/v5/search/pins`), ONLY
 *      when an authorised Pinterest OAuth token is present.
 *   2. Openverse Official API (`https://api.openverse.org/v1/images/`) — keyless,
 *      100% free public-domain & Creative Commons catalog.
 *   3. Wikimedia Commons Official API (`https://commons.wikimedia.org/w/api.php`) —
 *      keyless, 100% free media repository fallback.
 *   4. Pexels Official API (`https://api.pexels.com/v1/search`) — optional free API
 *      when `PEXELS_API_KEY` is configured in the environment.
 *   5. Local Visual Director Fallback — synthesizes cinematographic palette and
 *      lighting directly from the BookTheme + BookVisualBible when offline.
 *
 * Copyright & Usage Rights Protection:
 *   Reference images are NEVER saved into the project or published in videos.
 *   At most one small thumbnail (< 2 MB) is inspected in memory via `sharp.stats()`
 *   to extract non-copyrightable lighting/colour/contrast measurements into a
 *   `VisualStyleBrief`, after which the pixel buffer is discarded immediately.
 */
import sharp from "sharp";
import { assertPublicUrl } from "../../media/fetch-guard";
import { cosine, lexicalEmbedder, type Embedder } from "../../analysis/embed";
import type { BookTheme } from "../composition/theme-contract";
import { abortOpts, wasCancelled, CancelledError } from "../../cancel";
import { assertFreeReferenceApiUrl, assertFreeThumbnailUrl } from "./cost-guard";
import type {
  BookVisualBible,
  SceneVisualIntent,
  VisualReference,
  VisualStyleBrief,
} from "./types";

const API_TIMEOUT_MS = 6_500;
const THUMB_TIMEOUT_MS = 5_000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024; // 2 MB cap

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function parseHexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [28, 34, 48];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

async function fetchFreeJson(rawUrl: string, headers: Record<string, string> = {}): Promise<unknown> {
  const parsed = assertFreeReferenceApiUrl(rawUrl);
  await assertPublicUrl(parsed.toString());

  const controller = new AbortController();
  const outer = abortOpts().signal;
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "BookReel/1.0 (Local Cinematic Visual Reference Engine)",
        ...headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * 1. Official Pinterest API v5 (optional — requires an official OAuth v5 access token).
 * Searches the authenticated account's accessible Pins via `/v5/search/pins`.
 */
async function queryPinterestOfficial(query: string, accessToken: string): Promise<VisualReference[]> {
  if (!accessToken.trim()) return [];
  const url = `https://api.pinterest.com/v5/search/pins?query=${encodeURIComponent(query)}&page_size=6`;
  const data = (await fetchFreeJson(url, { Authorization: `Bearer ${accessToken.trim()}` })) as {
    items?: Array<{
      id?: string;
      title?: string;
      description?: string;
      alt_text?: string;
      media?: { images?: Record<string, { url?: string }> };
    }>;
  } | null;

  if (!data || !Array.isArray(data.items)) return [];
  const out: VisualReference[] = [];
  for (const item of data.items) {
    const imgs = item.media?.images ?? {};
    const thumb =
      imgs["400x300"]?.url ??
      imgs["600x"]?.url ??
      imgs["150x150"]?.url ??
      Object.values(imgs)[0]?.url;
    const title = [item.title, item.description, item.alt_text].filter(Boolean).join(" — ").trim() || query;
    if (item.id) {
      out.push({
        source: "pinterest",
        id: String(item.id),
        title: title.slice(0, 180),
        license: "pinterest-api-v5-reference-only",
        thumbnailUrl: thumb,
        similarityScore: 0,
      });
    }
  }
  return out;
}

/**
 * 2. Free Keyless Openverse API (`https://api.openverse.org/v1/images/`).
 */
async function queryOpenverse(query: string): Promise<VisualReference[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=8&mature=false`;
  const data = (await fetchFreeJson(url)) as {
    results?: Array<{
      id?: string;
      title?: string;
      creator?: string;
      license?: string;
      thumbnail?: string;
      url?: string;
      tags?: Array<{ name?: string }>;
    }>;
  } | null;

  if (!data || !Array.isArray(data.results)) return [];
  return data.results
    .filter((r) => Boolean(r?.id && (r.thumbnail || r.url)))
    .map((r) => {
      const tags = Array.isArray(r.tags) ? r.tags.map((t) => t?.name).filter(Boolean).join(" ") : "";
      return {
        source: "openverse" as const,
        id: String(r.id),
        title: `${r.title ?? query} ${tags}`.trim().slice(0, 180),
        license: r.license ? `CC-${String(r.license).toUpperCase()}` : "CC",
        creator: r.creator,
        thumbnailUrl: r.thumbnail || r.url,
        similarityScore: 0,
      };
    });
}

/**
 * 3. Free Keyless Wikimedia Commons Official API (`https://commons.wikimedia.org/w/api.php`).
 */
async function queryWikimediaCommons(query: string): Promise<VisualReference[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrnamespace: "6", // File: namespace
    gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: "6",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "480",
    format: "json",
    origin: "*",
  });
  const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
  const data = (await fetchFreeJson(url)) as {
    query?: {
      pages?: Record<
        string,
        {
          pageid?: number;
          title?: string;
          imageinfo?: Array<{
            thumburl?: string;
            url?: string;
            extmetadata?: {
              LicenseShortName?: { value?: string };
              ObjectName?: { value?: string };
            };
          }>;
        }
      >;
    };
  } | null;

  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  const out: VisualReference[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    const thumb = info?.thumburl || info?.url;
    if (!thumb) continue;
    const cleanTitle = (info?.extmetadata?.ObjectName?.value ?? p.title ?? query)
      .replace(/^File:/i, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\.[a-z0-9]{3,4}$/i, "")
      .trim();
    out.push({
      source: "wikimedia",
      id: String(p.pageid ?? cleanTitle),
      title: cleanTitle.slice(0, 180),
      license: info?.extmetadata?.LicenseShortName?.value ?? "Wikimedia-Free",
      thumbnailUrl: thumb,
      similarityScore: 0,
    });
  }
  return out;
}

/**
 * 4. Optional Free Pexels Official API (`https://api.pexels.com/v1/search`).
 */
async function queryPexels(query: string, apiKey: string): Promise<VisualReference[]> {
  if (!apiKey.trim()) return [];
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`;
  const data = (await fetchFreeJson(url, { Authorization: apiKey.trim() })) as {
    photos?: Array<{
      id?: number;
      alt?: string;
      photographer?: string;
      avg_color?: string;
      src?: { medium?: string; small?: string };
    }>;
  } | null;

  if (!data || !Array.isArray(data.photos)) return [];
  return data.photos
    .filter((p) => Boolean(p?.id && (p.src?.medium || p.src?.small)))
    .map((p) => ({
      source: "pexels" as const,
      id: String(p.id),
      title: (p.alt || query).slice(0, 180),
      license: "Pexels-Free",
      creator: p.photographer,
      thumbnailUrl: p.src?.medium || p.src?.small,
      similarityScore: 0,
    }));
}

async function fetchThumbnailBufferEphemeral(rawUrl: string): Promise<Buffer | null> {
  try {
    const checked = assertFreeThumbnailUrl(rawUrl);
    await assertPublicUrl(checked.toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), THUMB_TIMEOUT_MS);
    try {
      const res = await fetch(checked.toString(), {
        method: "GET",
        headers: {
          Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8",
          "User-Agent": "BookReel/1.0 (Local Clean-Room Palette Analyzer)",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const contentLen = Number(res.headers.get("content-length") ?? "0");
      if (contentLen > MAX_THUMB_BYTES) return null;

      const ab = await res.arrayBuffer();
      if (ab.byteLength === 0 || ab.byteLength > MAX_THUMB_BYTES) return null;
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Extract non-copyrightable colour/lighting/contrast statistics from an in-memory
 * image buffer using `sharp`, then let the buffer go out of scope immediately.
 */
export async function extractStyleBriefFromBuffer(
  buf: Buffer,
  ref: VisualReference,
  intent: SceneVisualIntent,
  theme: BookTheme,
): Promise<VisualStyleBrief | null> {
  try {
    const stats = await sharp(buf).resize(96, 96, { fit: "cover" }).removeAlpha().stats();
    const rMean = stats.channels[0]?.mean ?? 40;
    const gMean = stats.channels[1]?.mean ?? 40;
    const bMean = stats.channels[2]?.mean ?? 48;
    const rStd = stats.channels[0]?.stdev ?? 35;
    const gStd = stats.channels[1]?.stdev ?? 35;
    const bStd = stats.channels[2]?.stdev ?? 35;

    const avgStdev = (rStd + gStd + bStd) / 3;
    const contrast: VisualStyleBrief["contrast"] =
      avgStdev > 58 ? "high" : avgStdev > 34 ? "medium" : "low";
    const warmth: VisualStyleBrief["warmth"] =
      rMean - bMean > 14 ? "warm" : bMean - rMean > 14 ? "cool" : "neutral";

    const dom = stats.dominant ?? { r: rMean, g: gMean, b: bMean };
    const dominantHex = rgbToHex(dom.r, dom.g, dom.b);
    const shadowHex = rgbToHex(rMean * 0.32, gMean * 0.32, bMean * 0.36);

    // Boost chroma slightly for a vivid rim/accent light, blended toward theme accent if greyscale.
    const chroma = Math.max(dom.r, dom.g, dom.b) - Math.min(dom.r, dom.g, dom.b);
    const accentHex =
      chroma < 18
        ? theme.palette.accent
        : rgbToHex(Math.min(255, dom.r * 1.28 + 18), Math.min(255, dom.g * 1.18 + 12), Math.min(255, dom.b * 1.15 + 10));

    const lightingNote = `${contrast}-contrast ${warmth} lighting (${dominantHex} key tone, ${shadowHex} deep shadows), ${intent.lighting}`;
    const compositionNote = `vertical 9:16 depth-layered framing with clear foreground silhouette and atmospheric background (${intent.cameraMove})`;

    return {
      dominantHex,
      accentHex,
      shadowHex,
      warmth,
      contrast,
      lightingNote,
      compositionNote,
      atmosphere: intent.atmosphere,
      referenceSource: ref.source,
      referenceTitle: ref.title.slice(0, 100),
      referenceLicense: ref.license,
    };
  } catch {
    return null;
  }
}

export function fallbackLocalStyleBrief(
  intent: SceneVisualIntent,
  bible: BookVisualBible,
  theme: BookTheme,
): VisualStyleBrief {
  const [r, , b] = parseHexRgb(theme.palette.accent);
  const warmth: VisualStyleBrief["warmth"] = r - b > 16 ? "warm" : b - r > 16 ? "cool" : "neutral";
  return {
    dominantHex: bible.colorPalette[1] ?? theme.palette.backdropBase,
    accentHex: theme.palette.accent,
    shadowHex: theme.palette.backdropDeep,
    warmth,
    contrast: "high",
    lightingNote: `${intent.lighting}, ${bible.lightingLanguage}`,
    compositionNote: `vertical 9:16 cinematic depth framing (${intent.cameraMove})`,
    atmosphere: intent.atmosphere,
    referenceSource: "local-director",
  };
}

export interface DiscoverReferenceOptions {
  embedder?: Embedder;
  pinterestAccessToken?: string | null;
  pexelsApiKey?: string | null;
  /** Disable network discovery (e.g. offline mode or deterministic unit tests). */
  offlineOnly?: boolean;
}

/**
 * Discover visual references for one scene via permitted free APIs, rank them
 * semantically against the scene narration, and extract a clean-room `VisualStyleBrief`.
 */
export async function discoverSceneStyleBrief(
  intent: SceneVisualIntent,
  bible: BookVisualBible,
  theme: BookTheme,
  opts: DiscoverReferenceOptions = {},
): Promise<{ brief: VisualStyleBrief; candidates: VisualReference[] }> {
  if (wasCancelled() || abortOpts().signal?.aborted) throw new CancelledError();

  if (opts.offlineOnly || process.env.BOOKREEL_VISUAL_OFFLINE === "1") {
    return { brief: fallbackLocalStyleBrief(intent, bible, theme), candidates: [] };
  }

  const primaryQuery = intent.searchQueries[0] ?? intent.summary;
  const secondaryQuery = intent.searchQueries[1] ?? primaryQuery;
  const pinterestToken = opts.pinterestAccessToken ?? process.env.PINTEREST_ACCESS_TOKEN ?? "";
  const pexelsKey = opts.pexelsApiKey ?? process.env.PEXELS_API_KEY ?? "";

  const candidates: VisualReference[] = [];

  // 1. Official Pinterest API v5 when authorised.
  if (pinterestToken.trim()) {
    const pins = await queryPinterestOfficial(primaryQuery, pinterestToken);
    candidates.push(...pins);
  }

  // 2. Optional Free Pexels API + Free Keyless Openverse API in parallel.
  if (candidates.length < 3) {
    const [pexels, openverse] = await Promise.all([
      pexelsKey.trim() ? queryPexels(primaryQuery, pexelsKey) : Promise.resolve([]),
      queryOpenverse(primaryQuery),
    ]);
    candidates.push(...pexels, ...openverse);
  }

  // 3. Free Keyless Wikimedia Commons fallback when primary query was sparse.
  if (candidates.length < 2) {
    const wiki = await queryWikimediaCommons(secondaryQuery);
    candidates.push(...wiki);
  }

  if (candidates.length === 0) {
    return { brief: fallbackLocalStyleBrief(intent, bible, theme), candidates: [] };
  }

  // Rank candidates semantically against the scene's actual narration + visual subject.
  const embedderObj = opts.embedder ?? lexicalEmbedder;
  try {
    const targetText = `${intent.narration} ${intent.subject} ${intent.environment} ${intent.emotion}`;
    const texts = [targetText, ...candidates.map((c) => c.title)];
    const vectors = await embedderObj.embed(texts).catch(() => lexicalEmbedder.embed(texts));
    const targetVec = vectors[0];
    candidates.forEach((c, idx) => {
      c.similarityScore = Math.round(cosine(targetVec, vectors[idx + 1]) * 1000) / 1000;
    });
    candidates.sort((a, b) => b.similarityScore - a.similarityScore);
  } catch {
    // Keep discovery order if embedder fails.
  }

  // Inspect top candidates until a clean-room style brief is extracted.
  for (const cand of candidates.slice(0, 3)) {
    if (!cand.thumbnailUrl) continue;
    const buf = await fetchThumbnailBufferEphemeral(cand.thumbnailUrl);
    if (!buf) continue;
    const extracted = await extractStyleBriefFromBuffer(buf, cand, intent, theme);
    if (extracted) {
      return { brief: extracted, candidates: candidates.slice(0, 5) };
    }
  }

  // Metadata matched, thumbnail blocked/unreachable — annotate source on fallback brief.
  const top = candidates[0];
  return {
    brief: {
      ...fallbackLocalStyleBrief(intent, bible, theme),
      referenceSource: top.source,
      referenceTitle: top.title.slice(0, 100),
      referenceLicense: top.license,
    },
    candidates: candidates.slice(0, 5),
  };
}
