import type { ContentPackage } from "../../content/schema";
import type { BookTheme } from "../composition/theme-contract";
import type { Scene } from "../scenes/types";
import { getSetting } from "../../db";
import { resolveProvider, resolveCodexApiKey, type CliProvider } from "../../content/cli";
import { runCliJson } from "../../content/cli-provider";
import { abortOpts, wasCancelled, CancelledError } from "../../cancel";
import type {
  AtmosphereKind,
  BookVisualBible,
  CameraMoveKind,
  SceneVisualIntent,
  SceneVisualPlan,
  ShotAngleKind,
  VisualTreatment,
} from "./types";

export interface AnalyzeVisualsInput {
  bookTitle: string;
  author?: string | null;
  archetype?: string | null;
  pkg: ContentPackage;
  scenes: Scene[];
  /** Optional structured scene plans from `hybrid-planner.ts`. */
  scenePlans?: ReadonlyMap<number, SceneVisualPlan>;
  theme: BookTheme;
  /** Optional provider override for tests; defaults to free CLI resolution. */
  cliProviderOverride?: CliProvider | null;
  /** When true, skips CLI subprocesses and uses deterministic local analysis. */
  localOnly?: boolean;
}

export interface AnalyzeVisualsResult {
  source: "cli" | "local-heuristic";
  bible: BookVisualBible;
  intents: Map<number, SceneVisualIntent>;
  notes: string[];
}

const CAMERA_MOVES: readonly CameraMoveKind[] = [
  "push-in",
  "pull-back",
  "pan-right",
  "pan-left",
  "rise-reveal",
  "orbit-drift",
];

const ATMOSPHERES: readonly AtmosphereKind[] = [
  "dust",
  "mist",
  "embers",
  "rain",
  "rays",
  "still",
];

