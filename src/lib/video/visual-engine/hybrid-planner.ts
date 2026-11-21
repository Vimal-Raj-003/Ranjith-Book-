/**
 * Intelligent Hybrid Cinematic Scene Classifier & Pre-Generation Visual Planner.
 *
 * Inspects every scene's actual spoken narration, book page context, emotional tone,
 * subject matter, and narrative role to:
 *   1. Promote grounded data, contrasts, sequences, and compounding trajectories into
 *      dedicated Motion Graphics scenes (`stat`, `comparison`, `steps`, `timeline`,
 *      `growth-curve`) verified against `groundedIn` and `numberIsSaid`.
 *   2. Automatically classify every scene into the best visual treatment:
 *        - `hybrid-cinematic` (Main Default: layered AI plate + 2.5D depth + 3D/kinetic accents)
 *        - `documentary`      (Biographies, history, people, real places, lived situations)
 *        - `3d-animation`     (Internal mental models, object interactions, visual metaphors)
 *        - `motion-graphics`  (Statistics, comparisons, processes, timelines, diagrams)
 *   3. Produce a complete, structured `SceneVisualPlan` (Section 4) before any asset is
 *      generated, enforcing episode-wide colour grading, non-repeating camera movement,
 *      shot-angle variety, and smooth scene transitions.
 */
import type { ContentPackage } from "../../content/schema";
import { normalizeToken } from "../../ingest/align";
import type { Embedder } from "../../analysis/embed";
import type { BookTheme } from "../composition/theme-contract";
import { resolveIcon } from "../scenes/icons";
import { HERO_GUIDE, heroRanker, isHeroId, type HeroId } from "../scenes/heroes";
import { MAX_ICON_SCENES, MAX_RUN, groundedIn, numberIsSaid, pickKeyword } from "../scenes/validate";
import { BOOK_KINDS, type Scene, type SceneIcon, type SceneTone, type VisualKind } from "../scenes/types";
import type {
  AtmosphereKind,
  CameraMoveKind,
  ColorGradePreset,
  SceneTransitionKind,
  SceneVisualPlan,
  ShotAngleKind,
  VisualTreatment,
} from "./types";

export interface HybridPlanInput {
  bookTitle: string;
  author?: string | null;
  archetype?: string | null;
  pkg: ContentPackage;
  scenes: Scene[];
  theme: BookTheme;
  /** Optional pageIndex -> page words map for strict book-text grounding checks. */
  pageWords?: Map<number, string[]>;
  embedder?: Embedder;
}

export interface HybridPlanOutput {
  scenes: Scene[];
  plans: SceneVisualPlan[];
  colorGrade: ColorGradePreset;
  notes: string[];
}

const TONE_BY_KIND: Record<VisualKind, SceneTone> = {
  "book-page": "warm",
  "book-crop": "warm",
  quote: "warm",
  "kinetic-text": "deep",
  "icon-concept": "cool",
  comparison: "bright",
  steps: "cool",
  "growth-curve": "bright",
  timeline: "cool",
  stat: "deep",
  cinematic: "deep",
};

const SPOKEN_NUMBERS: ReadonlyArray<[RegExp, string, string]> = [
  [/\bone\s+hundred\s+percent\b/i, "100%", "100"],
  [/\bninety\s+percent\b/i, "90%", "90"],
  [/\beighty\s+percent\b/i, "80%", "80"],
  [/\bseventy\s+percent\b/i, "70%", "70"],
  [/\bsixty\s+percent\b/i, "60%", "60"],
  [/\bfifty\s+percent\b/i, "50%", "50"],
  [/\bforty\s+percent\b/i, "40%", "40"],
  [/\bthirty\s+percent\b/i, "30%", "30"],
  [/\btwenty\s+percent\b/i, "20%", "20"],
  [/\bten\s+percent\b/i, "10%", "10"],
  [/\bone\s+percent\b/i, "1%", "1"],
  [/\bone\s+thousand\b/i, "1,000", "1000"],
  [/\bone\s+hundred\b/i, "100", "100"],
  [/\bninety\b/i, "90", "90"],
  [/\beighty\b/i, "80", "80"],
  [/\bseventy\b/i, "70", "70"],
  [/\bsixty\b/i, "60", "60"],
  [/\bfifty\b/i, "50", "50"],
  [/\bforty\b/i, "40", "40"],
  [/\bthirty\b/i, "30", "30"],
  [/\btwenty\b/i, "20", "20"],
  [/\bfifteen\b/i, "15", "15"],
  [/\btwelve\b/i, "12", "12"],
  [/\bten\b/i, "10", "10"],
  [/\bnine\b/i, "9", "9"],
  [/\beight\b/i, "8", "8"],
  [/\bseven\b/i, "7", "7"],
  [/\bsix\b/i, "6", "6"],
  [/\bfive\b/i, "5", "5"],
  [/\bfour\b/i, "4", "4"],
  [/\bthree\b/i, "3", "3"],
];

const STOP_LABEL_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "he", "her", "his", "i", "in", "into", "is", "it", "its", "of", "on", "or", "she", "so",
  "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "what", "when",
  "which", "who", "will", "with", "you", "your", "not", "can", "do", "does", "our", "than",
]);

/**
 * Trailing modifiers, prepositions, articles, and determiners that must NEVER
 * stand as the final word of a rendered motion-graphics label (e.g. preventing
 * `"calls in a single"` when `"day"` was sliced off).
 */
const DANGLING_TAIL_WORDS = new Set([
  ...STOP_LABEL_WORDS,
  "single", "every", "each", "very", "quite", "such", "most", "more", "less",
  "many", "some", "any", "other", "another", "whose", "where", "while", "during",
  "without", "within", "through", "between", "under", "over", "before", "after", "about",
  "because", "since", "though", "although", "unless", "whether", "until", "if",
]);

const CAMERA_SEQUENCE: readonly CameraMoveKind[] = [
  "push-in",
  "pan-right",
  "rise-reveal",
  "pull-back",
  "orbit-drift",
  "pan-left",
];

