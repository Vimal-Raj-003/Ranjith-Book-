import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CLI_PROVIDERS,
  cliBin,
  isCliError,
  parseGeminiModel,
  parseProvider,
  probeCli,
  resolveGeminiModel,
  resolveProvider,
  runCli,
} from "../src/lib/content/cli";
import { runCliJson } from "../src/lib/content/cli-provider";
import { runCliVisionJson } from "../src/lib/content/cli-vision";
import { validateSetting } from "../src/lib/settings/keys";
import { GEMINI_MODELS, GENERATION_ENGINES, strings } from "../src/lib/strings";
import * as engineModalModule from "../src/components/EngineSelectorModal";
import type { EngineSnapshot } from "../src/components/EngineSelectorModal";
import * as inspectorModule from "../src/components/Inspector";
import * as studioModule from "../src/components/Studio";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { getSetting, prisma, setSetting } from "../src/lib/db";

const EngineSelectorModal =
  (((engineModalModule as { default: unknown }).default as { default?: unknown })?.default ??
    (engineModalModule as { default: unknown }).default) as React.ComponentType<Record<string, unknown>>;

const Inspector =
  ((inspectorModule as { default: unknown }).default as { default?: unknown })?.default ??
  (inspectorModule as { default: unknown }).default;

const Studio =
  (((studioModule as { default: unknown }).default as { default?: unknown })?.default ??
    (studioModule as { default: unknown }).default) as React.ComponentType<Record<string, unknown>>;

const ROUTER = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
} as unknown as React.ContextType<typeof AppRouterContext>;

test("parseProvider and resolveProvider accept all three engines and reject unknown values", () => {
  assert.deepEqual(CLI_PROVIDERS, ["claude-cli", "codex-cli", "gemini"]);
  assert.equal(parseProvider("claude-cli"), "claude-cli");
  assert.equal(parseProvider("claude"), "claude-cli");
  assert.equal(parseProvider("codex-cli"), "codex-cli");
  assert.equal(parseProvider("codex"), "codex-cli");
  assert.equal(parseProvider("gemini"), "gemini");
  assert.equal(parseProvider("gemini-cli"), "gemini");
  assert.equal(parseProvider("ollama"), null);
  assert.equal(parseProvider(""), null);
  assert.equal(parseProvider(null), null);

  assert.equal(resolveProvider("gemini"), "gemini");
  assert.equal(resolveProvider("codex-cli"), "codex-cli");
  assert.equal(resolveProvider("claude-cli"), "claude-cli");
  assert.equal(resolveProvider(undefined), "claude-cli");
});

test("settings validator accepts cliProvider for claude-cli, codex-cli, and gemini only", () => {
  for (const engine of GENERATION_ENGINES) {
    assert.equal(validateSetting("cliProvider", engine.id), engine.id);
  }
  assert.equal(validateSetting("cliProvider", "ollama"), null);
  assert.equal(validateSetting("cliProvider", ""), null);
});

test("Gemini routes text and JSON generation to Google Gemini API with x-goog-api-key and never calls Claude", async () => {
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevClaudeBin = process.env.CLAUDE_CLI_BIN;
  const prevFetch = globalThis.fetch;

  let claudeSpawned = false;
  process.env.GEMINI_API_KEY = "test-gemini-key-do-not-log";
  process.env.CLAUDE_CLI_BIN = path.join(os.tmpdir(), "nonexistent-claude-bin-should-never-run");

  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, headers, body });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ status: "ok", provider: "gemini-2.5" }) }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 12 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const out = await runCliJson<{ status: string; provider: string }>(
      "gemini",
      "You are a test system.",
      "Return status ok.",
      { type: "object", properties: { status: { type: "string" }, provider: { type: "string" } }, required: ["status", "provider"] },
    );

    assert.equal(claudeSpawned, false);
    assert.equal(out.status, "ok");
    assert.equal(out.provider, "gemini-2.5");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent/);
    assert.equal(requests[0].headers["x-goog-api-key"], "test-gemini-key-do-not-log");
    assert.doesNotMatch(requests[0].url, /test-gemini-key-do-not-log/, "API key must be in header, never in URL");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevClaudeBin === undefined) delete process.env.CLAUDE_CLI_BIN;
    else process.env.CLAUDE_CLI_BIN = prevClaudeBin;
  }
});

