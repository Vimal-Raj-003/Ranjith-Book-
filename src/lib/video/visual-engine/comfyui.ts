/**
 * SERVER-ONLY. Local ComfyUI Integration (`http://127.0.0.1:8188` / `E:\ComfyUI`).
 *
 * Guarantees:
 *  - Strictly loopback-only (`assertLocalComfyUrl`) — zero external or paid API calls.
 *  - Reuses an already-running ComfyUI instance without launching duplicates.
 *  - Automatically starts `E:\ComfyUI\run_comfyui_lowvram.bat` when stopped, guarded
 *    by both an in-process mutex and a cross-process filesystem lockfile.
 *  - Inspects `/system_stats`, `/queue`, and `/object_info` to detect checkpoints,
 *    video nodes/models, and available GPU VRAM before submitting work.
 *  - Never kills ComfyUI and never interrupts or unloads models while another
 *    project has active or pending queue items.
 *  - Releases GPU memory (`POST /free`) after BookReel's batch completes (when the
 *    queue is idle) so headless Chrome / HyperFrames rendering has clean VRAM.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { FFMPEG } from "../../media/ffmpeg";
import { abortOpts, wasCancelled, CancelledError } from "../../cancel";
import { assertLocalComfyUrl } from "./cost-guard";
import {
  ensureVisualCacheSubdir,
  resolveComfyDir,
  resolveComfyStartupScript,
  resolveComfyUrl,
} from "./paths";
import { generateSmoothDepthMap } from "./depth";
import type { ComfyRuntimeDiagnostic } from "./types";

const exec = promisify(execFile);

const CLIENT_ID = "bookreel-visual-engine";
const STARTUP_LOCK_MAX_AGE_MS = 120_000;
const STARTUP_WAIT_MS = 95_000;
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const VIDEO_GENERATION_TIMEOUT_MS = 360_000;

/** Minimum reclaimable VRAM required for SD 1.5 `--lowvram --force-fp16` portrait generation. */
export const DEFAULT_MIN_IMAGE_VRAM_MB = 1_050;
/** Minimum reclaimable VRAM required for local SVD / video generation on consumer GPUs. */
export const DEFAULT_MIN_VIDEO_VRAM_MB = 4_200;

let startupPromise: Promise<boolean> | null = null;

interface ComfySystemStats {
  system?: {
    os?: string;
    ram_total?: number;
    ram_free?: number;
    comfyui_version?: string;
  };
  devices?: Array<{
    name?: string;
    type?: string;
    vram_total?: number;
    vram_free?: number;
    torch_vram_total?: number;
    torch_vram_free?: number;
  }>;
}