const VISUAL_DIRECTOR_SCHEMA = {
  type: "object",
  required: ["bible", "scenes"],
  properties: {
    bible: {
      type: "object",
      required: ["visualStyle", "eraAndSetting", "lightingLanguage", "colorPalette", "recurringCharacters", "moodKeywords"],
      properties: {
        visualStyle: { type: "string" },
        eraAndSetting: { type: "string" },
        lightingLanguage: { type: "string" },
        colorPalette: { type: "array", items: { type: "string" } },
        recurringCharacters: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "appearance"],
            properties: {
              name: { type: "string" },
              appearance: { type: "string" },
            },
          },
        },
        moodKeywords: { type: "array", items: { type: "string" } },
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: [
          "sceneIndex",
          "summary",
          "subject",
          "characters",
          "environment",
          "emotion",
          "action",
          "lighting",
          "cameraMove",
          "atmosphere",
          "searchQueries",
          "promptCore",
        ],
        properties: {
          sceneIndex: { type: "integer" },
          summary: { type: "string" },
          subject: { type: "string" },
          characters: { type: "array", items: { type: "string" } },
          environment: { type: "string" },
          emotion: { type: "string" },
          action: { type: "string" },
          lighting: { type: "string" },
          cameraMove: { type: "string", enum: [...CAMERA_MOVES] },
          atmosphere: { type: "string", enum: [...ATMOSPHERES] },
          searchQueries: { type: "array", items: { type: "string" } },
          promptCore: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a master cinematographer and visual director for viral vertical 9:16 documentary & literary short films (Zack D. Films / Fern / Pursuit of Wonder visual clarity).
Given a book's title, archetype, script, and exact spoken narration per cinematic scene:
1. Build a unified BookVisualBible so every scene shares cohesive high-contrast lighting, deep shadows, warm rim highlights, and consistent visual atmosphere.
2. For each listed scene, depict the EXACT concrete objects, actions, or real-world tension in the spoken narration — NEVER fall back to unrelated nature filler, generic staircases, or abstract shapes when the narration names real objects or situations (e.g. if the narration talks about rewarding a workout with sweets, show a heavy iron dumbbell on a dark gym floor next to a glossy glazed donut under dramatic spotlight; if it talks about excuses blocking a walk, show laced running shoes by a rain-streaked doorway).
3. Describe concrete visual scenes suitable for local Stable Diffusion portrait rendering:
   - Place ONE unmistakable focal subject in the crisp center-lower midground, framed with dark atmospheric top & bottom negative space so overlaid typography pops cleanly.
   - Use dramatic volumetric rim lighting, shallow depth of field (35mm f/1.8), tactile real-world textures, and clear foreground/midground/background depth separation.
   - NEVER ask for written text, signs, numbers, clock faces with digits, letters, book titles, or watermarks inside the generated image (all typography is rendered separately in HTML).
   - Provide 2-3 concise photography/art reference search queries (2-5 words each, e.g. "running shoes rain doorway", "iron dumbbell dark studio") for free reference discovery.`;

const DEFAULT_NEGATIVE_PROMPT =
  "text, words, letters, numbers, digits, watermark, logo, signature, caption, subtitle, blurry, low quality, jpeg artifacts, distorted hands, extra fingers, deformed face, cropped, frame border, split screen, cartoon sticker, flat clipart";

/**
 * Determine which configured CLI/free-tier LLM provider directs scene visuals.
 * Uses the operator's configured local CLI or free-tier Gemini AI Studio engine
 * while still refusing paid OpenAI API keys on `codex-cli`.
 */
async function resolveFreeOnlyCliProvider(override?: CliProvider | null): Promise<CliProvider | null> {
  if (process.env.BOOKREEL_VISUAL_LOCAL_ONLY === "1") return null;
  const stored = override ? null : await getSetting("cliProvider").catch(() => null);
  const candidate = override ?? resolveProvider(stored);
  if (!candidate) return null;

  if (candidate === "claude-cli") return "claude-cli";
  if (candidate === "codex-cli") {
    const paidKey = await resolveCodexApiKey();
    return paidKey ? null : "codex-cli";
  }
  if (candidate === "gemini") {
    return "gemini";
  }
  return null;
}

function narrationTextOf(scene: Scene, pkg: ContentPackage): string {
  const fromWords = (scene.words ?? []).map((w) => w.word).join(" ").trim();
  if (fromWords) return fromWords;
  if (scene.quote?.text) return scene.quote.text;
  const beatTexts = pkg.beats.map((b) => b.voiceover).join(" ");
  return scene.concept || beatTexts.slice(0, 180);
}

function archetypeVisualPreset(archetype: string | null | undefined, theme: BookTheme): Omit<BookVisualBible, "recurringCharacters"> {
  const kind = (archetype ?? "motivation").toLowerCase();
  const palette = [theme.palette.backdropDeep, theme.palette.backdropBase, theme.palette.accent];

  if (kind === "philosophy") {
    return {
      visualStyle: "atmospheric classical cinema, painterly chiaroscuro, architectural depth, 35mm film grain",
      eraAndSetting: "timeless stone colonnades, candlelit study, vast coastal cliffs and quiet courtyards",
      lightingLanguage: "Rembrandt directional key light, warm amber shafts cutting through cool slate shadow",
      colorPalette: palette,
      moodKeywords: ["contemplative", "timeless", "sculptural", "dramatic"],
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    };
  }
  if (kind === "story" || kind === "memoir") {
    return {
      visualStyle: "emotional narrative cinema, anamorphic depth of field, natural atmospheric realism, rich color grade",
      eraAndSetting: "lived-in rooms, rain-washed streets, quiet landscapes, golden hour horizons",
      lightingLanguage: "natural window light, soft volumetric haze, warm practical lamps against dusk",
      colorPalette: palette,
      moodKeywords: ["intimate", "evocative", "cinematic", "human"],
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    };
  }
  if (kind === "howto") {
    return {
      visualStyle: "crisp modern architectural photography, precision studio lighting, tactile real-world materials",
      eraAndSetting: "minimalist studio, sunlit workshop, structured geometric spaces",
      lightingLanguage: "clean rim light, soft key illumination, crisp contact shadows",
      colorPalette: palette,
      moodKeywords: ["focused", "structured", "clear", "purposeful"],
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    };
  }
  return {
    visualStyle: "epic editorial cinematography, dramatic perspective, shallow depth of field, volumetric atmosphere",
    eraAndSetting: "vast horizons, monumental architecture, solitary study at dawn, atmospheric nature",
    lightingLanguage: "dramatic rim lighting, volumetric god rays, high-contrast shadow and warm highlights",
    colorPalette: palette,
    moodKeywords: ["resolute", "cinematic", "elevated", "focused"],
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  };
}

const STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "your", "have", "what", "when",
  "where", "which", "their", "there", "about", "into", "more", "most", "some",
  "than", "them", "they", "were", "been", "being", "will", "would", "could",
  "should", "every", "never", "always", "just", "only", "very", "much", "many",
  "follow", "subscribe", "comment", "like", "book", "page", "says", "writes",
]);

function extractSalientNouns(text: string, max = 5): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(tokens)).slice(0, max);
}

/** Map procedural hero / environment / words to a rich visual scene metaphor when running locally. */
function heroVisualMetaphor(scene: Scene, narration: string, treatment?: VisualTreatment): {
  subject: string;
  environment: string;
  emotion: string;
  action: string;
  lighting: string;
  atmosphere: AtmosphereKind;
} {
  const hero = scene.cine?.hero ?? "orb";
  const lower = `${scene.concept} ${narration}`.toLowerCase();

  if (/\b(?:offices?|desks?|writers?|authors?|journals?|notebooks?)\b/.test(lower) && (treatment === "documentary" || /\b(?:rooms?|city|tonight|night|lamp|sit|sitting|wrote|write)\b/.test(lower))) {
    return {
      subject: "warm brass desk lamp illuminating an open notebook and fountain pen beside a rain-softened window",
      environment: "quiet wood-paneled city office room overlooking glowing evening street lights",
      emotion: "deep focus and quiet resolve",
      action: "warm pool of practical lamplight falling across textured paper and timber desk",
      lighting: "intimate warm tungsten desk lamp balanced against cool evening window bokeh",
      atmosphere: "dust",
    };
  }
  if (treatment === "documentary" && /\b(?:hospitals?|clinics?|wards?|doctors?|physicians?|patients?)\b/.test(lower)) {
    return {
      subject: "quiet sunlit corridor with tall casement windows and polished terrazzo floor",
      environment: "historic medical study and calm hospital wing in natural morning light",
      emotion: "humanity and careful observation",
      action: "soft daylight streaming across clinical notes and glass instruments",
      lighting: "clean directional window light with gentle shadow falloff",
      atmosphere: "dust",
    };
  }
  if (treatment === "documentary" && /\b(?:streets?|avenues?|trains?|stations?|harbors?|markets?)\b/.test(lower)) {
    return {
      subject: "wet cobblestone city street reflecting warm storefront lamps at dusk",
      environment: "authentic urban street canyon with layered architectural depth",
      emotion: "lived-in realism and reflection",
      action: "distant pedestrians silhouetted in soft evening mist",
      lighting: "natural twilight sky with warm practical streetlamp reflections",
      atmosphere: "mist",
    };
  }

  if (/storm|fear|anger|chaos|crisis|danger|anxiet/.test(lower) || hero === "storm") {
    return {
      subject: "solitary figure standing steady on a dark coastal cliff facing towering storm clouds",
      environment: "dramatic windswept sea cliff under turbulent slate storm clouds",
      emotion: "tension and resilience",
      action: "wind sweeping mist across jagged rock as distant lightning illuminates the horizon",
      lighting: "cold silver storm light with a warm lantern rim glow",
      atmosphere: "rain",
    };
  }
  if (/time|clock|hour|year|moment|wait|late|past/.test(lower) || hero === "hourglass" || hero === "clock") {
    return {
      subject: "ornate brass hourglass with glowing golden sand on an ancient timber desk",
      environment: "sunlit classical library with tall arched windows and floating dust motes",
      emotion: "urgency and reflection",
      action: "fine golden grains falling through glass in a shaft of late-afternoon sunlight",
      lighting: "warm golden-hour sunbeams cutting through deep walnut shadows",
      atmosphere: "dust",
    };
  }
  if (/step|climb|habit|build|progress|compound|grow/.test(lower) || hero === "staircase" || hero === "growth") {
    return {
      subject: "monumental stone staircase ascending out of shadow into warm morning light",
      environment: "grand brutalist courtyard opening toward a bright sky at dawn",
      emotion: "determination and upward momentum",
      action: "long morning shadows stretching across carved steps toward glowing open air",
      lighting: "crisp dawn god rays pouring down from the upper landing",
      atmosphere: "rays",
    };
  }
  if (/choice|road|path|direction|decid|way|journey/.test(lower) || hero === "path") {
    return {
      subject: "diverging stone pathway winding through a misty pine valley toward distant sunlit peaks",
      environment: "cinematic mountain pass wrapped in low morning fog",
      emotion: "anticipation and clarity",
      action: "golden mist drifting across ancient flagstones leading into the horizon",
      lighting: "low directional sunrise back-lighting through mist",
      atmosphere: "mist",
    };
  }
  if (/mountain|hard|obstacle|wall|impediment|struggle|challenge/.test(lower) || hero === "mountain" || hero === "wall") {
    return {
      subject: "towering granite mountain peak piercing through a sea of silver clouds",
      environment: "high-altitude alpine ridge at twilight",
      emotion: "awe and resolve",
      action: "alpenglow catching the sharp summit ridge while clouds drift below",
      lighting: "dramatic amber alpenglow against deep indigo shadow",
      atmosphere: "mist",
    };
  }
  if (/mind|think|thought|brain|focus|attention|quiet|silence|sleep|rest/.test(lower) || hero === "mind" || hero === "focus" || hero === "rest") {
    return {
      subject: "tranquil lantern-lit study overlooking a mirror-still moonlit lake",
      environment: "minimalist timber pavilion beside calm dark water at dusk",
      emotion: "deep focus and stillness",
      action: "gentle ripples catching warm lantern reflection under a clear twilight sky",
      lighting: "single warm practical lamp balanced against cool twilight blue",
      atmosphere: "still",
    };
  }
  if (/chain|weight|burden|trap|prison|stuck|free/.test(lower) || hero === "chain") {
    return {
      subject: "heavy weathered iron links parting in a beam of warm light inside a stone chamber",
      environment: "ancient vaulted archway opening onto a bright horizon",
      emotion: "liberation and contrast",
      action: "glowing embers and dust rising into a shaft of sunlight",
      lighting: "high-contrast chiaroscuro shaft of light piercing dark stone",
      atmosphere: "embers",
    };
  }
  if (/spark|idea|fire|light|ignite|change|begin/.test(lower) || hero === "spark") {
    return {
      subject: "single warm flame illuminating an open leather journal in a darkened room",
      environment: "intimate wooden study wrapped in deep velvet shadow",
      emotion: "inspiration and discovery",
      action: "warm golden embers drifting upward in shallow depth of field",
      lighting: "warm candlelit chiaroscuro with soft bokeh highlights",
      atmosphere: "embers",
    };
  }
  if (/people|friend|community|together|speak|conversation|world/.test(lower) || hero === "dialogue" || hero === "network") {
    return {
      subject: "two silhouetted figures walking along a sunlit colonnade with long architectural shadows",
      environment: "warm Mediterranean stone arcade at golden hour",
      emotion: "connection and perspective",
      action: "warm afternoon light casting rhythmic pillar shadows across stone",
      lighting: "warm golden-hour side light with soft atmospheric haze",
      atmosphere: "dust",
    };
  }

  const nouns = extractSalientNouns(`${scene.concept} ${narration}`, 4);
  const conceptPhrase = scene.concept?.trim() || nouns.join(" ") || "quiet classical study";
  return {
    subject: `cinematic still-life and architectural scene evoking ${conceptPhrase}`,
    environment: "atmospheric sunlit chamber with deep perspective and natural textures",
    emotion: "focused contemplation",
    action: "subtle light shafts moving across textured stone and timber",
    lighting: "dramatic directional window light with deep cinematic shadows",
    atmosphere: "dust",
  };
}

function shotAnglePromptPhrase(angle: ShotAngleKind | undefined): string {
  switch (angle) {
    case "low-angle-heroic":
      return "dramatic low-angle upward framing";
    case "high-angle-overview":
      return "elevated high-angle overview perspective";
    case "close-intimate":
      return "intimate close-medium focal framing";
    case "wide-establishing":
      return "expansive wide establishing perspective";
    default:
      return "natural eye-level framing";
  }
}

function buildPromptCoreForTreatment(
  treatment: VisualTreatment,
  shotAngle: ShotAngleKind | undefined,
  subject: string,
  environment: string,
  action: string,
  lighting: string,
  visualStyle: string,
  extraAppearance: string[] = [],
): string {
  const anglePhrase = shotAnglePromptPhrase(shotAngle);
  if (treatment === "documentary") {
    return [
      subject,
      `in ${environment}`,
      action,
      ...extraAppearance,
      anglePhrase,
      lighting,
      "authentic 35mm documentary photography, candid real-world realism, natural window and practical light, tactile materials, subtle film grain, vertical 9:16 portrait framing, no text, no watermark",
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    subject,
    `in ${environment}`,
    action,
    ...extraAppearance,
    anglePhrase,
    lighting,
    visualStyle,
    "vertical 9:16 portrait composition, clear foreground silhouette framing, crisp midground focal subject, deep atmospheric background vista, cinematic color grading, 35mm lens, shallow depth of field, no text, no watermark",
  ]
    .filter(Boolean)
    .join(", ");
}

function heuristicAnalyze(input: AnalyzeVisualsInput): { bible: BookVisualBible; intents: Map<number, SceneVisualIntent> } {
  const preset = archetypeVisualPreset(input.archetype, input.theme);
  const bible: BookVisualBible = {
    ...preset,
    recurringCharacters: [],
  };

  const intents = new Map<number, SceneVisualIntent>();

  input.scenes.forEach((scene, idx) => {
    const plan = input.scenePlans?.get(scene.index);
    const treatment: VisualTreatment = plan?.visualTreatment ?? (scene.kind === "cinematic" ? "hybrid-cinematic" : "motion-graphics");
    const narration = narrationTextOf(scene, input.pkg);
    const meta = heroVisualMetaphor(scene, narration, treatment);
    const nouns = extractSalientNouns(`${scene.concept} ${narration}`, 4);
    const cameraMove = plan?.cameraMovement ?? CAMERA_MOVES[idx % CAMERA_MOVES.length];
    const shotAngle = plan?.compositionAndAngle.shotAngle ?? "eye-level";
    const atmosphere = plan?.lightingAndAtmosphere.atmosphere ?? meta.atmosphere;

    const subject =
      treatment === "documentary" && !/figure|person|room|street|study|library|colonnade|desk|lamp|corridor/.test(meta.subject)
        ? `candid documentary scene of ${plan?.mainSubject || meta.subject}`
        : plan && treatment !== "hybrid-cinematic" && scene.kind !== "cinematic"
          ? plan.mainSubject
          : meta.subject;

    const subjectKeywords = extractSalientNouns(subject, 3);
    const envKeywords = extractSalientNouns(meta.environment, 3);
    const q1 = [...subjectKeywords.slice(0, 2), ...envKeywords.slice(0, 1)].join(" ").trim();
    const q2 = envKeywords.join(" ").trim();
    const q3 = `${nouns.slice(0, 2).join(" ") || subjectKeywords[0] || "library"} light`.trim();
    const searchQueries = Array.from(new Set([q1, q2, q3].map((q) => q.trim()).filter((q) => q.length >= 3)));

    const promptCore = buildPromptCoreForTreatment(
      treatment,
      shotAngle,
      subject,
      meta.environment,
      meta.action,
      meta.lighting,
      bible.visualStyle,
    );

    intents.set(scene.index, {
      sceneIndex: scene.index,
      narration,
      summary: plan ? `${plan.mainSubject} (${treatment})` : scene.concept || narration.slice(0, 90),
      subject,
      characters: [],
      environment: meta.environment,
      emotion: meta.emotion,
      action: meta.action,
      lighting: plan?.lightingAndAtmosphere.lighting || meta.lighting,
      cameraMove,
      shotAngle,
      visualTreatment: treatment,
      calloutText: plan?.motionGraphics.calloutText ?? null,
      atmosphere,
      searchQueries,
      promptCore,
    });
  });

  return { bible, intents };
}

function sanitizeCameraMove(raw: unknown, fallback: CameraMoveKind): CameraMoveKind {
  return typeof raw === "string" && (CAMERA_MOVES as readonly string[]).includes(raw)
    ? (raw as CameraMoveKind)
    : fallback;
}

function sanitizeAtmosphere(raw: unknown, fallback: AtmosphereKind): AtmosphereKind {
  return typeof raw === "string" && (ATMOSPHERES as readonly string[]).includes(raw)
    ? (raw as AtmosphereKind)
    : fallback;
}

/**
 * Analyse the book and every cinematic scene in the episode.
 *
 * Uses a free local CLI tool (`claude-cli` / keyless `codex-cli` / keyless `gemini`)
 * when available, and merges/repairs any missing fields against the deterministic
 * local visual director so every cinematic scene is guaranteed a grounded,
 * narration-matched `SceneVisualIntent` at $0.00 cost.
 */
export async function analyzeEpisodeVisuals(input: AnalyzeVisualsInput): Promise<AnalyzeVisualsResult> {
  if (wasCancelled() || abortOpts().signal?.aborted) throw new CancelledError();

  const fallback = heuristicAnalyze(input);
  const notes: string[] = [];
  const plateScenes = input.scenes.filter((s) => {
    if (s.kind !== "cinematic") return false;
    const tr = input.scenePlans?.get(s.index)?.visualTreatment ?? "hybrid-cinematic";
    return tr === "hybrid-cinematic" || tr === "documentary";
  });
  if (plateScenes.length === 0) {
    return { source: "local-heuristic", bible: fallback.bible, intents: fallback.intents, notes };
  }

  if (input.localOnly) {
    return { source: "local-heuristic", bible: fallback.bible, intents: fallback.intents, notes };
  }

  const provider = await resolveFreeOnlyCliProvider(input.cliProviderOverride);
  if (!provider) {
    notes.push("Visual analysis used built-in local visual director (free-only local mode).");
    return { source: "local-heuristic", bible: fallback.bible, intents: fallback.intents, notes };
  }

  const userPrompt = [
    `Book: "${input.bookTitle}"${input.author ? ` by ${input.author}` : ""}`,
    `Archetype: ${input.archetype ?? "motivation"}`,
    `Episode Hook: ${input.pkg.hook}`,
    `Cinematic scenes to direct (${plateScenes.length}):`,
    ...plateScenes.map((s) => {
      const tr = input.scenePlans?.get(s.index)?.visualTreatment ?? "hybrid-cinematic";
      return `- sceneIndex ${s.index} (${(s.end - s.start).toFixed(1)}s, treatment: "${tr}", concept: "${s.concept}", hero hint: "${s.cine?.hero ?? "orb"}"):\n  Spoken narration: "${narrationTextOf(s, input.pkg)}"`;
    }),
  ].join("\n\n");

  try {
    interface RawCliPlan {
      bible?: Partial<BookVisualBible>;
      scenes?: Array<Partial<SceneVisualIntent> & { sceneIndex?: number }>;
    }
    const configuredModel =
      provider === "gemini" ? ((await getSetting("geminiModel").catch(() => null)) || "gemini-3.5-flash-lite") : undefined;
    const raw = await runCliJson<RawCliPlan>(provider, SYSTEM_PROMPT, userPrompt, VISUAL_DIRECTOR_SCHEMA, configuredModel);
    if (wasCancelled()) throw new CancelledError();

    const bible: BookVisualBible = {
      visualStyle:
        typeof raw?.bible?.visualStyle === "string" && raw.bible.visualStyle.trim()
          ? raw.bible.visualStyle.trim()
          : fallback.bible.visualStyle,
      eraAndSetting:
        typeof raw?.bible?.eraAndSetting === "string" && raw.bible.eraAndSetting.trim()
          ? raw.bible.eraAndSetting.trim()
          : fallback.bible.eraAndSetting,
      lightingLanguage:
        typeof raw?.bible?.lightingLanguage === "string" && raw.bible.lightingLanguage.trim()
          ? raw.bible.lightingLanguage.trim()
          : fallback.bible.lightingLanguage,
      colorPalette:
        Array.isArray(raw?.bible?.colorPalette) && raw.bible.colorPalette.length > 0
          ? raw.bible.colorPalette.filter((c): c is string => typeof c === "string").slice(0, 5)
          : fallback.bible.colorPalette,
      recurringCharacters: Array.isArray(raw?.bible?.recurringCharacters)
        ? raw.bible.recurringCharacters
            .filter(
              (c): c is { name: string; appearance: string } =>
                Boolean(c && typeof c.name === "string" && typeof c.appearance === "string"),
            )
            .slice(0, 4)
        : [],
      moodKeywords:
        Array.isArray(raw?.bible?.moodKeywords) && raw.bible.moodKeywords.length > 0
          ? raw.bible.moodKeywords.filter((k): k is string => typeof k === "string").slice(0, 6)
          : fallback.bible.moodKeywords,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    };

    const intents = new Map<number, SceneVisualIntent>(fallback.intents);
    const byIdx = new Map<number, Partial<SceneVisualIntent>>();
    for (const item of raw?.scenes ?? []) {
      if (typeof item?.sceneIndex === "number") byIdx.set(item.sceneIndex, item);
    }

    for (const scene of plateScenes) {
      const base = fallback.intents.get(scene.index)!;
      const hit = byIdx.get(scene.index);
      if (!hit) continue;

      const charDescriptions = bible.recurringCharacters
        .filter((rc) =>
          (hit.characters ?? []).some((name) => name.toLowerCase().includes(rc.name.toLowerCase())),
        )
        .map((rc) => rc.appearance);

      const subject = typeof hit.subject === "string" && hit.subject.trim() ? hit.subject.trim() : base.subject;
      const environment =
        typeof hit.environment === "string" && hit.environment.trim() ? hit.environment.trim() : base.environment;
      const lighting = typeof hit.lighting === "string" && hit.lighting.trim() ? hit.lighting.trim() : base.lighting;
      const action = typeof hit.action === "string" && hit.action.trim() ? hit.action.trim() : base.action;
      const rawCore = typeof hit.promptCore === "string" && hit.promptCore.trim() ? hit.promptCore.trim() : "";
      const treatment = base.visualTreatment ?? "hybrid-cinematic";

      const promptCore = buildPromptCoreForTreatment(
        treatment,
        base.shotAngle,
        rawCore || subject,
        environment,
        action,
        lighting,
        bible.visualStyle,
        charDescriptions,
      );

      const queries = Array.isArray(hit.searchQueries)
        ? hit.searchQueries.filter((q): q is string => typeof q === "string" && q.trim().length >= 3).slice(0, 3)
        : [];

      intents.set(scene.index, {
        sceneIndex: scene.index,
        narration: base.narration,
        summary: typeof hit.summary === "string" && hit.summary.trim() ? hit.summary.trim() : base.summary,
        subject,
        characters: Array.isArray(hit.characters)
          ? hit.characters.filter((c): c is string => typeof c === "string")
          : base.characters,
        environment,
        emotion: typeof hit.emotion === "string" && hit.emotion.trim() ? hit.emotion.trim() : base.emotion,
        action,
        lighting,
        cameraMove: base.cameraMove || sanitizeCameraMove(hit.cameraMove, base.cameraMove),
        shotAngle: base.shotAngle,
        visualTreatment: treatment,
        calloutText: base.calloutText ?? null,
        atmosphere: sanitizeAtmosphere(hit.atmosphere, base.atmosphere),
        searchQueries: queries.length > 0 ? queries : base.searchQueries,
        promptCore,
      });
    }

    return { source: "cli", bible, intents, notes };
  } catch (err) {
    if (err instanceof CancelledError || wasCancelled()) throw new CancelledError();
    notes.push(
      `CLI visual director unavailable (${err instanceof Error ? err.message.slice(0, 120) : "error"}) — used built-in local visual director.`,
    );
    return { source: "local-heuristic", bible: fallback.bible, intents: fallback.intents, notes };
  }
}
