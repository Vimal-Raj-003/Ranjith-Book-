/**
 * Which low-poly shape stands in for a resolved icon — Phase 4's second
 * advanced-visual module, for `icon-concept` scenes.
 *
 * Deliberately conservative and purely lexical, the same discipline
 * `emphasis.ts` holds itself to and for the same reason: no model call, no
 * network, the same icon classified the same way on every run. A small,
 * fixed vocabulary of five built-in Three.js primitive geometries — nothing
 * here is a per-icon 3D asset, so there is no authoring backlog the way
 * `lottie.ts`'s hand-drawn clips have one.
 */
import type { SceneIcon } from "./types";

/**
 * Deliberately five SINGLE-GROUP Three.js primitives, not the more obvious
 * cone/cylinder pair for "growth"/"money": measured directly against a real
 * `hyperframes render` (screenshot-capture, hardware GPU) — not just a live
 * page read — `CylinderGeometry` painted as fully transparent in the
 * captured frame while `TorusGeometry` and `IcosahedronGeometry`, built and
 * driven by the exact same code, rendered correctly. `ConeGeometry` shares
 * `CylinderGeometry`'s one structural difference from the three that work:
 * both are built from multiple internal geometry GROUPS (side surface +
 * end cap(s), Three.js's own per-group-material mechanism, present even
 * with a single material supplied), where Torus/Icosahedron/Octahedron are
 * each one ungrouped geometry — so it is excluded on the same evidence
 * rather than kept and hoped to be fine. Direct page reads (Playwright,
 * `chrome-headless-shell`, single- and 12-way-parallel, hardware and
 * SwiftShader) never reproduced the failure at all — only a REAL
 * screenshot-based capture did, twice, identically — which is exactly the
 * class of gap `verify-lottie.mjs`'s own header already warns a live
 * `evaluate()` read can never expose.
 */
export type ThreeShapeKind = "tetrahedron" | "sphere" | "torus" | "octahedron" | "icosahedron";

/**
 * Keyword groups, checked in this fixed order so two groups that could both
 * match a name (rare, given how narrow each list is) resolve the same way on
 * every run. `icosahedron` is not listed: it is the fallback for a name that
 * matches nothing below, not a keyword group of its own — the same "a word
 * matching nothing is just a word" rule `classifyEmphasis` follows.
 */
const SHAPE_WORDS: [ThreeShapeKind, string[]][] = [
  [
    "tetrahedron",
    ["growth", "grow", "increase", "rising", "rise", "climb", "chart", "trend", "trending", "rocket", "launch", "peak", "summit", "mountain", "scale", "up", "arrow-up", "arrow-up-right", "arrow-up-left"],
  ],
  [
    "sphere",
    ["money", "coin", "coins", "cash", "wallet", "currency", "bank", "dollar", "price", "budget", "fund", "piggy", "receipt", "credit-card"],
  ],
  [
    "torus",
    ["clock", "time", "calendar", "hourglass", "history", "alarm", "cycle", "loop", "refresh", "repeat", "rotate", "recur"],
  ],
  [
    "octahedron",
    ["bulb", "idea", "light", "lightbulb", "spark", "sparkle", "solution", "brain", "target", "focus", "key", "puzzle", "diamond", "gem", "star"],
  ],
];

/**
 * An icon slug's own dash-separated words, its QUERY's whole words, and the
 * slug ITSELF — lowercased. The slug is kept whole as well as split so a
 * multi-word keyword like "credit-card" can match the same way a single
 * word like "coin" does; splitting alone would leave it looking for a
 * token that never occurs, since no split token ever contains a dash.
 */
function tokensFor(icon: SceneIcon): string[] {
  const name = icon.name.toLowerCase();
  const nameWords = name.split(/[^a-z0-9]+/).filter(Boolean);
  const queryWords = icon.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [name, ...nameWords, ...queryWords];
}

/**
 * The low-poly shape for a resolved icon. Never null — unlike `lottieFor`,
 * there is no "no accent" option here: a Three.js treatment either replaces
 * the flat icon or (on any runtime failure) never appears at all, and that
 * fallback is decided in the browser, not by returning nothing here. An
 * icon that matches no keyword group gets `icosahedron`, a generic faceted
 * "concept" shape, rather than the narration going unillustrated in 3D.
 */
export function shapeForIcon(icon: SceneIcon): ThreeShapeKind {
  const tokens = new Set(tokensFor(icon));
  for (const [shape, words] of SHAPE_WORDS) {
    for (const word of words) {
      if (tokens.has(word)) return shape;
    }
  }
  return "icosahedron";
}