interface ComfyQueueStatus {
  queue_running?: unknown[];
  queue_pending?: unknown[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function comfyFetchJson<T>(
  baseUrl: string,
  endpoint: string,
  init?: RequestInit,
  timeoutMs = 8_000,
): Promise<T | null> {
  assertLocalComfyUrl(baseUrl);
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  assertLocalComfyUrl(url);

  const controller = new AbortController();
  const outer = abortOpts().signal;
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

async function comfyFetchBuffer(
  baseUrl: string,
  endpoint: string,
  timeoutMs = 20_000,
): Promise<Buffer | null> {
  assertLocalComfyUrl(baseUrl);
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  assertLocalComfyUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getComfySystemStats(baseUrl = resolveComfyUrl()): Promise<ComfySystemStats | null> {
  return comfyFetchJson<ComfySystemStats>(baseUrl, "/system_stats", undefined, 4_000);
}

export async function getComfyQueue(baseUrl = resolveComfyUrl()): Promise<{ running: number; pending: number; externalBusy: boolean }> {
  const q = await comfyFetchJson<ComfyQueueStatus>(baseUrl, "/queue", undefined, 4_000);
  if (!q) return { running: 0, pending: 0, externalBusy: false };
  const runningArr = Array.isArray(q.queue_running) ? q.queue_running : [];
  const pendingArr = Array.isArray(q.queue_pending) ? q.queue_pending : [];

  const isExternal = (entry: unknown): boolean => {
    if (!Array.isArray(entry)) return false;
    const meta = entry[3];
    if (meta && typeof meta === "object" && (meta as Record<string, unknown>).bookreel === true) {
      return false;
    }
    return true;
  };

  const externalBusy = runningArr.some(isExternal) || pendingArr.some(isExternal);
  return { running: runningArr.length, pending: pendingArr.length, externalBusy };
}

/**
 * Start `E:\ComfyUI\run_comfyui_lowvram.bat` if ComfyUI is not already listening
 * on port 8188. Protected by an in-memory promise + cross-process lockfile so
 * duplicate ComfyUI processes are never spawned.
 */
export async function ensureComfyRunning(opts: {
  baseUrl?: string;
  autoStart?: boolean;
  startupScript?: string;
  comfyDir?: string;
} = {}): Promise<{ reachable: boolean; autoStarted: boolean; reusedExisting: boolean; reason?: string }> {
  const baseUrl = opts.baseUrl ?? resolveComfyUrl();
  assertLocalComfyUrl(baseUrl);

  if (process.env.BOOKREEL_DISABLE_COMFYUI === "1") {
    return {
      reachable: false,
      autoStarted: false,
      reusedExisting: false,
      reason: "ComfyUI disabled via BOOKREEL_DISABLE_COMFYUI=1.",
    };
  }

  const initial = await getComfySystemStats(baseUrl);
  if (initial) {
    return { reachable: true, autoStarted: false, reusedExisting: true };
  }

  const allowAutoStart = opts.autoStart ?? process.env.BOOKREEL_COMFYUI_AUTOSTART !== "0";
  if (!allowAutoStart) {
    return {
      reachable: false,
      autoStarted: false,
      reusedExisting: false,
      reason: `ComfyUI is not running at ${baseUrl} (auto-start disabled).`,
    };
  }

  const batPath = opts.startupScript ?? resolveComfyStartupScript();
  const comfyDir = opts.comfyDir ?? resolveComfyDir();
  if (!fs.existsSync(batPath)) {
    return {
      reachable: false,
      autoStarted: false,
      reusedExisting: false,
      reason: `ComfyUI startup script not found at ${batPath}.`,
    };
  }

  if (!startupPromise) {
    startupPromise = (async () => {
      const lockDir = await ensureVisualCacheSubdir("locks");
      const lockFile = path.join(lockDir, "comfyui-startup.lock");
      let shouldSpawn = true;

      try {
        const stat = await fsp.stat(lockFile);
        if (Date.now() - stat.mtimeMs < STARTUP_LOCK_MAX_AGE_MS) {
          // Another worker recently initiated startup; just wait for readiness.
          shouldSpawn = false;
        }
      } catch {
        // Lock does not exist yet.
      }

      if (shouldSpawn) {
        // Re-verify right before spawning in case it came up in the meantime.
        if (await getComfySystemStats(baseUrl)) return true;
        await fsp.writeFile(lockFile, `${process.pid}:${Date.now()}`, "utf8").catch(() => {});

        const child = spawn("cmd.exe", ["/c", batPath], {
          cwd: comfyDir,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      }

      const deadline = Date.now() + STARTUP_WAIT_MS;
      while (Date.now() < deadline) {
        if (wasCancelled()) throw new CancelledError();
        await sleep(1_500);
        if (await getComfySystemStats(baseUrl)) {
          await fsp.unlink(lockFile).catch(() => {});
          return true;
        }
      }
      await fsp.unlink(lockFile).catch(() => {});
      return false;
    })().finally(() => {
      startupPromise = null;
    });
  }

  const started = await startupPromise;
  if (!started) {
    return {
      reachable: false,
      autoStarted: false,
      reusedExisting: false,
      reason: `ComfyUI did not become ready at ${baseUrl} within ${Math.round(STARTUP_WAIT_MS / 1000)}s.`,
    };
  }
  return { reachable: true, autoStarted: true, reusedExisting: false };
}

function scoreImageCheckpoint(name: string): number {
  const lower = name.toLowerCase();
  // Exclude video-only checkpoints from text-to-image selection.
  if (/svd|img2vid|wan2|hunyuan|ltx[-_]?video|mochi|animatediff/i.test(lower)) return -100;
  // Prefer dedicated cinematic / photoreal / illustrative SD1.5 or SDXL Lightning checkpoints over raw base SD 1.5.
  if (/dreamshaper|juggernaut|photon|epicrealism|rev_animated|deliberate|realisticvision/i.test(lower)) return 100;
  if (/lightning|turbo|hyper/i.test(lower)) return 85;
  if (/toonyou|counterfeit|anything|abyssorange|ghostmix|disney/i.test(lower)) return 75;
  if (/v1-5|sd15|sd_v15/i.test(lower)) return 60;
  if (/sdxl|xl/i.test(lower)) return 50;
  return 40;
}

function isVideoCheckpoint(name: string): boolean {
  return /svd|img2vid/i.test(name.toLowerCase());
}

/**
 * Inspect ComfyUI's loaded checkpoints, video nodes, queue state, and GPU VRAM.
 */
export async function inspectComfyCapabilities(opts: {
  baseUrl?: string;
  autoStart?: boolean;
  minImageVramMb?: number;
  minVideoVramMb?: number;
  requiredCheckpointOverride?: string | null;
} = {}): Promise<ComfyRuntimeDiagnostic> {
  const baseUrl = opts.baseUrl ?? resolveComfyUrl();
  const minImageVramMb =
    opts.minImageVramMb ??
    (Number(process.env.BOOKREEL_MIN_VRAM_MB) || DEFAULT_MIN_IMAGE_VRAM_MB);
  const minVideoVramMb = opts.minVideoVramMb ?? DEFAULT_MIN_VIDEO_VRAM_MB;

  const boot = await ensureComfyRunning({ baseUrl, autoStart: opts.autoStart });
  if (!boot.reachable) {
    return {
      reachable: false,
      autoStarted: false,
      reusedExisting: false,
      busyWithExternalWork: false,
      checkpoint: null,
      availableCheckpoints: [],
      videoModel: null,
      videoCapable: false,
      vramTotalMb: null,
      vramFreeMb: null,
      vramReleasedAfterRun: false,
      fallbackReason: boot.reason ?? "ComfyUI unreachable.",
    };
  }

  const [stats, queue, ckptNodeInfo, svdNodeInfo] = await Promise.all([
    getComfySystemStats(baseUrl),
    getComfyQueue(baseUrl),
    comfyFetchJson<Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>>(
      baseUrl,
      "/object_info/CheckpointLoaderSimple",
    ),
    comfyFetchJson<Record<string, unknown>>(baseUrl, "/object_info/SVD_img2vid_Conditioning"),
  ]);

  const dev = stats?.devices?.[0];
  const vramTotalMb = dev?.vram_total ? Math.round(dev.vram_total / 1_048_576) : null;
  // Reclaimable VRAM = driver free VRAM + idle cached PyTorch pool VRAM.
  const rawFreeBytes = (dev?.vram_free ?? 0) + (dev?.torch_vram_free ?? 0);
  const vramFreeMb = dev?.vram_total ? Math.round(rawFreeBytes / 1_048_576) : null;

  const rawCkpts =
    ckptNodeInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  const availableCheckpoints = Array.isArray(rawCkpts)
    ? rawCkpts.filter((c): c is string => typeof c === "string")
    : [];

  let chosenCheckpoint: string | null = null;
  const override = opts.requiredCheckpointOverride ?? process.env.BOOKREEL_COMFYUI_CHECKPOINT?.trim();

  if (override) {
    chosenCheckpoint = availableCheckpoints.includes(override) ? override : null;
    if (!chosenCheckpoint) {
      return {
        reachable: true,
        autoStarted: boot.autoStarted,
        reusedExisting: boot.reusedExisting,
        busyWithExternalWork: queue.externalBusy,
        checkpoint: null,
        availableCheckpoints,
        videoModel: null,
        videoCapable: false,
        vramTotalMb,
        vramFreeMb,
        vramReleasedAfterRun: false,
        fallbackReason: `Requested ComfyUI checkpoint "${override}" is not installed in E:\\ComfyUI\\models\\checkpoints.`,
      };
    }
  } else {
    const ranked = availableCheckpoints
      .map((c) => ({ name: c, score: scoreImageCheckpoint(c) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    chosenCheckpoint = ranked[0]?.name ?? null;
  }

  if (!chosenCheckpoint) {
    return {
      reachable: true,
      autoStarted: boot.autoStarted,
      reusedExisting: boot.reusedExisting,
      busyWithExternalWork: queue.externalBusy,
      checkpoint: null,
      availableCheckpoints,
      videoModel: null,
      videoCapable: false,
      vramTotalMb,
      vramFreeMb,
      vramReleasedAfterRun: false,
      fallbackReason: "No compatible image checkpoint found in ComfyUI models/checkpoints.",
    };
  }

  if (vramFreeMb !== null && vramFreeMb < minImageVramMb) {
    return {
      reachable: true,
      autoStarted: boot.autoStarted,
      reusedExisting: boot.reusedExisting,
      busyWithExternalWork: queue.externalBusy,
      checkpoint: null,
      availableCheckpoints,
      videoModel: null,
      videoCapable: false,
      vramTotalMb,
      vramFreeMb,
      vramReleasedAfterRun: false,
      fallbackReason: `Insufficient free GPU VRAM (${vramFreeMb} MB available < ${minImageVramMb} MB required).`,
    };
  }

  const svdModel = availableCheckpoints.find(isVideoCheckpoint) ?? null;
  const hasSvdNode = Boolean(svdNodeInfo && "SVD_img2vid_Conditioning" in svdNodeInfo);
  const videoCapable =
    Boolean(svdModel && hasSvdNode) &&
    (vramFreeMb === null || vramFreeMb >= minVideoVramMb) &&
    process.env.BOOKREEL_DISABLE_COMFY_VIDEO !== "1";

  return {
    reachable: true,
    autoStarted: boot.autoStarted,
    reusedExisting: boot.reusedExisting,
    busyWithExternalWork: queue.externalBusy,
    checkpoint: chosenCheckpoint,
    availableCheckpoints,
    videoModel: videoCapable ? svdModel : null,
    videoCapable,
    vramTotalMb,
    vramFreeMb,
    vramReleasedAfterRun: false,
    fallbackReason: null,
  };
}

function deterministicSeed(cacheKey: string): number {
  const buf = crypto.createHash("sha256").update(cacheKey).digest();
  // Positive 31-bit integer seed.
  return (buf.readUInt32BE(0) & 0x7fffffff) || 42069;
}

function resolutionForCheckpoint(ckpt: string): { width: number; height: number; steps: number; cfg: number } {
  const lower = ckpt.toLowerCase();
  if (/sdxl|xl/i.test(lower)) {
    const fast = /lightning|turbo|hyper/i.test(lower);
    return { width: 768, height: 1344, steps: fast ? 6 : 18, cfg: fast ? 2.0 : 6.5 };
  }
  // SD 1.5 optimal 9:16 portrait resolution without double-head duplication artifacts:
  // 512×896 (exact 4:7 ~ 9:15.75, divisible by 64) fits well within 6GB VRAM on RTX 2060.
  const fast = /lightning|turbo|lcm|hyper/i.test(lower);
  return { width: 512, height: 896, steps: fast ? 6 : 24, cfg: fast ? 2.0 : 7.5 };
}

interface ComfyHistoryItem {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<
    string,
    {
      images?: Array<{ filename: string; subfolder?: string; type?: string }>;
    }
  >;
}

async function submitAndWaitWorkflow(
  baseUrl: string,
  workflow: Record<string, unknown>,
  episodeId: string,
  timeoutMs: number,
): Promise<ComfyHistoryItem> {
  const submitRes = await comfyFetchJson<{ prompt_id?: string; node_errors?: unknown }>(
    baseUrl,
    "/prompt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        prompt: workflow,
        extra_data: { bookreel: true, episodeId },
      }),
    },
    12_000,
  );

  const promptId = submitRes?.prompt_id;
  if (!promptId) {
    throw new Error("ComfyUI rejected or failed to queue the workflow prompt.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wasCancelled() || abortOpts().signal?.aborted) {
      throw new CancelledError();
    }
    await sleep(1_000);
    const hist = await comfyFetchJson<Record<string, ComfyHistoryItem>>(
      baseUrl,
      `/history/${encodeURIComponent(promptId)}`,
      undefined,
      6_000,
    );
    const entry = hist?.[promptId];
    if (!entry) continue;

    if (entry.status?.status_str === "error") {
      throw new Error(`ComfyUI execution error on prompt ${promptId}.`);
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0) {
      return entry;
    }
  }
  throw new Error(`ComfyUI workflow timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

export interface GenerateComfySceneInput {
  episodeId: string;
  cacheKey: string;
  checkpoint: string;
  videoModel?: string | null;
  positivePrompt: string;
  negativePrompt: string;
  sceneDurationSec: number;
  dominantHex: string;
  accentHex: string;
  baseUrl?: string;
}

export interface GenerateComfySceneOutput {
  imagePath: string;
  depthPath: string;
  videoPath: string | null;
  cacheHit: boolean;
}

/**
 * Generate (or load from content-hash cache) an original 1080×1920 cinematic
 * image + smooth 3D depth map + optional local AI video clip via ComfyUI.
 */
export async function generateSceneWithComfy(
  input: GenerateComfySceneInput,
): Promise<GenerateComfySceneOutput> {
  const baseUrl = input.baseUrl ?? resolveComfyUrl();
  assertLocalComfyUrl(baseUrl);

  const scenesCacheRoot = await ensureVisualCacheSubdir("scenes");
  const sceneDir = path.join(scenesCacheRoot, input.cacheKey);
  const imagePath = path.join(sceneDir, "plate.jpg");
  const depthPath = path.join(sceneDir, "depth.png");
  const videoPath = path.join(sceneDir, "clip.mp4");

  // Content-addressed resume: if this exact scene was already generated, reuse immediately!
  const [hasImg, hasDepth] = await Promise.all([
    fsp.stat(imagePath).then((s) => s.size > 2048, () => false),
    fsp.stat(depthPath).then((s) => s.size > 512, () => false),
  ]);
  const hasVid = await fsp.stat(videoPath).then((s) => s.size > 4096, () => false);

  if (hasImg && hasDepth && (!input.videoModel || hasVid)) {
    return {
      imagePath,
      depthPath,
      videoPath: hasVid ? videoPath : null,
      cacheHit: true,
    };
  }

  await fsp.mkdir(sceneDir, { recursive: true });

  const seed = deterministicSeed(input.cacheKey);
  const res = resolutionForCheckpoint(input.checkpoint);
  const prefix = `bookreel/br_${input.cacheKey.slice(0, 12)}`;

  const isSdxl = /sdxl|xl/i.test(input.checkpoint);
  const hiresWidth = isSdxl ? res.width : 640;
  const hiresHeight = isSdxl ? res.height : 1152;

  const imageWorkflow: Record<string, unknown> = isSdxl
    ? {
        "3": {
          class_type: "KSampler",
          inputs: {
            seed,
            steps: res.steps,
            cfg: res.cfg,
            sampler_name: "dpmpp_2m",
            scheduler: "karras",
            denoise: 1.0,
            model: ["4", 0],
            positive: ["6", 0],
            negative: ["7", 0],
            latent_image: ["5", 0],
          },
        },
        "4": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: input.checkpoint },
        },
        "5": {
          class_type: "EmptyLatentImage",
          inputs: { width: res.width, height: res.height, batch_size: 1 },
        },
        "6": {
          class_type: "CLIPTextEncode",
          inputs: { text: input.positivePrompt.slice(0, 900), clip: ["4", 1] },
        },
        "7": {
          class_type: "CLIPTextEncode",
          inputs: { text: input.negativePrompt.slice(0, 600), clip: ["4", 1] },
        },
        "8": {
          class_type: "VAEDecode",
          inputs: { samples: ["3", 0], vae: ["4", 2] },
        },
        "9": {
          class_type: "SaveImage",
          inputs: { filename_prefix: prefix, images: ["8", 0] },
        },
      }
    : {
        // 2-Stage Latent Hi-Res Fix for SD 1.5: base 512×896 composition -> 640×1152 detail refine pass
        "3": {
          class_type: "KSampler",
          inputs: {
            seed,
            steps: 22,
            cfg: 7.2,
            sampler_name: "dpmpp_2m",
            scheduler: "karras",
            denoise: 1.0,
            model: ["4", 0],
            positive: ["6", 0],
            negative: ["7", 0],
            latent_image: ["5", 0],
          },
        },
        "4": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: input.checkpoint },
        },
        "5": {
          class_type: "EmptyLatentImage",
          inputs: { width: res.width, height: res.height, batch_size: 1 },
        },
        "6": {
          class_type: "CLIPTextEncode",
          inputs: { text: input.positivePrompt.slice(0, 900), clip: ["4", 1] },
        },
        "7": {
          class_type: "CLIPTextEncode",
          inputs: { text: input.negativePrompt.slice(0, 650), clip: ["4", 1] },
        },
        "10": {
          class_type: "LatentUpscale",
          inputs: {
            samples: ["3", 0],
            upscale_method: "bislerp",
            width: hiresWidth,
            height: hiresHeight,
            crop: "disabled",
          },
        },
        "11": {
          class_type: "KSampler",
          inputs: {
            seed: seed + 1,
            steps: 10,
            cfg: 6.5,
            sampler_name: "dpmpp_2m",
            scheduler: "karras",
            denoise: 0.42,
            model: ["4", 0],
            positive: ["6", 0],
            negative: ["7", 0],
            latent_image: ["10", 0],
          },
        },
        "8": {
          class_type: "VAEDecode",
          inputs: { samples: ["11", 0], vae: ["4", 2] },
        },
        "9": {
          class_type: "SaveImage",
          inputs: { filename_prefix: prefix, images: ["8", 0] },
        },
      };

  const history = await submitAndWaitWorkflow(
    baseUrl,
    imageWorkflow,
    input.episodeId,
    IMAGE_GENERATION_TIMEOUT_MS,
  );

  const imgMeta = history.outputs?.["9"]?.images?.[0];
  if (!imgMeta?.filename) {
    throw new Error("ComfyUI completed without producing an output image.");
  }

  const viewQuery = new URLSearchParams({
    filename: imgMeta.filename,
    subfolder: imgMeta.subfolder ?? "",
    type: imgMeta.type ?? "output",
  });
  const rawImageBuf = await comfyFetchBuffer(baseUrl, `/view?${viewQuery.toString()}`);
  if (!rawImageBuf || rawImageBuf.length < 1024) {
    throw new Error("Could not retrieve generated image bytes from ComfyUI /view.");
  }

  // Upscale to crisp vertical 1080×1920 with Lanczos3 + rich low-key cinema contrast (preventing blown-out highlights).
  const upscaledBuf = await sharp(rawImageBuf)
    .resize(1080, 1920, { fit: "cover", position: "attention", kernel: sharp.kernel.lanczos3 })
    .modulate({ saturation: 1.18, brightness: 0.92 })
    .linear(1.08, -10)
    .sharpen({ sigma: 1.0, m1: 0.68, m2: 1.55 })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();

  await fsp.writeFile(imagePath, upscaledBuf);
  await generateSmoothDepthMap(upscaledBuf, depthPath);

  // Optional local Image-to-Video synthesis if a compatible SVD checkpoint is present and VRAM allows.
  let generatedVideoPath: string | null = null;
  if (input.videoModel) {
    try {
      generatedVideoPath = await tryGenerateSvdClip({
        baseUrl,
        episodeId: input.episodeId,
        cacheKey: input.cacheKey,
        videoModel: input.videoModel,
        initImageFilename: imgMeta.filename,
        initImageSubfolder: imgMeta.subfolder ?? "",
        sceneDurationSec: input.sceneDurationSec,
        outMp4Path: videoPath,
        seed,
      });
    } catch {
      // Fall back cleanly to the 2.5D depth-parallax plate we already generated.
      generatedVideoPath = null;
    }
  }

  return {
    imagePath,
    depthPath,
    videoPath: generatedVideoPath,
    cacheHit: false,
  };
}

async function tryGenerateSvdClip(opts: {
  baseUrl: string;
  episodeId: string;
  cacheKey: string;
  videoModel: string;
  initImageFilename: string;
  initImageSubfolder: string;
  sceneDurationSec: number;
  outMp4Path: string;
  seed: number;
}): Promise<string | null> {
  // Copy the generated output image into ComfyUI's input/bookreel folder so LoadImage can read it.
  const comfyDir = resolveComfyDir();
  const srcFile = path.join(comfyDir, "output", opts.initImageSubfolder, opts.initImageFilename);
  const inputRel = `bookreel_${opts.cacheKey.slice(0, 12)}.png`;
  const dstFile = path.join(comfyDir, "input", inputRel);
  await fsp.copyFile(srcFile, dstFile);

  const frames = 14;
  const fps = 6;
  const prefix = `bookreel/vid_${opts.cacheKey.slice(0, 12)}`;

  const svdWorkflow: Record<string, unknown> = {
    "1": {
      class_type: "ImageOnlyCheckpointLoader",
      inputs: { ckpt_name: opts.videoModel },
    },
    "2": {
      class_type: "VideoLinearCFGGuidance",
      inputs: { model: ["1", 0], min_cfg: 1.0 },
    },
    "3": {
      class_type: "LoadImage",
      inputs: { image: inputRel },
    },
    "4": {
      class_type: "SVD_img2vid_Conditioning",
      inputs: {
        clip_vision: ["1", 1],
        init_image: ["3", 0],
        vae: ["1", 2],
        width: 448,
        height: 768,
        video_frames: frames,
        motion_bucket_id: 96,
        fps,
        augmentation_level: 0.02,
      },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: opts.seed,
        steps: 16,
        cfg: 2.5,
        sampler_name: "euler",
        scheduler: "karras",
        denoise: 1.0,
        model: ["2", 0],
        positive: ["4", 0],
        negative: ["4", 1],
        latent_image: ["4", 2],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: prefix, images: ["6", 0] },
    },
  };

  const hist = await submitAndWaitWorkflow(
    opts.baseUrl,
    svdWorkflow,
    opts.episodeId,
    VIDEO_GENERATION_TIMEOUT_MS,
  );
  const outImages = hist.outputs?.["7"]?.images ?? [];
  if (outImages.length < 4) return null;

  const framesDir = path.join(path.dirname(opts.outMp4Path), "frames");
  await fsp.mkdir(framesDir, { recursive: true });
  for (let i = 0; i < outImages.length; i++) {
    const q = new URLSearchParams({
      filename: outImages[i].filename,
      subfolder: outImages[i].subfolder ?? "",
      type: outImages[i].type ?? "output",
    });
    const b = await comfyFetchBuffer(opts.baseUrl, `/view?${q.toString()}`);
    if (b) {
      await fsp.writeFile(path.join(framesDir, `f_${String(i).padStart(4, "0")}.png`), b);
    }
  }

  // Normalize to seek-friendly 1080×1920 @ 30fps, short GOP (-g 15), looped/stretched cleanly.
  const targetDur = Math.max(1.5, Math.min(14, opts.sceneDurationSec + 1.0));
  await exec(
    FFMPEG,
    [
      "-y",
      "-stream_loop", "-1",
      "-framerate", String(fps),
      "-i", path.join(framesDir, "f_%04d.png"),
      "-t", targetDur.toFixed(3),
      "-vf", "scale=1080:1920:flags=lanczos,fps=30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-g", "15",
      "-pix_fmt", "yuv420p",
      "-an",
      opts.outMp4Path,
    ],
    { windowsHide: true, timeout: 90_000 },
  );

  await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  await fsp.unlink(dstFile).catch(() => {});

  const st = await fsp.stat(opts.outMp4Path).catch(() => null);
  return st && st.size > 4096 ? opts.outMp4Path : null;
}

/**
 * Safely release ComfyUI's cached VRAM models BEFORE Chrome/HyperFrames renders,
 * ONLY when no other project has running or pending jobs in ComfyUI's queue.
 */
export async function releaseComfyVramSafely(baseUrl = resolveComfyUrl()): Promise<boolean> {
  try {
    assertLocalComfyUrl(baseUrl);
    const queue = await getComfyQueue(baseUrl);
    if (queue.running > 0 || queue.pending > 0 || queue.externalBusy) {
      return false;
    }
    const res = await comfyFetchJson<Record<string, unknown>>(
      baseUrl,
      "/free",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      },
      6_000,
    );
    return res !== null;
  } catch {
    return false;
  }
}
