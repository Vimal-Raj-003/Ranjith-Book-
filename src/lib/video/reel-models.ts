/**
 * 7-Model HyperFrames Video Director + Smart `"auto"` Selector (`reel-models.ts`).
 *
 * Gives BookReel operators 7 distinct viral/ultra-pro video production models
 * PLUS an `"auto"` mode that scores each book idea/episode and rotates cleanly
 * across all 7 models without repeating back-to-back:
 *
 *   1. `vision-bento`          — Ultra-Pro VisionOS Glass Bento & Live Telemetry
 *   2. `investigative-dossier` — Ultra-Pro Investigative Dark-Room Dossier & Evidence Board
 *   3. `neuro-lab`             — Ultra-Pro Neon Neuroscience & Physics Trajectory Lab
 *   4. `trifecta-viral`        — 3-in-1 Trifecta Hybrid Master (2.5D + 3D + Vector + Vox Ivory)
 *   5. `dankoe-vector`         — Dan Koe Minimalist Pitch-Black Geometric Vector Motion
 *   6. `vox-explainer`         — Vox Tactile Cream Paper-Collage & Actionable Checklist
 *   7. `magnates-cinema`       — MagnatesMedia 2.5D Dark Documentary & Live 3D Sculpture
 */
import type { ContentPackage } from "../content/schema";
import type { BookThemeId } from "./composition/themes";
import type { ProModelKind, ProModelMeta } from "./scenes/pro-stage";
import type { Scene } from "./scenes/types";

export const REEL_MODEL_AUTO = "auto" as const;

export const ALL_REEL_MODEL_IDS = [
  "vision-bento",
  "investigative-dossier",
  "neuro-lab",
  "trifecta-viral",
  "dankoe-vector",
  "vox-explainer",
  "magnates-cinema",
] as const;

export type ReelModelId = (typeof ALL_REEL_MODEL_IDS)[number];
export type ReelModelSetting = typeof REEL_MODEL_AUTO | ReelModelId;

export function isReelModelId(v: unknown): v is ReelModelId {
  return typeof v === "string" && (ALL_REEL_MODEL_IDS as readonly string[]).includes(v);
}

export function isReelModelSetting(v: unknown): v is ReelModelSetting {
  return v === REEL_MODEL_AUTO || isReelModelId(v);
}

/** Preferred theme palette paired with each of the 7 models when `theme` setting is `"auto"`. */
export function preferredThemeForReelModel(model: ReelModelId): BookThemeId {
  switch (model) {
    case "vision-bento":
    case "dankoe-vector":
      return "terminal";
    case "vox-explainer":
      return "editorial";
    case "neuro-lab":
      return "blueprint";
    case "investigative-dossier":
    case "magnates-cinema":
    case "trifecta-viral":
      return "spotlight";
  }
}

const MODEL_KEYWORDS: Readonly<Record<ReelModelId, RegExp>> = {
  "vision-bento": /\b(?:habit|routine|health|workout|daily|streak|goal|progress|compound|build|step|practice|system|plan)\b/i,
  "investigative-dossier": /\b(?:history|city|crowd|people|war|power|state|law|crime|case|secret|empire|collapse|terror|hundred|million|society)\b/i,
  "neuro-lab": /\b(?:brain|mind|lab|experiment|test|science|neural|hand|speed|fast|reaction|impulse|physics|measure|subject)\b/i,
  "trifecta-viral": /\b(?:choice|equal|paralyz|weigh|balance|hesitat|decide|alternative|option|value|dilemma)\b/i,
  "dankoe-vector": /\b(?:focus|attention|willpower|discipline|volition|clarity|mental|philosophy|abstract|force|thought)\b/i,
  "vox-explainer": /\b(?:guide|food|recipe|buddy|swap|learn|explain|how\s+to|tip|fix|boring|simple|checklist)\b/i,
  "magnates-cinema": /\b(?:dark|fear|regret|danger|shadow|wealth|money|ambition|trap|obsess|rival|defeat|strong)\b/i,
};

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically picks the best-matching model out of the 7 models for `text`,
 * while avoiding `exclude` so multi-video `"auto"` batches and consecutive runs
 * automatically cycle across all 7 distinct models!
 */
