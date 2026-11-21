import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { prisma } from "@/lib/db";
import {
  CLI_PROVIDERS,
  parseGeminiModel,
  parseProvider,
  probeCli,
  resolveCodexApiKey,
  resolveGeminiApiKey,
  resolveGeminiModel,
  resolveProvider,
  type CliProvider,
  type CliStatus,
} from "@/lib/content/cli";

const ENGINE_PROBE_TTL_MS = 60_000;
let cachedProbeStatus: { at: number; status: Record<CliProvider, CliStatus> } | null = null;

async function getCachedProbeStatuses(forceRefresh = false): Promise<Record<CliProvider, CliStatus>> {
  if (!forceRefresh && cachedProbeStatus && Date.now() - cachedProbeStatus.at < ENGINE_PROBE_TTL_MS) {
    return cachedProbeStatus.status;
  }
  const entries = await Promise.all(
    CLI_PROVIDERS.map(async (p): Promise<[CliProvider, CliStatus]> => [p, await probeCli(p)]),
  );
  const status = Object.fromEntries(entries) as Record<CliProvider, CliStatus>;
  cachedProbeStatus = { at: Date.now(), status };
  return status;
}

async function buildEngineSnapshot(forceRefresh = false) {
  const [row, chosenRow, geminiModel] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "cliProvider" } }),
    prisma.setting.findUnique({ where: { key: "engineChosen" } }),
    resolveGeminiModel(),
  ]);
  const parsed = parseProvider(row?.value);
  const chosen = chosenRow?.value === "1" && parsed !== null;
  const provider: CliProvider = parsed ?? resolveProvider(process.env.BOOKREEL_CLI_PROVIDER);
  const defaultProvider: CliProvider = resolveProvider(process.env.BOOKREEL_CLI_PROVIDER);

  const [status, hasGeminiKey, hasCodexKey] = await Promise.all([
    getCachedProbeStatuses(forceRefresh),
    resolveGeminiApiKey().then(Boolean),
    resolveCodexApiKey().then(Boolean),
  ]);

  return {
    chosen,
    provider,
    defaultProvider,
    geminiModel,
    status,
    hasGeminiKey,
    hasCodexKey,
  };
}

export async function GET(req: Request) {
  try {
    await requireUser();
    const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";
    const snapshot = await buildEngineSnapshot(forceRefresh);
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function PUT(req: Request) {
  try {
    await requireUser();

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json(
          { error: { code: "bad_request", message: "Expected a JSON object." } },
          { status: 400 },
        );
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: { code: "bad_json", message: "Request body is not valid JSON." } },
        { status: 400 },
      );
    }

    let targetProvider: CliProvider | null = null;
    if (body.provider !== undefined) {
      targetProvider = parseProvider(body.provider);
      if (!targetProvider) {
        return NextResponse.json(
          {
            error: {
              code: "bad_value",
              message: `Unsupported generation engine "${String(body.provider)}". Choose claude-cli, codex-cli, or gemini.`,
            },
          },
          { status: 400 },
        );
      }
    }

    if (body.geminiModel !== undefined) {
      const parsedGeminiModel = parseGeminiModel(body.geminiModel);
      if (!parsedGeminiModel) {
        return NextResponse.json(
          {
            error: {
              code: "bad_value",
              message: `Unsupported Gemini model "${String(body.geminiModel)}".`,
            },
          },
          { status: 400 },
        );
      }
      await prisma.setting.upsert({
        where: { key: "geminiModel" },
        update: { value: parsedGeminiModel },
        create: { key: "geminiModel", value: parsedGeminiModel },
      });
    }

    const effectiveProvider =
      targetProvider ??
      parseProvider((await prisma.setting.findUnique({ where: { key: "cliProvider" } }))?.value) ??
      "claude-cli";

    if (typeof body.apiKey === "string") {
      const trimmed = body.apiKey.trim();
      if (!trimmed) {
        return NextResponse.json(
          { error: { code: "bad_value", message: "API key cannot be blank." } },
          { status: 400 },
        );
      }
      const secretKey =
        effectiveProvider === "gemini"
          ? "geminiApiKey"
          : effectiveProvider === "codex-cli"
            ? "codexApiKey"
            : null;
      if (secretKey) {
        await prisma.setting.upsert({
          where: { key: secretKey },
          update: { value: trimmed },
          create: { key: secretKey, value: trimmed },
        });
      }
    } else if (body.clearApiKey === true) {
      const secretKey =
        effectiveProvider === "gemini"
          ? "geminiApiKey"
          : effectiveProvider === "codex-cli"
            ? "codexApiKey"
            : null;
      if (secretKey) {
        await prisma.setting.deleteMany({ where: { key: secretKey } });
      }
    }

    if (targetProvider) {
      const targetStatus = await probeCli(targetProvider);
      if (targetStatus.signedIn || body.confirmUnconfigured === true) {
        await prisma.setting.upsert({
          where: { key: "cliProvider" },
          update: { value: targetProvider },
          create: { key: "cliProvider", value: targetProvider },
        });
        await prisma.setting.upsert({
          where: { key: "engineChosen" },
          update: { value: "1" },
          create: { key: "engineChosen", value: "1" },
        });
      }
    }

    cachedProbeStatus = null;
    const snapshot = await buildEngineSnapshot(true);
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
