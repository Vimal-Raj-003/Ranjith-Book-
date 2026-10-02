/**
 * High-resolution page images for the composition.
 *
 * Every box the pipeline measures — OCR words, line runs, sweep steps, camera
 * keys — lives in the 1600px page space `extract.py` produced. These assets do
 * not change that: they are the same page at `HI_SCALE` times the size, and the
 * composition multiplies coordinates by `HI_SCALE` only when it draws one. That
 * is what lets a 2.2x close-up render sharper than today's full-page view
 * instead of softer.
 *
 * Everything here is best-effort. A missing interpreter, a missing PDF, a full
 * disk: all resolve to "no hi-res page", and the composition falls back to the
 * 1600px asset it has always used.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./extract";

const exec = promisify(execFile);

/** How much bigger a hi-res page is than the space its boxes are measured in. */
export const HI_SCALE = 2;
export const HI_LONG_EDGE = 1600 * HI_SCALE;

const SCRIPT = fileURLToPath(new URL("./render-pages.py", import.meta.url));

export interface RenderPagesOptions {
  pdfPath: string;
  outDir: string;
  pageIndices: number[];
  longEdge: number;
}

/** Page index → absolute path of its hi-res JPEG. Pages that could not be rendered are absent. */
export async function renderPagesAt(opts: RenderPagesOptions): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (opts.pageIndices.length === 0) return out;
  try {
    const { bin, args } = await resolvePython();
    const { stdout } = await exec(
      bin,
      [...args, SCRIPT, opts.pdfPath, opts.outDir, String(opts.longEdge), opts.pageIndices.join(",")],
      { timeout: 120_000, windowsHide: true, maxBuffer: 1 << 20 },
    );
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return out;
    const parsed = JSON.parse(line) as { type: string; rendered?: number[] };
    if (parsed.type !== "done" || !Array.isArray(parsed.rendered)) return out;
    for (const index of parsed.rendered) {
      out.set(index, path.join(opts.outDir, `page-${String(index).padStart(4, "0")}@2x.jpg`));
    }
  } catch {
    // Best effort by contract: the composition falls back to the 1600px assets.
    return new Map();
  }
  return out;
}