test("Gemini vision routes image reading to Gemini multimodal inlineData without touching Claude", async () => {
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-gemini-vision-test-"));
  const imgFile = path.join(tmpDir, "page.png");
  await fs.writeFile(imgFile, Buffer.from("89504e470d0a1a0a", "hex"));

  process.env.GEMINI_API_KEY = "test-gemini-vision-key";
  let seenInlineMime = "";
  let seenInlineData = "";

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }>;
    };
    const parts = body.contents?.[0]?.parts ?? [];
    const inline = parts.find((p) => p.inlineData)?.inlineData;
    if (inline) {
      seenInlineMime = inline.mimeType;
      seenInlineData = inline.data;
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    chapterHeading: "Chapter 1",
                    paragraphs: ["Read by Gemini vision."],
                    legible: true,
                    note: null,
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const res = await runCliVisionJson<{ chapterHeading: string; paragraphs: string[]; legible: boolean }>(
      "gemini",
      "You transcribe book pages.",
      "Transcribe this page.",
      [imgFile],
      { type: "object" },
    );
    assert.equal(res.chapterHeading, "Chapter 1");
    assert.deepEqual(res.paragraphs, ["Read by Gemini vision."]);
    assert.equal(seenInlineMime, "image/png");
    assert.equal(seenInlineData, Buffer.from("89504e470d0a1a0a", "hex").toString("base64"));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Gemini authentication failure or missing configuration throws a clear CliError and never falls back to Claude", async () => {
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevGoogleKey = process.env.GOOGLE_API_KEY;
  const prevGeminiBin = process.env.GEMINI_CLI_BIN;
  const prevStoredKey = await getSetting("geminiApiKey");
  const prevFetch = globalThis.fetch;

  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  await prisma.setting.deleteMany({ where: { key: "geminiApiKey" } });
  process.env.GEMINI_CLI_BIN = path.join(os.tmpdir(), "missing-gemini-binary-xyz");

  try {
    await assert.rejects(
      () => runCli("gemini", "System prompt", "User prompt"),
      (err: unknown) => {
        assert.ok(isCliError(err));
        assert.match((err as Error).message, /Gemini is not connected/i);
        return true;
      },
    );

    // Now test rejected API key (401/403 from Google API)
    process.env.GEMINI_API_KEY = "invalid-gemini-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await assert.rejects(
      () => runCli("gemini", "System prompt", "User prompt"),
      (err: unknown) => {
        assert.ok(isCliError(err));
        assert.match((err as Error).message, /Gemini authentication failed \(400\): API key not valid/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = prevFetch;
    if (prevStoredKey !== null) {
      await setSetting("geminiApiKey", prevStoredKey);
    } else {
      await prisma.setting.deleteMany({ where: { key: "geminiApiKey" } });
    }
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevGoogleKey;
    if (prevGeminiBin === undefined) delete process.env.GEMINI_CLI_BIN;
    else process.env.GEMINI_CLI_BIN = prevGeminiBin;
  }
});

test("Codex routes through CODEX_CLI_BIN and reports authentication failures without falling back to Claude", async () => {
  const prevCodexBin = process.env.CODEX_CLI_BIN;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-codex-test-"));
  const fakeCodex = path.join(tmpDir, "fake-codex.mjs");

  await fs.writeFile(
    fakeCodex,
    `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.147.0-test");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_CODEX_AUTH === "1") {
    console.log("Logged in as test@openai.com");
    process.exit(0);
  }
  console.error("Not logged in");
  process.exit(1);
}
const outIdx = args.indexOf("-o");
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_AUTH !== "1") {
    console.error("401 Unauthorized: Not logged in");
    process.exit(1);
  }
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ engine: "codex", ok: true }));
  }
  process.exit(0);
});
`,
    "utf8",
  );

  process.env.CODEX_CLI_BIN = fakeCodex;
  try {
    // 1. When not logged in, probeCli reports signedIn: false and runCli throws Codex auth error
    delete process.env.FAKE_CODEX_AUTH;
    const statusOff = await probeCli("codex-cli");
    assert.equal(statusOff.installed, true);
    assert.equal(statusOff.signedIn, false);
    assert.match(statusOff.detail, /not signed in/i);

    await assert.rejects(
      () => runCliJson("codex-cli", "System", "User", { type: "object" }),
      (err: unknown) => {
        assert.ok(isCliError(err));
        assert.match((err as Error).message, /Codex is not signed in/i);
        return true;
      },
    );

    // 2. When signed in, probeCli reports signedIn: true and runCliJson returns Codex output
    process.env.FAKE_CODEX_AUTH = "1";
    const statusOn = await probeCli("codex-cli");
    assert.equal(statusOn.installed, true);
    assert.equal(statusOn.signedIn, true);

    const out = await runCliJson<{ engine: string; ok: boolean }>("codex-cli", "System", "User", { type: "object" });
    assert.deepEqual(out, { engine: "codex", ok: true });
  } finally {
    delete process.env.FAKE_CODEX_AUTH;
    if (prevCodexBin === undefined) delete process.env.CODEX_CLI_BIN;
    else process.env.CODEX_CLI_BIN = prevCodexBin;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Startup EngineSelectorModal renders all three engines, descriptions, status badges, and Skip for now", () => {
  const snapshot: EngineSnapshot = {
    chosen: false,
    provider: "claude-cli",
    defaultProvider: "claude-cli",
    status: {
      "claude-cli": { installed: true, signedIn: true, version: "2.1.117", detail: "Connected via Claude CLI." },
      "codex-cli": { installed: true, signedIn: false, version: "0.147.0", detail: "Codex CLI is installed but not signed in." },
      gemini: { installed: false, signedIn: false, version: null, detail: "Not connected." },
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(EngineSelectorModal, {
      open: true,
      snapshot,
      onSelectEngine: async () => snapshot,
      onSaveApiKey: async () => snapshot,
      onRecheck: async () => {},
      onSkip: () => {},
      onClose: () => {},
    }),
  ).replace(/&#x27;/g, "'");

  assert.match(html, /Choose your generation engine/);
  assert.match(html, /Claude/);
  assert.match(html, /Anthropic's Claude powers the generation pipeline/);
  assert.match(html, /Codex/);
  assert.match(html, /OpenAI's models power the generation pipeline/);
  assert.match(html, /Gemini/);
  assert.match(html, /Google's Gemini 2\.5 powers the generation pipeline/);
  assert.match(html, /Default: server's configured engine/);
  assert.match(html, /Skip for now/);
});

test("Settings Inspector displays the selected engine and its readiness status", () => {
  const snapshot: EngineSnapshot = {
    chosen: true,
    provider: "gemini",
    defaultProvider: "claude-cli",
    status: {
      "claude-cli": { installed: true, signedIn: true, version: "2.1.117", detail: "Connected via Claude CLI." },
      "codex-cli": { installed: true, signedIn: false, version: "0.147.0", detail: "Not signed in." },
      gemini: { installed: true, signedIn: true, version: "gemini-2.5-flash", detail: "Connected via Gemini API (gemini-2.5-flash)." },
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(Inspector as React.ComponentType<Record<string, unknown>>, {
      episode: null,
      engineSnapshot: snapshot,
      onOpenEngineModal: () => {},
      onRecheckEngine: async () => {},
    }),
  ).replace(/&#x27;/g, "'");

  assert.match(html, /<summary>Engine · Gemini<\/summary>/);
  assert.match(html, /Connected via Gemini API \(gemini-2\.5-flash\)\./);
  assert.match(html, /Choose engine…/);
});

test("Selected engine persists in database Setting table and resolves across reloads", async () => {
  const prevProvider = await getSetting("cliProvider");
  const prevChosen = await getSetting("engineChosen");
  try {
    await setSetting("cliProvider", "gemini");
    assert.equal(resolveProvider(await getSetting("cliProvider")), "gemini");

    await setSetting("cliProvider", "codex-cli");
    assert.equal(resolveProvider(await getSetting("cliProvider")), "codex-cli");

    await setSetting("cliProvider", "claude-cli");
    assert.equal(resolveProvider(await getSetting("cliProvider")), "claude-cli");
  } finally {
    if (prevProvider !== null) {
      await setSetting("cliProvider", prevProvider);
    } else {
      await prisma.setting.deleteMany({ where: { key: "cliProvider" } });
    }
    if (prevChosen !== null) {
      await setSetting("engineChosen", prevChosen);
    } else {
      await prisma.setting.deleteMany({ where: { key: "engineChosen" } });
    }
  }
});

test("Studio renders the Choose your generation engine modal open on initial visit before an engine is chosen", () => {
  const unchosenHtml = renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      React.createElement(Studio, {
        email: "a@b.test",
        initialEngine: { chosen: false, provider: "claude-cli" },
      }),
    ),
  ).replace(/&#x27;/g, "'");

  assert.match(unchosenHtml, /<h2[^>]*class="engine-modal-title"[^>]*>Choose your generation engine<\/h2>/);
  assert.match(unchosenHtml, /data-engine-option="claude-cli"/);
  assert.match(unchosenHtml, /data-engine-option="codex-cli"/);
  assert.match(unchosenHtml, /data-engine-option="gemini"/);
  assert.match(unchosenHtml, /Skip for now/);

  const chosenHtml = renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: ROUTER },
      React.createElement(Studio, {
        email: "a@b.test",
        initialEngine: { chosen: true, provider: "claude-cli" },
      }),
    ),
  ).replace(/&#x27;/g, "'");

  assert.doesNotMatch(chosenHtml, /class="engine-modal-title"/);
});

test("Selecting Gemini in EngineSelectorModal renders Gemini model option buttons and routes through the selected model", async () => {
  const snapshot: EngineSnapshot = {
    chosen: false,
    provider: "gemini",
    defaultProvider: "claude-cli",
    geminiModel: "gemini-3.8-flash",
    status: {
      "claude-cli": { installed: true, signedIn: true, version: "2.1.117", detail: "Connected via Claude CLI." },
      "codex-cli": { installed: true, signedIn: false, version: "0.147.0", detail: "Not signed in." },
      gemini: { installed: true, signedIn: true, version: "gemini-3.8-flash", detail: "Connected via Gemini API (gemini-3.8-flash)." },
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(EngineSelectorModal, {
      open: true,
      snapshot,
      onSelectEngine: async () => snapshot,
      onSaveApiKey: async () => snapshot,
      onRecheck: async () => {},
      onSkip: () => {},
      onClose: () => {},
    }),
  ).replace(/&#x27;/g, "'");

  assert.match(html, /Choose Gemini model/);
  for (const m of GEMINI_MODELS) {
    assert.equal(validateSetting("geminiModel", m.id), m.id);
    assert.equal(parseGeminiModel(m.id), m.id);
    assert.match(html, new RegExp(`data-gemini-model="${m.id}"`));
  }
  assert.match(html, /data-gemini-model="gemini-3\.8-flash"[^>]*aria-pressed="true"/);

  const prevModel = await getSetting("geminiModel");
  try {
    await setSetting("geminiModel", "gemini-3.8-flash");
    assert.equal(await resolveGeminiModel(), "gemini-3.8-flash");
  } finally {
    if (prevModel !== null) {
      await setSetting("geminiModel", prevModel);
    } else {
      await prisma.setting.deleteMany({ where: { key: "geminiModel" } });
    }
  }
});

test("runGemini retries transient 503/network errors and rotates across Gemini models on 429 per-model quota exhaustion", async () => {
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-gemini-rotation-key";

  const seenUrls: string[] = [];
  let attemptCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seenUrls.push(url);
    attemptCount++;

    if (url.includes("gemini-3.8-flash")) {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash. Please retry in 20h.",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("gemini-3.6-flash") && attemptCount === 2) {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ status: "recovered", model: "gemini-3.6-flash" }) }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const out = await runCliJson<{ status: string; model: string }>(
      "gemini",
      "You are a test system.",
      "Recover from 429 and 503.",
      { type: "object" },
      "gemini-3.8-flash",
    );
    assert.equal(out.status, "recovered");
    assert.equal(out.model, "gemini-3.6-flash");
    assert.equal(seenUrls.length, 3);
    assert.match(seenUrls[0], /gemini-3\.8-flash:generateContent/);
    assert.match(seenUrls[1], /gemini-3\.6-flash:generateContent/);
    assert.match(seenUrls[2], /gemini-3\.6-flash:generateContent/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
  }
});
