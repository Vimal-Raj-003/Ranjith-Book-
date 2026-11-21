import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalComfyUrl } from "./cost-guard";

/** Default local ComfyUI installation discovered on this machine. */
export const DEFAULT_COMFYUI_DIR = "E:\\ComfyUI";
export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";
export const DEFAULT_COMFYUI_BAT = "E:\\ComfyUI\\run_comfyui_lowvram.bat";

/**
 * Resolve the local ComfyUI endpoint, enforcing loopback-only free operation.
 */
export function resolveComfyUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.BOOKREEL_COMFYUI_URL ?? DEFAULT_COMFYUI_URL).trim();
  const parsed = assertLocalComfyUrl(raw);
  return parsed.origin;
}

/**
 * Resolve the local ComfyUI installation directory on disk.
 */
export function resolveComfyDir(env: Record<string, string | undefined> = process.env): string {
  const custom = env.BOOKREEL_COMFYUI_DIR?.trim();
  if (custom) return path.resolve(custom);
  return DEFAULT_COMFYUI_DIR;
}

/**
 * Resolve the ComfyUI startup script (`run_comfyui_lowvram.bat`).
 */
export function resolveComfyStartupScript(env: Record<string, string | undefined> = process.env): string {
  const custom = env.BOOKREEL_COMFYUI_START_BAT?.trim();
  if (custom) return path.resolve(custom);
  const dir = resolveComfyDir(env);
  return path.join(dir, "run_comfyui_lowvram.bat");
}

/**
 * Resolve where generated visual cache files and intermediate upscales live.
 *
 * Deliberately prefers `E:\ComfyUI\bookreel-cache` when `E:\ComfyUI` exists on
 * disk (and falls back to `os.tmpdir()`), NEVER `.bookreel` on `G:\` unless
 * explicitly overridden: `G:\` has limited free space while `E:\` holds the
 * local AI workspace with >100 GB free.
 */
export function resolveVisualCacheDir(env: Record<string, string | undefined> = process.env): string {
  const custom = env.BOOKREEL_VISUAL_CACHE_DIR?.trim();
  if (custom) return path.resolve(custom);
  const comfyDir = resolveComfyDir(env);
  try {
    if (fs.existsSync(comfyDir) && fs.statSync(comfyDir).isDirectory()) {
      return path.join(comfyDir, "bookreel-cache");
    }
  } catch {
    // Fall through to system temp directory.
  }
  return path.join(os.tmpdir(), "bookreel-visual-cache");
}

/**
 * Deterministic SHA-256 content address for caching per-scene generated assets.
 * Identical scene prompts, style briefs, checkpoints and dimensions reuse cached
 * assets without re-running GPU inference on retries.
 */
export function visualCacheKey(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

export async function ensureVisualCacheSubdir(sub: "scenes" | "references" | "locks"): Promise<string> {
  const dir = path.join(resolveVisualCacheDir(), sub);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}