const SHOT_ANGLE_SEQUENCE: readonly ShotAngleKind[] = [
  "low-angle-heroic",
  "eye-level",
  "wide-establishing",
  "close-intimate",
  "high-angle-overview",
];

const DOCUMENTARY_PEOPLE_RE =
  /\b(authors?|writers?|biograph\w*|histor\w*|philosophers?|emperors?|generals?|soldiers?|doctors?|physicians?|scientists?|researchers?|professors?|teachers?|students?|patients?|workers?|founders?|engineers?|carpenters?|artists?|painters?|musicians?|poets?|mothers?|fathers?|parents|child|children|sons?|daughters?|husbands?|wives|wife|brothers?|sisters?|friends?|strangers?|leaders?|presidents?|kings?|queens?|monks?|prisoners?|survivors?|he|she|him|her|his)\b/i;

const DOCUMENTARY_SETTING_RE =
  /\b(streets?|cities|city|towns?|villages?|rooms?|offices?|desks?|kitchens?|hospitals?|clinics?|wards?|classrooms?|schools?|universities|university|factories|factory|workshops?|studios?|courts?|prisons?|camps?|battlefields?|harbors?|stations?|trains?|libraries|library|houses?|homes?|apartments?|gardens?|markets?|cafes?|churches?|temples?|palaces?|centuries|century|wars?|eras?|archives?)\b/i;

const DOCUMENTARY_ERA_RE = /\b(1[4-9]\d{2}|20[0-2]\d|18th|19th|20th|ancient|roman|athens|london|paris|vienna|new york|tokyo|berlin)\b/i;

const DOCUMENTARY_LIVED_VERB_RE =
  /\b(lived|lives|living|walk(?:ed|s|ing)?|wrote|writes|work(?:ed|s|ing)?|watch(?:ed|es|ing)?|sat|sits|sitting|stood|stands|standing|spoke|told|asked|met|visit(?:ed|s|ing)?|built|fought|surviv(?:ed|es|ing)|grew up|born|died|remember(?:ed|s)?|observ(?:ed|es|ing)|studi(?:ed|es)|discover(?:ed|s)?)\b/i;

const THREE_D_METAPHOR_RE =
  /\b(mind|brain|skull|memory|memories|thought|thoughts|mental|imagination|consciousness|focus|attention|distraction|noise|clarity|loop|habit|habits|cycle|autopilot|repetition|orbit|system|universe|cosmos|network|nodes|web|scales|weigh\w*|balance|trade-?off|chain|shackle|trapped|wall|barrier|resistance|pulse|wave|frequency|metaphor|mechanism|invisible|architecture|blueprint|gravity|pendulum|compass|hourglass|vortex)\b/i;

const METAPHOR_HEROES: ReadonlySet<HeroId> = new Set<HeroId>([
  "mind",
  "focus",
  "loop",
  "orbit",
  "scales",
  "network",
  "chain",
  "wall",
  "pulse",
  "spark",
  "storm",
  "hourglass",
  "clock",
  "growth",
  "heart",
]);

const TRAJECTORY_RE =
  /\b(compound\w*|accumulat\w*|snowball\w*|over time|year after year|day after day|again and again|piles? up|multipl\w*|exponent\w*|curve|trajectory|gradually|steadily\s+grows?|builds?\s+up|doubl(?:ed|es|ing)|tripl(?:ed|es|ing))\b/i;

const TEMPORAL_SEQUENCE_RE =
  /\b(timeline|century|decade|years?|months?|weeks?|morning|noon|afternoon|evening|night|tonight|history|era)\b/i;

function narrationTextOf(scene: Scene, pkg: ContentPackage): string {
  const fromWords = (scene.words ?? []).map((w) => w.word).join(" ").trim();
  if (fromWords) return fromWords;
  if (scene.quote?.text) return scene.quote.text.trim();
  const beat = pkg.beats[scene.beatIndex] ?? pkg.beats[0];
  return beat?.voiceover?.trim() || scene.concept || pkg.hook;
}

function haystacksForScene(scene: Scene, narration: string, pageWords?: Map<number, string[]>): string[] {
  const out = [narration];
  const words = pageWords?.get(scene.source.pageIndex);
  if (words && words.length > 0) {
    const start = Math.max(0, scene.source.startWord);
    const end = Math.max(start, scene.source.endWord);
    out.push(words.slice(start, end + 1).join(" "));
  }
  return out;
}

