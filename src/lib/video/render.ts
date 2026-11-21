import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, FFPROBE } from "../media/ffmpeg";
import { npxCommand } from "@/lib/npx";
import { abortOpts, wasCancelled, CancelledError } from "../cancel";

const exec = promisify(execFile);

/**
 * Preloaded into the renderer on Windows so its browsers do not each throw a
 * console window onto the desktop. See the shim's own header for the why.
 * Forward slashes because NODE_OPTIONS is re-parsed as a command line, where a
 * backslash is an escape character rather than a separator.
 */
const HIDE_SHIM = path
  .join(process.cwd(), "scripts", "no-console-windows.cjs")
  .split(path.sep)
  .join("/");

export function buildRenderCliEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...baseEnv };
  // On Windows, spreading `process.env` into a plain object preserves the mixed-case
  // `Path` key; adding a separate uppercase `PATH` key alongside it leaves two
  // competing path entries in the child environment block, causing `where.exe ffmpeg`
  // inside HyperFrames to read the old `Path` and fail with "FFmpeg not found".
  let inheritedPath = baseEnv.PATH ?? "";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") {
      if (!inheritedPath && typeof env[key] === "string") inheritedPath = env[key]!;
      delete env[key];
    }
  }
  const toolsBin = path.join(process.cwd(), "tools", "bin");
  const ffmpegDir = path.dirname(FFMPEG);
  const prefixDirs = [toolsBin, ...(ffmpegDir && ffmpegDir !== "." && ffmpegDir !== toolsBin ? [ffmpegDir] : [])];
  const mergedPath = [...prefixDirs, inheritedPath].filter(Boolean).join(path.delimiter);
  env.PATH = mergedPath;
  env.FFMPEG_PATH = FFMPEG;
  env.FFPROBE_PATH = FFPROBE;
  env.HYPERFRAMES_FFMPEG_PATH = FFMPEG;
  env.HYPERFRAMES_FFPROBE_PATH = FFPROBE;
  if (process.platform === "win32") {
    env.PATHEXT = baseEnv.PATHEXT || ".COM;.EXE;.BAT;.CMD";
    env.NODE_OPTIONS = `${baseEnv.NODE_OPTIONS ?? ""} --require "${HIDE_SHIM}"`.trim();
  }
  return env as NodeJS.ProcessEnv;
}

const CLI_ENV = () => buildRenderCliEnv(process.env);

export interface ProjectFiles {
  dir: string;
  indexHtml: string;
  audioSource: string; // absolute path to the mastered wav
  /** Optional ambient bed, copied in beside the voice. */
  musicSource?: string | null;
  /** Optional procedural SFX track, copied in beside the voice and music bed. */
  sfxSource?: string | null;
  /** Images and screenshots the composition references, copied in alongside. */
  assets?: { from: string; to: string }[];
}

export async function writeProject(files: ProjectFiles) {
  const { dir, indexHtml, audioSource, musicSource, sfxSource, assets = [] } = files;
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), indexHtml, "utf8");
  await fs.copyFile(audioSource, path.join(dir, "assets", "voice.wav"));
  if (musicSource) {
    // A missing bed must never sink the render; the video simply runs dry.
    await fs.copyFile(musicSource, path.join(dir, "assets", "music.wav")).catch(() => {});
  }
  if (sfxSource) {
    // A missing SFX track must never sink the render.
    await fs.copyFile(sfxSource, path.join(dir, "assets", "sfx.wav")).catch(() => {});
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
    ...abortOpts(),
    // A render fans out to a dozen parallel `chrome-headless-shell` workers,
    // and without this EVERY ONE of them allocated its own console and threw a
    // black window onto the desktop, stealing focus from whatever the operator
    // was doing. CREATE_NO_WINDOW (which is what this flag sets) gives the
    // child a console with no window, and grandchildren inherit that console
    // rather than allocating their own — so hiding this one process is what
    // keeps the whole render subtree off the screen. "headless" is about the
    // browser painting no page; it was never a promise about a console window.
    windowsHide: true,
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
    // Everything else here is treated as an advisory finding, never fatal —
    // but a cancellation is not a finding about the composition, it is the
    // operator stopping the run, and must keep propagating so "Rendering the
    // video" never starts after it. `wasCancelled()`, not `err instanceof
    // CancelledError`: `hf()` rejects with whatever `execFile` gives back on
    // an aborted signal (an `AbortError`, not our own class), so checking the
    // signal itself is what actually tells the two apart.
    if (wasCancelled()) throw new CancelledError();
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
  /** Parallel capture workers (1–8) for a local render; undefined = HyperFrames' own "auto". */
  workers?: number,
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
    void workers;
    // Always use 1 sequential capture worker on local renders unless explicitly
    // overridden via BOOKREEL_PARALLEL_WORKERS: HyperFrames reuses probeSession
    // as Worker 0 while spawning separate pages for Workers 1..N, which causes
    // periodic every-Nth-frame WebGL/compositor blinking across the video.
    const envWorkers = Number(process.env.BOOKREEL_PARALLEL_WORKERS);
    const safeWorkers =
      Number.isInteger(envWorkers) && envWorkers >= 1 && envWorkers <= 8 ? envWorkers : 1;
    const w = ["--workers", String(safeWorkers)];
    await hf(dir, ["render", "--quality", quality, "--output", outputAbs, ...w], 60 * 60_000);
    await masterRenderedVideoAudio(dir, outputAbs).catch(() => {});
  }

  const stat = await fs.stat(outputAbs);
  if (stat.size < 1024) throw new Error("Render produced an empty file");
  return outputAbs;
}

