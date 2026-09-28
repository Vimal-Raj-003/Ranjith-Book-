import { runCli, extractJson, type CliProvider } from "./cli";
import { CONTENT_JSON_SCHEMA, contentJsonSchema, type ContentPackage, type GenerateInput } from "./schema";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

/**
 * The CLIs have no structured-output mode, so the schema is stated in the prompt
 * and the reply is parsed leniently.
 */
function jsonContract(schema: object): string {
  return `\n\nReturn ONLY a single JSON object — no prose, no markdown fence, no explanation before or after. It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;
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
    buildSystemPrompt({ hasAuthor: input.author !== null, length: input.length }) +
    jsonContract(input.length === "long" ? contentJsonSchema("long") : CONTENT_JSON_SCHEMA);
  const user = buildUserPrompt(input, revisionBrief);
  const reply = await runCli(provider, system, user, model);
  return extractJson<ContentPackage>(reply);
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