function cleanPhrase(raw: string, maxWords = 5): string {
  const words = raw
    .replace(/^[\s,;:.!?'"“”‘’—–-]+|[\s,;:.!?'"“”‘’—–-]+$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && STOP_LABEL_WORDS.has(normalizeToken(words[0]))) {
    words.shift();
  }
  // If slicing at `maxWords` would end on a dangling modifier/article right before
  // one completing noun (e.g. "calls in a single" + "day"), allow that 1 completing noun
  // when reasonably short; otherwise slice and strip all dangling tail words.
  let limit = maxWords;
  if (
    words.length > maxWords &&
    DANGLING_TAIL_WORDS.has(normalizeToken(words[maxWords - 1])) &&
    !DANGLING_TAIL_WORDS.has(normalizeToken(words[maxWords])) &&
    words[maxWords].length <= 12
  ) {
    limit = maxWords + 1;
  }
  const sliced = words.slice(0, limit);
  while (sliced.length > 1 && DANGLING_TAIL_WORDS.has(normalizeToken(sliced[sliced.length - 1]))) {
    sliced.pop();
  }
  if (sliced.length === 1 && DANGLING_TAIL_WORDS.has(normalizeToken(sliced[0]))) {
    return "";
  }
  return sliced.join(" ").trim();
}

function extractGroundedStat(
  narration: string,
  concept: string,
  haystacks: string[],
): { value: string; label: string; isTrajectory: boolean } | null {
  const digitMatch = /([$])?\b(\d{1,3}(?:,\d{3})+|\d{1,4})(?:([%x+])|\s+(percent)\b|\b)/i.exec(narration);
  let value = "";
  let digits = "";
  let matchIndex = -1;
  let matchLength = 0;

  if (digitMatch) {
    const prefix = digitMatch[1] ?? "";
    const rawNum = Number(digitMatch[2].replace(/,/g, ""));
    const suffix = digitMatch[3] ?? (digitMatch[4] ? "%" : "");
    const afterToken = narration.slice(digitMatch.index + digitMatch[0].length, digitMatch.index + digitMatch[0].length + 8);
    const beforeToken = narration.slice(Math.max(0, digitMatch.index - 12), digitMatch.index);
    const isEraMarker = /^\s*(?:ad|bc|bce|ce)\b/i.test(afterToken);
    const isCalendarYear =
      !suffix &&
      !prefix &&
      ((rawNum >= 1400 && rawNum <= 2099) || (/\b(?:in|year|since|around|by)\s*$/i.test(beforeToken) && rawNum >= 100 && rawNum <= 2099));
    if (!isEraMarker && !isCalendarYear && rawNum > 0) {
      value = `${prefix}${digitMatch[2]}${suffix}`;
      digits = digitMatch[2].replace(/,/g, "");
      matchIndex = digitMatch.index;
      matchLength = digitMatch[0].length;
    }
  }

  if (!digits) {
    for (const [re, display, d] of SPOKEN_NUMBERS) {
      const m = re.exec(narration);
      if (m) {
        value = display;
        digits = d;
        matchIndex = m.index;
        matchLength = m[0].length;
        break;
      }
    }
  }

  if (!digits || !numberIsSaid(digits, haystacks)) return null;

  const after = matchIndex >= 0 ? narration.slice(matchIndex + matchLength) : "";
  const before = matchIndex > 0 ? narration.slice(Math.max(0, matchIndex - 48), matchIndex) : "";
  const candidateAfter = cleanPhrase(after.split(/[.;:!?]/)[0] ?? "", 4);
  const candidateConcept = cleanPhrase(concept, 4);
  const candidateBefore = cleanPhrase(before.split(/[,.;:!?]/).pop() ?? "", 4);

  const label =
    [candidateAfter, candidateConcept, candidateBefore].find(
      (c) => c.length >= 3 && c.length <= 36 && groundedIn(c, haystacks),
    ) ?? "";

  const isTrajectory = TRAJECTORY_RE.test(narration) && label.length >= 3;
  return { value, label, isTrajectory };
}

function extractGroundedComparison(
  narration: string,
  haystacks: string[],
): { left: string; right: string } | null {
  const patterns: RegExp[] = [
    /\bbetween\s+([^,.;:!?]{3,38}?)\s+and\s+([^,.;:!?]{3,38}?)(?=\s+(?:is|are|was|were|decides?|determines?|means?|lies?|comes?|makes?|separates?|shows?|changes?|can|will|does)\b|[,.;:!?]|$)/i,
    /\bnot\s+([^,.;:!?]{3,34}?)\s*,?\s+but\s+([^,.;:!?]{3,34}?)(?=\s+(?:is|are|was|were|that|which|when|because)\b|[,.;:!?]|$)/i,
    /\binstead\s+of\s+([^,.;:!?]{3,34}?)\s*,\s*([^,.;:!?]{3,34})(?:[,.;:!?]|$)/i,
    /\b([^,.;:!?]{3,32}?)\s+(?:versus|vs\.?)\s+([^,.;:!?]{3,32})(?:[,.;:!?]|$)/i,
    /\bdivided\s+between\s+([^,.;:!?]{3,36}?)\s+and\s+([^,.;:!?]{3,36}?)(?=\s+(?:is|are|was|were)\b|[,.;:!?]|$)/i,
  ];

  for (const re of patterns) {
    const m = re.exec(narration);
    if (!m) continue;
    const trimAdverbial = (s: string) =>
      s.replace(/\s+\b(?:every\s+\w+|each\s+\w+|all\s+day|over\s+time|in\s+life|right\s+now|at\s+work|at\s+night)\b.*$/i, "");
    const left = cleanPhrase(trimAdverbial(m[1]), 4);
    const right = cleanPhrase(trimAdverbial(m[2]), 4);
    if (!left || !right) continue;
    if (normalizeToken(left) === normalizeToken(right)) continue;
    if (left.length < 3 || right.length < 3 || left.length > 34 || right.length > 34) continue;
    if (groundedIn(left, haystacks) && groundedIn(right, haystacks)) {
      return { left, right };
    }
  }
  return null;
}

function extractGroundedSequence(
  narration: string,
  haystacks: string[],
): { kind: "steps" | "timeline"; steps: string[] } | null {
  let parts: string[] = [];
  let explicitTimeline = false;

  const firstSecond = /\bfirst[,:\s]+([^.;!?]{4,48}?)[,;.\s]+(?:second|then|next)[,:\s]+([^.;!?]{4,48}?)(?:[,;.\s]+(?:third|finally)[,:\s]+([^.;!?]{4,48}))?(?:[.;!?]|$)/i.exec(
    narration,
  );
  if (firstSecond) {
    parts = [firstSecond[1], firstSecond[2], firstSecond[3] ?? ""].map((s) => cleanPhrase(s, 5)).filter(Boolean);
  } else if (/\b(?:step\s+by\s+step|process|stages?|phases?|sequence|first\b.*\bthen)\b/i.test(narration)) {
    parts = narration
      .split(/\s*(?:,|;|\bthen\b|\band\s+then\b|—)\s*/i)
      .map((s) => cleanPhrase(s, 5))
      .filter((s) => s.length >= 4 && s.length <= 42);
  } else {
    // Chronological / day-arc / historical progression with >= 2 distinct temporal anchors:
    const temporalCueMatches = narration.match(
      /\b(?:in\s+the\s+morning|every\s+morning|morning|at\s+noon|afternoon|in\s+the\s+evening|evening|at\s+night|tonight|before\s+you\s+sleep|wake\s+up|early\s+on|years?\s+later|months?\s+later|in\s+\d{4}|by\s+\d{4})\b/gi,
    );
    if (temporalCueMatches && new Set(temporalCueMatches.map((m) => normalizeToken(m))).size >= 2) {
      explicitTimeline = true;
      parts = narration
        .split(/\s*(?:,|;|\.|\bthen\b|\band\s+then\b|\bbefore\b(?=.*\b(?:sleep|night|tonight))|—)\s*/i)
        .map((s) => cleanPhrase(s, 5))
        .filter((s) => s.length >= 4 && s.length <= 42);
    }
  }

  const grounded = parts.filter((p) => groundedIn(p, haystacks)).slice(0, 4);
  if (grounded.length < 2) return null;

  // Deduplicate near-identical clauses.
  const unique: string[] = [];
  for (const item of grounded) {
    const norm = normalizeToken(item);
    if (norm && !unique.some((u) => normalizeToken(u) === norm)) unique.push(item);
  }
  if (unique.length < 2) return null;

  const kind: "steps" | "timeline" = explicitTimeline || TEMPORAL_SEQUENCE_RE.test(narration) ? "timeline" : "steps";
  return { kind, steps: unique };
}

function extractGroundedTrajectoryLabel(
  narration: string,
  concept: string,
  haystacks: string[],
): string {
  const cleanedConcept = cleanPhrase(concept, 4);
  if (cleanedConcept.length >= 4 && TRAJECTORY_RE.test(cleanedConcept) && groundedIn(cleanedConcept, haystacks)) {
    return cleanedConcept;
  }
  const clauses = narration
    .split(/\s*(?:,|;|—|\bbecause\b|\bwhen\b|\bwhile\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const m = TRAJECTORY_RE.exec(clause);
    if (!m) continue;
    // Center on the trajectory match and its immediate subject/object words.
    const subClause = clause.replace(/^.*?\b(?:is|are|means?|becomes?)\s+/i, "");
    const candidate = cleanPhrase(subClause, 4) || cleanPhrase(clause, 4);
    if (candidate.length >= 4 && groundedIn(candidate, haystacks)) {
      return candidate;
    }
  }
  return cleanPhrase(concept || narration, 4);
}

async function extractGroundedInfographicConcepts(
  narration: string,
  haystacks: string[],
  usedIcons: Set<string>,
  embedder?: Embedder,
): Promise<{ icons: SceneIcon[]; items: string[] } | null> {
  const cleanNounConcept = (raw: string): string => {
    const trimmed = raw
      .replace(/^\s*(?:keep|use|build|give|make|create|write|share|pick|put|set|hold|turn|bring)\s+/i, "")
      .replace(/\s+\b(?:aligned|focused|centered|pointed|aimed|locked|tied|connected|together)\b.*$/i, "");
    return cleanPhrase(trimmed, 3);
  };

  // Split enumerated noun/concept clauses ("X, Y, and Z" or "from X to Y to Z"):
  const rawClauses = narration
    .split(/\s*(?:,|;|\band\b|\bor\b|—)\s*/i)
    .map(cleanNounConcept)
    .filter((c) => c.length >= 4 && c.length <= 24 && groundedIn(c, haystacks));

  if (rawClauses.length < 2) return null;

  const pickedIcons: SceneIcon[] = [];
  const pickedItems: string[] = [];
  const localUsed = new Set<string>(usedIcons);

  for (const clause of rawClauses) {
    if (pickedItems.length >= 3) break;
    if (pickedItems.some((p) => normalizeToken(p) === normalizeToken(clause))) continue;
    const icon = await resolveIcon(clause, { embedder, exclude: localUsed });
    if (icon && icon.score >= 0.42) {
      localUsed.add(icon.name);
      pickedIcons.push(icon);
      pickedItems.push(clause);
    }
  }

  if (pickedIcons.length < 2) return null;
  for (const ic of pickedIcons) usedIcons.add(ic.name);
  return { icons: pickedIcons, items: pickedItems };
}

function wouldViolateMaxRun(scenes: Scene[], index: number, candidateKind: VisualKind): boolean {
  let run = 1;
  for (let i = index - 1; i >= 0 && scenes[i].kind === candidateKind; i--) run += 1;
  for (let i = index + 1; i < scenes.length && scenes[i].kind === candidateKind; i++) run += 1;
  return run > MAX_RUN;
}

/**
 * Promote eligible `kinetic-text` (and surplus non-hook `cinematic`) scenes to
 * grounded Motion Graphics templates when the spoken narration contains explicit
 * statistics, contrasts, compounding trajectories, or multi-step sequences.
 */
async function promoteMotionGraphicsScenes(
  inputScenes: Scene[],
  pkg: ContentPackage,
  archetype?: string | null,
  pageWords?: Map<number, string[]>,
  embedder?: Embedder,
): Promise<{ scenes: Scene[]; notes: string[] }> {
  const scenes = inputScenes.map((s) => ({ ...s }));
  const notes: string[] = [];
  const usedIcons = new Set<string>();

  for (const s of scenes) {
    for (const ic of s.icons ?? []) usedIcons.add(ic.name);
    if (s.icon) usedIcons.add(s.icon.name);
  }

  const minCinematicFloor = Math.max(2, Math.floor(scenes.length * 0.24));
  let cineCount = scenes.filter((s) => s.kind === "cinematic").length;

  for (let i = 1; i < scenes.length; i++) {
    const scene = scenes[i];
    if (BOOK_KINDS.includes(scene.kind)) continue;
    const narration = narrationTextOf(scene, pkg);
    const docSignals = scoreDocumentarySignals(narration, scene.concept, archetype);
    const isSurplusCine =
      scene.kind === "cinematic" && !scene.cine?.hook && cineCount > minCinematicFloor && docSignals.score < 2.8;
    if (scene.kind !== "kinetic-text" && !isSurplusCine) continue;

    const haystacks = haystacksForScene(scene, narration, pageWords);

    // 1. Grounded comparison ("between X and Y", "not X, but Y", "X vs Y")
    const comp = extractGroundedComparison(narration, haystacks);
    if (comp && !wouldViolateMaxRun(scenes, i, "comparison")) {
      const icons: SceneIcon[] = [];
      for (const side of [comp.left, comp.right]) {
        const icon = await resolveIcon(side, { embedder, exclude: usedIcons });
        if (icon) {
          usedIcons.add(icon.name);
          icons.push(icon);
        }
      }
      if (scene.kind === "cinematic") cineCount -= 1;
      scenes[i] = {
        ...scene,
        kind: "comparison",
        tone: TONE_BY_KIND.comparison,
        left: comp.left,
        right: comp.right,
        icons: icons.length === 2 ? icons : [],
        cine: undefined,
        icon: undefined,
      };
      notes.push(`Scene ${i + 1}: promoted grounded contrast ("${comp.left}" vs "${comp.right}") to motion-graphics comparison.`);
      continue;
    }

    // 2. Grounded number / percentage / compounding trajectory (`stat` or `growth-curve`)
    const statHit = extractGroundedStat(narration, scene.concept, haystacks);
    if (statHit) {
      if (statHit.isTrajectory && !wouldViolateMaxRun(scenes, i, "growth-curve")) {
        if (scene.kind === "cinematic") cineCount -= 1;
        scenes[i] = {
          ...scene,
          kind: "growth-curve",
          tone: TONE_BY_KIND["growth-curve"],
          curve: { points: [4, 8, 14, 24, 40, 64, 96], label: statHit.label },
          cine: undefined,
          icon: undefined,
        };
        notes.push(`Scene ${i + 1}: promoted grounded trajectory ("${statHit.label}") to motion-graphics growth-curve.`);
        continue;
      }
      if (!wouldViolateMaxRun(scenes, i, "stat")) {
        if (scene.kind === "cinematic") cineCount -= 1;
        scenes[i] = {
          ...scene,
          kind: "stat",
          tone: TONE_BY_KIND.stat,
          stat: { value: statHit.value, label: statHit.label },
          cine: undefined,
          icon: undefined,
        };
        notes.push(`Scene ${i + 1}: promoted grounded figure (${statHit.value}) to motion-graphics stat.`);
        continue;
      }
    }

    // 3. Grounded trajectory without explicit digits ("compounds over time", "accumulates day after day")
    if (TRAJECTORY_RE.test(narration) && !wouldViolateMaxRun(scenes, i, "growth-curve")) {
      const curveLabel = extractGroundedTrajectoryLabel(narration, scene.concept, haystacks);
      if (curveLabel.length >= 3 && groundedIn(curveLabel, haystacks)) {
        if (scene.kind === "cinematic") cineCount -= 1;
        scenes[i] = {
          ...scene,
          kind: "growth-curve",
          tone: TONE_BY_KIND["growth-curve"],
          curve: { points: [4, 8, 14, 24, 40, 64, 96], label: curveLabel },
          cine: undefined,
          icon: undefined,
        };
        notes.push(`Scene ${i + 1}: promoted compounding concept ("${curveLabel}") to motion-graphics growth-curve.`);
        continue;
      }
    }

    // 4. Grounded process steps / chronological timeline
    const seq = extractGroundedSequence(narration, haystacks);
    if (seq && !wouldViolateMaxRun(scenes, i, seq.kind)) {
      if (scene.kind === "cinematic") cineCount -= 1;
      scenes[i] = {
        ...scene,
        kind: seq.kind,
        tone: TONE_BY_KIND[seq.kind],
        steps: seq.steps,
        cine: undefined,
        icon: undefined,
      };
      notes.push(`Scene ${i + 1}: promoted ${seq.steps.length}-part sequence to motion-graphics ${seq.kind}.`);
      continue;
    }

    // 5. Grounded multi-concept infographic (`icon-concept`) when 2-3 spoken concepts match icons
    const iconSceneCount = scenes.filter((s) => s.kind === "icon-concept").length;
    if (
      (scene.kind === "kinetic-text" || isSurplusCine) &&
      iconSceneCount < MAX_ICON_SCENES &&
      !wouldViolateMaxRun(scenes, i, "icon-concept") &&
      docSignals.score < 2.8
    ) {
      const infoHit = await extractGroundedInfographicConcepts(narration, haystacks, usedIcons, embedder);
      if (infoHit) {
        if (scene.kind === "cinematic") cineCount -= 1;
        scenes[i] = {
          ...scene,
          kind: "icon-concept",
          tone: TONE_BY_KIND["icon-concept"],
          icons: infoHit.icons,
          items: infoHit.items,
          cine: undefined,
          icon: undefined,
        };
        notes.push(`Scene ${i + 1}: promoted ${infoHit.items.length} grounded concepts (${infoHit.items.join(", ")}) to icon-concept infographic.`);
        continue;
      }
    }

    // 6. When the scene planner fell back to plain `kinetic-text`, upgrade strongly
    // documentary or 3D-metaphor scenes to `cinematic` so they receive genuine
    // documentary plates or Three.js 3D hero sculptures instead of plain text.
    if (scene.kind === "kinetic-text" && !wouldViolateMaxRun(scenes, i, "cinematic")) {
      const combined = `${scene.concept} ${narration}`;
      const wordTokens = scene.words ?? narration.split(/\s+/).filter(Boolean).map((word) => ({ word }));
      if (docSignals.score >= 2.8) {
        const ranker = await heroRanker(embedder);
        const usedHeroes = scenes.flatMap((s) => (s.cine?.hero ? [s.cine.hero] : []));
        const hero = await ranker.pick(combined, usedHeroes);
        const kw = pickKeyword(cleanPhrase(scene.concept, 1), wordTokens);
        scenes[i] = {
          ...scene,
          kind: "cinematic",
          tone: TONE_BY_KIND.cinematic,
          cine: {
            hero,
            keyword: kw && groundedIn(kw, haystacks) ? kw : "",
            lead: "",
          },
          icon: undefined,
        };
        cineCount += 1;
        notes.push(`Scene ${i + 1}: upgraded real-world narration to documentary cinematic treatment.`);
        continue;
      }
      if (THREE_D_METAPHOR_RE.test(combined)) {
        const ranker = await heroRanker(embedder);
        const usedHeroes = scenes.flatMap((s) => (s.cine?.hero ? [s.cine.hero] : []));
        const hero = await ranker.pick(combined, usedHeroes);
        if (hero !== "orb") {
          const kw = pickKeyword(cleanPhrase(scene.concept, 1), wordTokens);
          scenes[i] = {
            ...scene,
            kind: "cinematic",
            tone: TONE_BY_KIND.cinematic,
            cine: {
              hero,
              keyword: kw && groundedIn(kw, haystacks) ? kw : "",
              lead: "",
            },
            icon: undefined,
          };
          cineCount += 1;
          notes.push(`Scene ${i + 1}: upgraded metaphorical narration to 3D animation (${hero}).`);
        }
      }
    }
  }

  return { scenes, notes };
}

export function selectEpisodeColorGrade(theme: BookTheme, archetype?: string | null): ColorGradePreset {
  const arch = (archetype ?? "").toLowerCase();
  if (arch === "history" || arch === "biography" || arch === "memoir") return "archival-sepia";
  const id = theme.id.toLowerCase();
  if (id === "noir" || id === "terminal") return "cool-noir";
  if (id === "paper" || id === "editorial") return "archival-sepia";
  if (id === "blueprint") return "crisp-editorial";
  if (id === "neon" || id === "spotlight") return "golden-amber";
  return "warm-cinema";
}

function scoreDocumentarySignals(narration: string, concept: string, archetype?: string | null): { score: number; reasons: string[] } {
  const combined = `${concept} ${narration}`;
  let score = 0;
  const reasons: string[] = [];
  const arch = (archetype ?? "").toLowerCase();

  if (arch === "biography" || arch === "memoir" || arch === "history" || arch === "story") {
    score += 1.5;
    reasons.push(`${arch} book context`);
  }
  if (DOCUMENTARY_ERA_RE.test(combined)) {
    score += 2.2;
    reasons.push("historical era or real-world place");
  }
  if (DOCUMENTARY_PEOPLE_RE.test(combined)) {
    score += 1.6;
    reasons.push("human subject or biographical figure");
  }
  if (DOCUMENTARY_SETTING_RE.test(combined)) {
    score += 1.5;
    reasons.push("concrete real-world location");
  }
  if (DOCUMENTARY_LIVED_VERB_RE.test(combined)) {
    score += 1.3;
    reasons.push("observational lived-event narration");
  }
  return { score, reasons };
}

function score3dAnimationSignals(scene: Scene, narration: string): { score: number; reasons: string[] } {
  const combined = `${scene.concept} ${narration}`;
  let score = 0;
  const reasons: string[] = [];
  const hero = scene.cine?.hero;

  if (hero && hero !== "orb" && isHeroId(hero)) {
    score += 1.4;
    if (METAPHOR_HEROES.has(hero)) {
      score += 1.1;
      reasons.push(`3D symbolic hero (${hero}: ${HERO_GUIDE[hero].shows})`);
    }
  }
  if (THREE_D_METAPHOR_RE.test(combined)) {
    score += 1.8;
    reasons.push("abstract concept or internal mental/systemic metaphor");
  }
  return { score, reasons };
}

function inferScenePurpose(scene: Scene, index: number, total: number, treatment: VisualTreatment): string {
  if (index === 0 || scene.cine?.hook) return "opening-hook";
  if (index === total - 1) return "closing-takeaway";
  if (BOOK_KINDS.includes(scene.kind)) return "book-source-evidence";
  if (treatment === "motion-graphics") {
    if (scene.kind === "stat" || scene.kind === "growth-curve") return "quantitative-proof";
    if (scene.kind === "comparison") return "conceptual-contrast";
    return "structured-process";
  }
  if (treatment === "documentary") return "real-world-context";
  if (treatment === "3d-animation") return "visual-metaphor-model";
  return "dramatic-story-beat";
}

function buildGroundedCallout(scene: Scene, narration: string, haystacks: string[]): string | null {
  if (scene.cine?.hook) return null;
  const candidate = cleanPhrase(scene.concept, 3);
  if (candidate && candidate.length >= 4 && candidate.length <= 24 && groundedIn(candidate, haystacks)) {
    const kwNorm = normalizeToken(scene.cine?.keyword ?? "");
    if (!kwNorm || normalizeToken(candidate) !== kwNorm) {
      return candidate;
    }
  }
  void narration;
  return null;
}

function pickNonRepeatingCamera(index: number, treatment: VisualTreatment, prev: CameraMoveKind | null): CameraMoveKind {
  const preferred: CameraMoveKind[] =
    treatment === "documentary"
      ? ["pan-right", "push-in", "pan-left", "pull-back", "rise-reveal"]
      : treatment === "3d-animation"
        ? ["orbit-drift", "push-in", "rise-reveal", "pull-back"]
        : ["push-in", "rise-reveal", "pan-right", "orbit-drift", "pull-back", "pan-left"];

  const startIdx = index % preferred.length;
  for (let k = 0; k < preferred.length; k++) {
    const candidate = preferred[(startIdx + k) % preferred.length];
    if (candidate !== prev) return candidate;
  }
  return CAMERA_SEQUENCE[index % CAMERA_SEQUENCE.length];
}

function pickNonRepeatingShotAngle(
  index: number,
  scene: Scene,
  treatment: VisualTreatment,
  prev: ShotAngleKind | null,
): ShotAngleKind {
  const preferred: ShotAngleKind[] = scene.cine?.hook
    ? ["low-angle-heroic", "wide-establishing"]
    : treatment === "documentary"
      ? ["eye-level", "wide-establishing", "close-intimate"]
      : treatment === "3d-animation"
        ? ["low-angle-heroic", "high-angle-overview", "close-intimate"]
        : ["wide-establishing", "low-angle-heroic", "close-intimate", "eye-level", "high-angle-overview"];

  const startIdx = index % preferred.length;
  for (let k = 0; k < preferred.length; k++) {
    const candidate = preferred[(startIdx + k) % preferred.length];
    if (candidate !== prev) return candidate;
  }
  return SHOT_ANGLE_SEQUENCE[index % SHOT_ANGLE_SEQUENCE.length];
}

function pickTransition(index: number, current: VisualTreatment, next: VisualTreatment | null): SceneTransitionKind {
  if (!next) return "dissolve";
  if (current === "motion-graphics" || next === "motion-graphics") return "rise-wipe";
  if (current === "3d-animation" || next === "3d-animation") return "depth-push";
  if (current === "documentary" && next === "documentary") return "dissolve";
  const cycle: readonly SceneTransitionKind[] = ["depth-push", "dissolve", "pan-slide", "rise-wipe"];
  return cycle[index % cycle.length];
}

function atmosphereForScene(scene: Scene, treatment: VisualTreatment): AtmosphereKind {
  const env = scene.environment ?? "still";
  if (treatment === "documentary") {
    if (env === "storm") return "rain";
    if (env === "dusk" || env === "deep") return "mist";
    return "dust";
  }
  if (env === "storm") return "rain";
  if (env === "dawn") return "rays";
  if (env === "warm") return "embers";
  if (env === "dusk") return "mist";
  if (env === "still" || env === "grid") return "still";
  return "dust";
}

/**
 * Classify every scene in the episode and construct its complete pre-generation
 * `SceneVisualPlan` before any ComfyUI or rendering work starts.
 */
export async function classifyAndPlanEpisodeScenes(input: HybridPlanInput): Promise<HybridPlanOutput> {
  const promotion = await promoteMotionGraphicsScenes(
    input.scenes,
    input.pkg,
    input.archetype,
    input.pageWords,
    input.embedder,
  );
  const scenes = promotion.scenes;
  const notes = [...promotion.notes];
  const colorGrade = selectEpisodeColorGrade(input.theme, input.archetype);

  // First pass: choose visual treatment per scene.
  let threeDAssigned = 0;
  const rawTreatments: Array<{ treatment: VisualTreatment; reason: string }> = scenes.map((scene) => {
    const narration = narrationTextOf(scene, input.pkg);

    // Explicit motion-graphics & kinetic-typography scenes:
    if (
      scene.kind === "stat" ||
      scene.kind === "comparison" ||
      scene.kind === "steps" ||
      scene.kind === "timeline" ||
      scene.kind === "growth-curve" ||
      scene.kind === "icon-concept" ||
      scene.kind === "kinetic-text"
    ) {
      return {
        treatment: "motion-graphics",
        reason: `Structured ${scene.kind} explanation fits clean motion graphics & kinetic typography.`,
      };
    }

    // Grounded book-page / quote scenes stay true to the real page scan while participating in hybrid continuity:
    if (BOOK_KINDS.includes(scene.kind)) {
      const doc = scoreDocumentarySignals(narration, scene.concept, input.archetype);
      return doc.score >= 3.0
        ? {
            treatment: "documentary",
            reason: `Book passage cites real-world/historical context (${doc.reasons.join(", ")}).`,
          }
        : {
            treatment: "hybrid-cinematic",
            reason: "Grounded book page framed with cohesive cinematic lighting, camera drift, and synchronized sweep.",
          };
    }

    // `cinematic` scenes: decide between `documentary`, `3d-animation`, and `hybrid-cinematic`.
    const doc = scoreDocumentarySignals(narration, scene.concept, input.archetype);
    const threeD = score3dAnimationSignals(scene, narration);

    // Opening hook defaults to rich `hybrid-cinematic` (or `documentary` for overtly historical/biographical hooks)
    // so frame 0 arrests attention with layered depth + word-synced typography.
    if (scene.cine?.hook || scene.index === 0) {
      if (doc.score >= 3.4 && doc.score > threeD.score) {
        return {
          treatment: "documentary",
          reason: `Opening hook depicts real-world/historical subject (${doc.reasons.join(", ")}).`,
        };
      }
      return {
        treatment: "hybrid-cinematic",
        reason: "Opening hook combines cinematic plate depth, 2.5D parallax, atmospheric lighting, and word-synced typography.",
      };
    }

    if (doc.score >= 2.8 && doc.score >= threeD.score) {
      return {
        treatment: "documentary",
        reason: `Scene describes real-world/human context (${doc.reasons.join(", ")}).`,
      };
    }

    // Cap procedural Three.js `3d-animation` to at most 1 strongly metaphorical centerpiece per episode
    // so the remaining cinematic beats receive story-accurate 9:16 2.5D ComfyUI plates rather than bare 3D wireframes.
    if (threeDAssigned < 1 && threeD.score >= 3.8 && scene.cine?.hero && scene.cine.hero !== "orb") {
      threeDAssigned += 1;
      return {
        treatment: "3d-animation",
        reason: `Conceptual metaphor best expressed in Three.js 3D space (${threeD.reasons.join(", ")}).`,
      };
    }

    return {
      treatment: "hybrid-cinematic",
      reason: "Narrative beat combines cinematic imagery, 3-layer 2.5D parallax, camera motion, and atmospheric depth.",
    };
  });

  // Ensure a multi-scene episode never accidentally turns *every* cinematic scene into pure 3D when ComfyUI can enrich the hook/anchor scenes:
  const cineIndices = scenes.map((s, idx) => (s.kind === "cinematic" ? idx : -1)).filter((idx) => idx >= 0);
  const plateBearingCine = cineIndices.filter(
    (idx) => rawTreatments[idx].treatment === "hybrid-cinematic" || rawTreatments[idx].treatment === "documentary",
  );
  if (cineIndices.length > 0 && plateBearingCine.length === 0) {
    const firstCine = cineIndices[0];
    rawTreatments[firstCine] = {
      treatment: "hybrid-cinematic",
      reason: "Primary cinematic anchor upgraded to hybrid-cinematic for visual depth.",
    };
  }

  // Second pass: build complete 11-field `SceneVisualPlan` with camera & shot-angle continuity.
  let prevCam: CameraMoveKind | null = null;
  let prevAngle: ShotAngleKind | null = null;
  const plans: SceneVisualPlan[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const narration = narrationTextOf(scene, input.pkg);
    const haystacks = haystacksForScene(scene, narration, input.pageWords);
    const { treatment, reason } = rawTreatments[i];
    const nextTreatment = i + 1 < scenes.length ? rawTreatments[i + 1].treatment : null;

    const cameraMovement = pickNonRepeatingCamera(i, treatment, prevCam);
    const shotAngle = pickNonRepeatingShotAngle(i, scene, treatment, prevAngle);
    prevCam = cameraMovement;
    prevAngle = shotAngle;

    const transitionToNext = pickTransition(i, treatment, nextTreatment);
    const prevTransition: SceneTransitionKind =
      i === 0 ? "dissolve" : plans[i - 1]?.transitionToNext ?? "dissolve";
    scene.transitionIn = prevTransition;

    const atmosphere = atmosphereForScene(scene, treatment);
    const heroId = scene.cine?.hero ?? "orb";
    const heroInfo = isHeroId(heroId) ? HERO_GUIDE[heroId] : HERO_GUIDE.orb;

    const isPlateScene =
      scene.kind === "cinematic" && (treatment === "hybrid-cinematic" || treatment === "documentary");
    const isPure3dScene = scene.kind === "cinematic" && treatment === "3d-animation";
    const isMotionGraphics = treatment === "motion-graphics";

    const accent3d =
      isPlateScene &&
      treatment === "hybrid-cinematic" &&
      !scene.cine?.hook &&
      Boolean(scene.cine?.hero && scene.cine.hero !== "orb" && THREE_D_METAPHOR_RE.test(`${scene.concept} ${narration}`));

    const calloutText =
      isPlateScene && treatment === "hybrid-cinematic"
        ? buildGroundedCallout(scene, narration, haystacks)
        : scene.stat?.label || scene.curve?.label || null;

    const requiredAssets: string[] = [];
    if (isPlateScene) {
      requiredAssets.push("comfyui-plate", "depth-map", "threejs-25d-mesh");
      if (accent3d) requiredAssets.push(`threejs-accent:${heroId}`);
    } else if (isPure3dScene) {
      requiredAssets.push(`threejs-hero:${heroId}`, "threejs-lighting-rig");
    } else if (BOOK_KINDS.includes(scene.kind)) {
      requiredAssets.push(scene.kind === "quote" ? "grounded-book-quote" : "book-page-scan", "synchronized-sweep");
    } else {
      requiredAssets.push(`motion-template:${scene.kind}`);
      if ((scene.icons?.length ?? 0) > 0 || scene.icon) requiredAssets.push("tabler-vector-icons");
    }

    const mainSubject = isPure3dScene
      ? heroInfo.shows
      : BOOK_KINDS.includes(scene.kind)
        ? `Book page ${scene.source.pageIndex + 1} passage`
        : isMotionGraphics
          ? scene.stat
            ? `${scene.stat.value} ${scene.stat.label}`.trim()
            : scene.left && scene.right
              ? `${scene.left} vs ${scene.right}`
              : scene.curve?.label || scene.concept || narration.slice(0, 64)
          : scene.concept || narration.slice(0, 72);

    const environmentDesc = BOOK_KINDS.includes(scene.kind)
      ? `${scene.environment ?? "warm"} studio backdrop behind tactile paper card`
      : treatment === "documentary"
        ? `authentic real-world ${scene.environment ?? "dusk"} location with natural practical depth`
        : treatment === "3d-animation"
          ? `sculptural Three.js ${scene.environment ?? "deep"} space with volumetric rim light`
          : `layered ${scene.environment ?? "deep"} cinematic world with foreground-to-background separation`;

    const foreground = isPlateScene
      ? treatment === "documentary"
        ? "subtle natural dust & soft lens vignette framing the subject"
        : `bokeh ${atmosphere} particles & word-synced typographic plane${calloutText ? ` ("${calloutText}")` : ""}`
      : isPure3dScene
        ? "floating specular particles & crisp kinetic headline"
        : BOOK_KINDS.includes(scene.kind)
          ? "word-accurate marker highlight sweep"
          : `crisp ${scene.kind} motion-graphics elements`;

    const midground = isPlateScene
      ? `depth-displaced 2.5D subject (${mainSubject})`
      : isPure3dScene
        ? `animated 3D ${heroId} sculpture (${heroInfo.shows})`
        : BOOK_KINDS.includes(scene.kind)
          ? `framed ${scene.shot ?? "medium"} book page card`
          : `animated ${scene.kind} data/concept card`;

    const background = `cohesive ${colorGrade} ${scene.environment ?? "deep"} atmosphere`;

    const lighting =
      treatment === "documentary"
        ? "restrained naturalistic directional key light with authentic shadow falloff"
        : treatment === "3d-animation"
          ? "three-point sculptural rim & key lighting with soft bloom"
          : treatment === "motion-graphics"
            ? "high-contrast editorial studio illumination for instant legibility"
            : "dramatic volumetric chiaroscuro with warm/cool depth separation";

    plans.push({
      sceneIndex: scene.index,
      scenePurpose: inferScenePurpose(scene, i, scenes.length, treatment),
      narration,
      mainSubject,
      environmentAndBackground: environmentDesc,
      visualTreatment: treatment,
      treatmentReason: reason,
      sceneKind: scene.kind,
      requiredAssets,
      compositionAndAngle: {
        shotAngle,
        foreground,
        midground,
        background,
      },
      cameraMovement,
      depthAndParallax: {
        enabled: isPlateScene || isPure3dScene,
        intensity: isPlateScene ? (treatment === "documentary" ? 0.55 : 0.92) : isPure3dScene ? 1.0 : 0.18,
        foregroundSeparation: isPlateScene || isPure3dScene,
        accent3d,
      },
      motionGraphics: {
        active: isMotionGraphics || Boolean(calloutText) || Boolean(scene.cine?.hook),
        template: isMotionGraphics ? scene.kind : scene.cine?.hook ? "hook-kinetic" : calloutText ? "cine-callout" : null,
        calloutText,
      },
      lightingAndAtmosphere: {
        lighting,
        atmosphere,
        colorGrade,
      },
      transitionToNext,
    });
  }

  const counts: Record<VisualTreatment, number> = {
    "hybrid-cinematic": 0,
    documentary: 0,
    "3d-animation": 0,
    "motion-graphics": 0,
  };
  for (const p of plans) counts[p.visualTreatment] += 1;
  const summaryParts = (Object.entries(counts) as Array<[VisualTreatment, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  notes.push(`Hybrid visual planner: ${summaryParts.join(", ")} (grade: ${colorGrade}).`);

  return { scenes, plans, colorGrade, notes };
}