export function chooseAutoReelModel(
  text: string,
  exclude: Iterable<string> = [],
  offset = 0,
): ReelModelId {
  const used = new Set<string>();
  for (const m of exclude) {
    if (isReelModelId(m)) used.add(m);
  }
  const pool: ReelModelId[] =
    used.size < ALL_REEL_MODEL_IDS.length
      ? ALL_REEL_MODEL_IDS.filter((m) => !used.has(m))
      : [...ALL_REEL_MODEL_IDS];

  const seed = hashSeed(`${text}#${offset}`);
  let best = pool[seed % pool.length];
  let bestScore = -1;

  pool.forEach((model, idx) => {
    const matches = text.match(new RegExp(MODEL_KEYWORDS[model].source, "gi"));
    // Small deterministic tie-breaker rotated by `seed + offset` so neutral texts distribute evenly across all 7 models
    const tieBreak = ((seed + idx * 7 + offset * 3) % 13) * 0.05;
    const score = (matches ? matches.length : 0) + tieBreak;
    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  });

  return best;
}

function shortPhrase(raw: string | undefined, fallback: string, maxWords = 3): string {
  const cleaned = (raw ?? "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, maxWords).join(" ");
}

function buildDynamicProMeta(kind: ProModelKind, scene: Scene, pkg: ContentPackage): ProModelMeta {
  const beat = pkg.beats[scene.beatIndex] ?? pkg.beats[0];
  const vo = beat?.voiceover ?? scene.concept ?? pkg.title;
  const concept = shortPhrase(scene.concept, shortPhrase(pkg.title, "Core Insight", 3), 4);
  const key = shortPhrase(scene.cine?.keyword, "Key Factor", 2);
  const numMatch = /\b(\d+(?:,\d{3})*(?:%|\+)?)\b/.exec(vo);

  if (kind === "streak-shield") {
    return {
      kicker: concept.toUpperCase(),
      badge: "CONSISTENT",
      calloutTag: key.toUpperCase(),
      calloutText: vo.length <= 46 ? vo : `${vo.slice(0, 44).trimEnd()}…`,
    };
  }
  if (kind === "obstacle-radar") {
    return {
      kicker: "ADAPTIVE PATH ENGINE",
      badge: "LOCKED ON",
      leftTitle: key,
      rightTitle: shortPhrase(scene.cine?.lead, "Daily Friction", 2),
    };
  }
  if (kind === "compound-blip") {
    return {
      kicker: concept.toUpperCase(),
      badge: "LONG-TERM",
      leftTitle: "SHORT-TERM DIP",
      rightTitle: key.toUpperCase(),
    };
  }
  if (kind === "crowd-asymmetry") {
    return {
      kicker: `CASE STUDY · ${concept.toUpperCase()}`,
      badge: "ASYMMETRY",
      statBig: numMatch ? numMatch[1].slice(0, 5) : "1%",
      leftTitle: key,
      rightTitle: "WIDER FIELD",
      calloutTag: "INSIGHT",
      calloutText: vo.length <= 48 ? vo : `${vo.slice(0, 46).trimEnd()}…`,
    };
  }
  if (kind === "barcelona-timeline") {
    const b0 = pkg.beats[Math.max(0, scene.beatIndex - 1)]?.voiceover ?? vo;
    const b1 = vo;
    const b2 = pkg.beats[Math.min(pkg.beats.length - 1, scene.beatIndex + 1)]?.voiceover ?? pkg.cta;
    return {
      rows: [
        { pin: "PHASE 1", title: shortPhrase(b0, "Initial Spark", 4), sub: b0 },
        { pin: "PHASE 2", title: shortPhrase(b1, "Turning Point", 4), sub: b1 },
        { pin: "PHASE 3", title: shortPhrase(b2, "Final Outcome", 4), sub: b2 },
      ],
    };
  }
  if (kind === "lab-apparatus") {
    return {
      kicker: `ANALYSIS · ${concept.toUpperCase()}`,
      badge: "ACTIVE TEST",
      leftTitle: shortPhrase(scene.cine?.lead, "IMPULSE A", 2),
      rightTitle: key,
    };
  }
  return {
    kicker: `TRAJECTORY · ${concept.toUpperCase()}`,
    badge: "VALUE SHIFT",
    leftTitle: "1ST IMPULSE",
    rightTitle: `${key} ✓`,
    calloutTag: "SHIFT",
    calloutText: vo.length <= 46 ? vo : `${vo.slice(0, 44).trimEnd()}…`,
  };
}

/**
 * Applies the chosen model's signature scene-level choreography (`vectorMode`,
 * dynamic `proModel` + `proMeta`, live 3D sculpture slots, and plate balance)
 * onto `scenes` right before SFX synthesis & HTML composition.
 */
export function applyReelModelToScenes(
  model: ReelModelId,
  scenes: Scene[],
  pkg: ContentPackage,
): Scene[] {
  if (scenes.length === 0) return scenes;

  if (model === "dankoe-vector") {
    return scenes.map((s) => {
      if (s.kind !== "cinematic" || !s.cine) {
        return { ...s, environment: "grid", bgImageSrc: undefined };
      }
      return {
        ...s,
        environment: "grid",
        cine: { ...s.cine, vectorMode: true, proModel: undefined, plate: undefined },
      };
    });
  }

  if (model === "vox-explainer") {
    return scenes.map((s) => {
      if (s.kind !== "cinematic" || !s.cine) {
        return { ...s, environment: "warm", bgImageSrc: undefined };
      }
      return {
        ...s,
        environment: "warm",
        cine: { ...s.cine, vectorMode: true, proModel: undefined, plate: undefined },
      };
    });
  }

  if (model === "magnates-cinema") {
    // Keep ComfyUI 2.5D plates on hook/finale, and ensure at least one mid-video cinematic scene shows live 3D sculpture
    let freedOne3d = false;
    return scenes.map((s, idx) => {
      if (s.kind === "cinematic" && s.cine && idx > 0 && idx < scenes.length - 1 && !freedOne3d) {
        freedOne3d = true;
        return {
          ...s,
          cine: { ...s.cine, plate: undefined, vectorMode: false, proModel: undefined },
        };
      }
      return s;
    });
  }

  if (model === "trifecta-viral") {
    let assigned3d = false;
    let assignedVec = false;
    return scenes.map((s, idx) => {
      if (s.kind !== "cinematic" || !s.cine || idx === 0 || idx === scenes.length - 1) return s;
      if (!assigned3d) {
        assigned3d = true;
        return { ...s, cine: { ...s.cine, plate: undefined, vectorMode: false, proModel: undefined } };
      }
      if (!assignedVec) {
        assignedVec = true;
        return { ...s, environment: "grid", cine: { ...s.cine, plate: undefined, vectorMode: true, proModel: undefined } };
      }
      return s;
    });
  }

  // Ultra-Pro Models (`vision-bento`, `investigative-dossier`, `neuro-lab`):
  const modelSeq: Record<"vision-bento" | "investigative-dossier" | "neuro-lab", ProModelKind[]> = {
    "vision-bento": ["streak-shield", "obstacle-radar", "compound-blip"],
    "investigative-dossier": ["crowd-asymmetry", "barcelona-timeline"],
    "neuro-lab": ["lab-apparatus", "hand-swerve-arc"],
  };
  const seq = modelSeq[model];
  let proCursor = 0;

  return scenes.map((s, idx) => {
    if (s.kind !== "cinematic" || !s.cine) return s;
    // Leave the final CTA scene as pure atmospheric cinema / 3D
    if (idx === scenes.length - 1 && scenes.length > 2) return s;
    // For investigative-dossier & neuro-lab, keep hook atmospheric/vector and put rich Pro Models on body scenes;
    // for vision-bento, put `streak-shield` right on Beat 0 hook too!
    if (idx === 0 && model !== "vision-bento") {
      if (model === "neuro-lab") {
        return { ...s, cine: { ...s.cine, vectorMode: true, plate: undefined } };
      }
      return s;
    }
    if (proCursor < seq.length) {
      const chosenKind = seq[proCursor++];
      const keepBgPlate = model === "investigative-dossier" ? s.cine.plate : undefined;
      return {
        ...s,
        cine: {
          ...s.cine,
          proModel: chosenKind,
          proMeta: buildDynamicProMeta(chosenKind, s, pkg),
          vectorMode: false,
          plate: keepBgPlate,
        },
      };
    }
    return s;
  });
}
