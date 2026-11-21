import { runCli, extractJson, type CliProvider } from "./cli";
import {
  ARCHETYPES,
  CONTENT_JSON_SCHEMA,
  contentJsonSchema,
  type Archetype,
  type Beat,
  type ContentPackage,
  type GenerateInput,
} from "./schema";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

/**
 * The CLIs have no structured-output mode, so the schema is stated in the prompt
 * and the reply is parsed leniently.
 */
function jsonContract(schema: object): string {
  return `\n\nReturn ONLY a single JSON object — no prose, no markdown fence, no explanation before or after. Every item in "beats" MUST be a JSON object (never a JSON-encoded string). It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;
}

function unwrapJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      try {
        return extractJson<unknown>(trimmed);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  const unwrapped = unwrapJsonValue(value);
  if (!Array.isArray(unwrapped)) return [];
  return unwrapped
    .map((item) => asString(unwrapJsonValue(item)).trim())
    .filter((item) => item.length > 0);
}

function normalizeBeat(rawBeat: unknown, index: number): Beat | null {
  const unwrapped = unwrapJsonValue(rawBeat);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    if (typeof unwrapped === "string" && unwrapped.trim()) {
      const text = unwrapped.trim();
      return {
        id: `b${index + 1}`,
        voiceover: text,
        onScreen: text.split(/\s+/).slice(0, 4).join(" ").slice(0, 42),
        sourcePage: 0,
        startWord: 0,
        endWord: 0,
      };
    }
    return null;
  }

  const obj = unwrapped as Record<string, unknown>;
  const voiceover = asString(obj.voiceover ?? obj.narration ?? obj.text ?? obj.script).trim();
  const rawOnScreen = asString(obj.onScreen ?? obj.label ?? obj.heading ?? obj.caption).trim();
  const onScreen = rawOnScreen || voiceover.split(/\s+/).slice(0, 4).join(" ").slice(0, 42);
  const startWord = asInt(obj.startWord ?? obj.start, 0);
  const endWord = asInt(obj.endWord ?? obj.end, startWord);
  const sourcePage = asInt(obj.sourcePage ?? obj.pageIndex ?? obj.page, 0);
  const id = asString(obj.id).trim() || `b${index + 1}`;
  const emojiRaw = typeof obj.emoji === "string" ? obj.emoji.trim() : "";

  const beat: Beat = {
    id,
    voiceover,
    onScreen,
    sourcePage,
    startWord,
    endWord,
  };
  if (emojiRaw) {
    beat.emoji = emojiRaw.slice(0, 8);
  }
  return beat;
}

/**
 * Normalizes lenient/smaller-model JSON quirks (such as `beats` returned as an
 * array of JSON-encoded strings by `gemini-2.5-flash-lite`, or numeric strings
 * for word indices) into a valid runtime `ContentPackage` shape without altering
 * well-formed packages.
 */
export function normalizeContentPackage(
  raw: unknown,
  fallback?: Partial<Pick<GenerateInput, "ideaKey" | "archetype">>,
): ContentPackage {
  const root = unwrapJsonValue(raw);
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Model reply was not a JSON object.");
  }
  const obj = root as Record<string, unknown>;
  const rawBeats = unwrapJsonValue(obj.beats);
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    throw new Error("Model reply omitted a valid beats array.");
  }

  const beats = rawBeats
    .map((entry, idx) => normalizeBeat(entry, idx))
    .filter((b): b is Beat => b !== null && b.voiceover.length > 0);

  if (beats.length === 0 || beats.length !== rawBeats.length) {
    throw new Error("Model reply contained beats with missing or empty voiceover text.");
  }

  const pkg: ContentPackage = {
    title: asString(obj.title).trim(),
    hook: asString(obj.hook).trim(),
    ideaKey: asString(obj.ideaKey).trim() || fallback?.ideaKey || "idea",
    beats,
    cta: asString(obj.cta).trim() || beats[beats.length - 1].voiceover,
    description: asString(obj.description),
    hashtags: Array.isArray(obj.hashtags)
      ? obj.hashtags.map((h) => asString(h)).filter((h) => h.length > 0)
      : asStringArray(obj.hashtags),
    takeaway: Array.isArray(obj.takeaway)
      ? obj.takeaway.map((t) => asString(t)).filter((t) => t.length > 0)
      : asStringArray(obj.takeaway),
  };

  if (obj.hookKeywords !== undefined) {
    const kw = asStringArray(obj.hookKeywords);
    if (kw.length > 0 || Array.isArray(obj.hookKeywords)) {
      pkg.hookKeywords = kw;
    }
  }
  if (typeof obj.archetype === "string" && ARCHETYPES.includes(obj.archetype as Archetype)) {
    pkg.archetype = obj.archetype as Archetype;
  }

  return pkg;
}

/**
 * Generates a full `ContentPackage` for one episode.
 *
 * `hasAuthor` is deliberately NOT a parameter here: it is derived from
 * `input.author !== null` rather than taken on trust from the caller, so it
 * is impossible to call this with an author string present but the
 * no-author prompt branch active (or vice versa) — the one fact that must
 * never disagree with itself is whether the writer was told a name exists.
 */
export async function generateWithCli(
  input: GenerateInput,
  provider: CliProvider,
  model?: string,
  revisionBrief?: string,
): Promise<ContentPackage> {
  const system =
    buildSystemPrompt({ hasAuthor: input.author !== null, length: input.length, spec: input.spec }) +
    jsonContract(input.length === "long" ? contentJsonSchema("long", input.spec) : CONTENT_JSON_SCHEMA);
  const user = buildUserPrompt(input, revisionBrief);
  const reply = await runCli(provider, system, user, model);
  try {
    return normalizeContentPackage(extractJson<unknown>(reply), input);
  } catch (firstErr) {
    const retryUser =
      `${user}\n\nIMPORTANT SCHEMA FIX: Your previous reply failed schema validation (${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }). Return a single valid JSON object where "beats" is a JSON array of plain JSON objects (NOT quoted strings), and every beat has non-empty "id", "voiceover", "onScreen", "sourcePage", "startWord", and "endWord".`;
    const retryReply = await runCli(provider, system, retryUser, model);
    return normalizeContentPackage(extractJson<unknown>(retryReply), input);
  }
}

export async function runCliJson<T>(
  provider: CliProvider,
  system: string,
  user: string,
  schema: object,
  model?: string,
): Promise<T> {
  const reply = await runCli(provider, system + jsonContract(schema), user, model);
  return extractJson<T>(reply);
}