/**
 * Lossless-video (`-c:v copy`) broadcast audio mastering pass after HyperFrames
 * completes. Blends centered studio voiceover with stereo-widened cinematic music
 * and organic SFX, glued together at YouTube Shorts' -14 LUFS loudness standard.
 */
async function masterRenderedVideoAudio(projectDir: string, mp4Path: string): Promise<void> {
  const assetsDir = path.join(projectDir, "assets");
  const voiceWav = path.join(assetsDir, "voice.wav");
  const musicWav = path.join(assetsDir, "music.wav");
  const sfxWav = path.join(assetsDir, "sfx.wav");

  const hasFile = async (p: string) => fs.stat(p).then((s) => s.size > 512, () => false);
  const [hasVoice, hasMusic, hasSfx] = await Promise.all([
    hasFile(voiceWav),
    hasFile(musicWav),
    hasFile(sfxWav),
  ]);
  if (!hasVoice || (!hasMusic && !hasSfx)) return;

  const { stdout: durOut } = await exec(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4Path],
    { windowsHide: true, timeout: 15_000, ...abortOpts() },
  );
  const dur = parseFloat(durOut.trim());
  if (!Number.isFinite(dur) || dur <= 0.5) return;

  const inputs: string[] = ["-i", mp4Path, "-i", voiceWav];
  const mixInputs: string[] = ["[vpan]"];
  const chains: string[] = [
    // Voice starts at AUDIO_OFFSET (700ms), centered cleanly across L/R
    `[1:a]adelay=700|700,apad,atrim=0:${dur.toFixed(3)},pan=stereo|c0=c0|c1=c0[vpan]`,
  ];

  let nextIdx = 2;
  if (hasMusic) {
    inputs.push("-i", musicWav);
    chains.push(
      // Subtle Haas 14ms stereo spread on the already sidechain-ducked cinematic score
      `[${nextIdx}:a]atrim=0:${dur.toFixed(3)},volume=0.88,asplit=2[ml][mr];[mr]adelay=14[mrd];[ml][mrd]amerge=inputs=2[mpan]`,
    );
    mixInputs.push("[mpan]");
    nextIdx += 1;
  }
  if (hasSfx) {
    inputs.push("-i", sfxWav);
    chains.push(
      `[${nextIdx}:a]atrim=0:${dur.toFixed(3)},volume=1.08,asplit=2[sl][sr];[sr]adelay=9[srd];[sl][srd]amerge=inputs=2[span]`,
    );
    mixInputs.push("[span]");
  }

  chains.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:normalize=0,` +
      `acompressor=threshold=-16dB:ratio=2.2:attack=18:release=220:makeup=1,` +
      `loudnorm=I=-14:TP=-1.2:LRA=9[aout]`,
  );

  const tmpMp4 = `${mp4Path}.mastered.mp4`;
  try {
    await exec(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        ...inputs,
        "-filter_complex", chains.join(";"),
        "-map", "0:v:0",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-movflags", "+faststart",
        tmpMp4,
      ],
      { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 * 16, ...abortOpts() },
    );
    const st = await fs.stat(tmpMp4);
    if (st.size > 4096) {
      await fs.rename(tmpMp4, mp4Path);
    } else {
      await fs.rm(tmpMp4, { force: true }).catch(() => {});
    }
  } catch {
    await fs.rm(tmpMp4, { force: true }).catch(() => {});
  }
}
