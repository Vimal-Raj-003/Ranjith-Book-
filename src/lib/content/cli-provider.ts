import { runCli, extractJson, type CliProvider } from "./cli";

/**
 * The CLIs have no structured-output mode, so the schema is stated in the prompt
 * and the reply is parsed leniently.
 */
function jsonContract(schema: object): string {
  return `\n\nReturn ONLY a single JSON object — no prose, no markdown fence, no explanation before or after. It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;
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
