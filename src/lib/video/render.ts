import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, FFPROBE } from "../media/ffmpeg";
import { npxCommand } from "@/lib/npx";

const exec = promisify(execFile);

const CLI_ENV = () => ({
  ...process.env,
  // Static binaries downloaded into tools/bin — HyperFrames shells out to these.
  // path.delimiter, not ":" — Windows separates PATH entries with ";", so a
  // hardcoded colon fuses the whole list into one unusable entry and every
  // lookup on it fails.
  PATH: `${path.join(process.cwd(), "tools", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  FFMPEG_PATH: FFMPEG,
  FFPROBE_PATH: FFPROBE,
});

export interface ProjectFiles {
  dir: string;
  indexHtml: string;
  audioSource: string; // absolute path to the mastered wav
  /** Optional ambient bed, copied in beside the voice. */
  musicSource?: string | null;
  /** Images and screenshots the composition references, copied in alongside. */
  assets?: { from: string; to: string }[];
}

export async function writeProject(files: ProjectFiles) {
  const { dir, indexHtml, audioSource, musicSource, assets = [] } = files;
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), indexHtml, "utf8");
  await fs.copyFile(audioSource, path.join(dir, "assets", "voice.wav"));
  if (musicSource) {
    // A missing bed must never sink the render; the video simply runs dry.
    await fs.copyFile(musicSource, path.join(dir, "assets", "music.wav")).catch(() => {});
  }
  for (const a of assets) {
    // A missing asset must never sink the render.
    await fs.copyFile(a.from, path.join(dir, "assets", a.to)).catch(() => {});
  }
  await fs.writeFile(
    path.join(dir, "hyperframes.json"),
    JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
        media: { autoProxy: true },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function hf(dir: string, args: string[], timeoutMs: number) {
  const [bin, argv] = npxCommand(["--yes", "hyperframes", ...args]);
  return exec(bin, argv, {
    cwd: dir,
    env: CLI_ENV(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64,
  });
}

export interface CheckResult {
  ok: boolean;
  /** Short human-readable lines, not raw tool output. */
  notes: string[];
}

interface Finding {
  code?: string;
  severity?: string;
  message?: string;
}

/**
 * Summarize `hyperframes check` into a few readable lines. The raw JSON runs to
 * thousands of characters and is useless in the UI.
 */
/**
 * Extract one balanced JSON object from a stream that also carries log lines.
 * Slicing from the first `{` to the end is not enough: log output can sit on
 * either side of the JSON, so the closing brace has to be matched explicitly.
 */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function summarize(raw: string): string[] {
  const parsed = extractJsonObject(raw);
  if (!parsed) return [];

  const findings: Finding[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.code === "string" && typeof obj.message === "string") {
      findings.push(obj as Finding);
    }
    Object.values(obj).forEach(walk);
  };
  walk(parsed);

  const counts = new Map<string, { severity: string; message: string; n: number }>();
  for (const f of findings) {
    const key = f.code ?? "finding";
    const existing = counts.get(key);
    if (existing) existing.n += 1;
    else counts.set(key, { severity: f.severity ?? "info", message: f.message ?? "", n: 1 });
  }

  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6)
    .map(([code, v]) => {
      const first = v.message.split(". ")[0].slice(0, 150);
      return `${v.severity}: ${code}${v.n > 1 ? ` (×${v.n})` : ""} — ${first}`;
    });
}

export async function checkProject(dir: string): Promise<CheckResult> {
  try {
    const { stdout } = await hf(dir, ["check", "--json"], 10 * 60_000);
    return { ok: true, notes: summarize(stdout) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout || "") + (e.stderr || "");
    const notes = summarize(raw);
    return {
      ok: false,
      notes: notes.length ? notes : [(e.message || "check failed").slice(0, 200)],
    };
  }
}

export type RenderMode = "local" | "cloud";

/**
 * Local rendering needs Chromium and FFmpeg on the machine. Cloud rendering runs
 * on HeyGen's infrastructure instead, which is what makes a serverless
 * deployment (Vercel) viable — see README "Deploying to Vercel".
 */
export async function renderProject(
  dir: string,
  outputAbs: string,
  quality: "draft" | "high",
  mode: RenderMode = "local",
) {
  await fs.mkdir(path.dirname(outputAbs), { recursive: true });

  if (mode === "cloud") {
    await hf(
      dir,
      [
        "cloud", "render", ".",
        "--quality", quality === "draft" ? "draft" : "high",
        "--output", outputAbs,
        "--idempotency-key", path.basename(outputAbs, ".mp4"),
      ],
      90 * 60_000,
    );
  } else {
    await hf(dir, ["render", "--quality", quality, "--output", outputAbs], 60 * 60_000);
  }

  const stat = await fs.stat(outputAbs);
  if (stat.size < 1024) throw new Error("Render produced an empty file");
  return outputAbs;
}
