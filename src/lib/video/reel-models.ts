/**
 * 10-Model Pro Motion Video Director & Zero-Repeat Selector (`reel-models.ts`).
 *
 * Defines BookReel's 10 core Pro Motion models (the 4 Clean White Kinetic models +
 * the 6 Pro Reference Motion models), automatic non-repeating rotation across
 * episodes (`chooseAutoReelModel`), and fallback scene-rig assignment (`applyReelModelToScenes`).
 */
import type { ContentPackage } from "../content/schema";
import type { BookThemeId } from "./composition/themes";
import { ALL_PRO_MODEL_KINDS, type ProModelKind, type ProModelMeta } from "./scenes/pro-stage";
import type { Scene } from "./scenes/types";

export const REEL_MODEL_AUTO = "auto" as const;

export const ALL_REEL_MODEL_IDS = [
  "kinetic-emerald",
  "kinetic-cobalt",
  "kinetic-coral",
  "kinetic-violet",
  "paper-collage",
  "daylight-orbital",
  "aurora-portal",
  "dynamic-island",
  "crimson-cutout",
  "violet-roi",
] as const;

export const TEN_CORE_REEL_MODEL_IDS = ALL_REEL_MODEL_IDS;

export type ReelModelId = (typeof ALL_REEL_MODEL_IDS)[number];
export type ReelModelSetting = typeof REEL_MODEL_AUTO | ReelModelId;

export function isReelModelId(v: unknown): v is ReelModelId {
  return typeof v === "string" && (ALL_REEL_MODEL_IDS as readonly string[]).includes(v);
}

export function isReelModelSetting(v: unknown): v is ReelModelSetting {
  return v === REEL_MODEL_AUTO || isReelModelId(v);
}

export function preferredThemeForReelModel(model: ReelModelId): BookThemeId {
  switch (model) {
    case "kinetic-emerald":
    case "kinetic-cobalt":
    case "daylight-orbital":
      return "quiet";
    case "kinetic-coral":
    case "crimson-cutout":
      return "editorial";
    case "kinetic-violet":
    case "paper-collage":
      return "marginalia";
    case "aurora-portal":
    case "violet-roi":
      return "neon";
    case "dynamic-island":
      return "terminal";
  }
}

const MODEL_KEYWORDS: Readonly<Record<ReelModelId, RegExp>> = {
  "kinetic-emerald": /\b(?:fast|speed|second|choose|decision|clarity|attention|audience|habit|time)\b/i,
  "kinetic-cobalt": /\b(?:task|list|work|productiv|calendar|meeting|cut|remove|less|system|busy)\b/i,
  "kinetic-coral": /\b(?:money|pay|cost|perk|motivat|employee|manage|benefit|raise|leader|reward)\b/i,
  "kinetic-violet": /\b(?:study|focus|mind|brain|memory|distract|learn|think|concentrat|deep)\b/i,
  "paper-collage": /\b(?:history|stoic|philosophy|diary|ancient|pain|wisdom|classic|author|book|century)\b/i,
  "daylight-orbital": /\b(?:remember|story|feel|rhythm|step|guide|method|process|ordinary|routine)\b/i,
  "aurora-portal": /\b(?:percent|data|growth|profit|boost|struggle|disconnect|company|team|metric)\b/i,
  "dynamic-island": /\b(?:rule|pillar|skill|layer|stack|ingredient|part|anatomy|tool|modern)\b/i,
  "crimson-cutout": /\b(?:crisis|strong|comeback|prime|power|fight|fear|trap|pressure|win|courage)\b/i,
  "violet-roi": /\b(?:return|value|result|outcome|invest|effort|gain|leverage|lead|compound)\b/i,
};

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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
    const tieBreak = ((seed + idx * 7 + offset * 3) % 17) * 0.04;
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

export function pickNonRepeatingProModel(
  text: string,
  pool: readonly ProModelKind[],
  used: Set<ProModelKind>,
  epSeed: number,
  sceneIdx: number,
): ProModelKind {
  const available = pool.filter((k) => !used.has(k));
  const activePool = available.length > 0 ? available : [...pool];
  const chosen = activePool[(epSeed + sceneIdx * 7 + hashSeed(text)) % activePool.length];
  used.add(chosen);
  return chosen;
}

export function buildDynamicProMeta(kind: ProModelKind, scene: Scene, pkg: ContentPackage): ProModelMeta {
  const beat = pkg.beats[scene.beatIndex] ?? pkg.beats[0];
  const vo = beat?.voiceover ?? scene.concept ?? pkg.title;
  const concept = shortPhrase(scene.concept, shortPhrase(pkg.title, "Core Insight", 3), 4);
  const key = shortPhrase(scene.cine?.keyword, "Key Factor", 2);
  const lead = shortPhrase(scene.cine?.lead, "Baseline", 2);
  const numMatch = /\b(\d+(?:\.\d+)?(?:,\d{3})*(?:%|s|x|\+)?)\b/i.exec(vo);

  if (kind === "barcelona-timeline") {
    return {
      rows: [
        { pin: "PHASE 01", title: shortPhrase(vo, "Initial Spark", 4), sub: vo },
        { pin: "PHASE 02", title: shortPhrase(key, "Turning Point", 4), sub: vo },
        { pin: "PHASE 03", title: shortPhrase(pkg.cta, "Final Outcome", 4), sub: pkg.cta },
      ],
    };
  }

  return {
    kicker: concept.toUpperCase(),
    badge: key.toUpperCase(),
    statBig: numMatch ? numMatch[1].slice(0, 6) : "94%",
    leftTitle: lead,
    rightTitle: `${key} ✓`,
    calloutTag: "INSIGHT",
    calloutText: vo.length <= 44 ? vo : `${vo.slice(0, 42).trimEnd()}…`,
  };
}

export function applyReelModelToScenes(
  model: ReelModelId,
  scenes: Scene[],
  pkg: ContentPackage,
): Scene[] {
  if (scenes.length === 0) return scenes;
  const epSeed = hashSeed(`${model}::${pkg.ideaKey}::${pkg.title}`);
  const usedPro = new Set<ProModelKind>();

  return scenes.map((s, idx) => {
    if (s.kind !== "cinematic" || !s.cine) return { ...s, sceneModel: model };
    if (idx === scenes.length - 1 && scenes.length > 2) {
      return { ...s, sceneModel: model };
    }
    const beatVo = pkg.beats[s.beatIndex]?.voiceover ?? s.concept ?? "";
    const rig = pickNonRepeatingProModel(beatVo, ALL_PRO_MODEL_KINDS, usedPro, epSeed, idx);
    return {
      ...s,
      sceneModel: model,
      cine: {
        ...s.cine,
        proModel: rig,
        proMeta: buildDynamicProMeta(rig, s, pkg),
        vectorMode: false,
        plate: undefined,
      },
    };
  });
}
