/**
 * High-resolution page images for the composition.
 *
 * Every box the pipeline measures — OCR words, line runs, sweep steps, camera
 * keys — lives in the 1600px page space `extract.py` produced, and it STAYS
 * there. Nothing in the composition multiplies a coordinate. These assets are
 * the same page rendered at `HI_LONG_EDGE` (twice the long edge); the
 * composition draws the hi-res image into the SAME declared 1600px box, so the
 * browser downsamples a sharper source. That is what lets a 2.2x close-up render
 * sharper than today's full-page view instead of softer.
 *
 * `HI_SCALE` exists only to derive `HI_LONG_EDGE`. Do not use it to scale boxes.
 *
 * Everything here is best-effort. A missing interpreter, a missing PDF, a full
 * disk: all resolve to "no hi-res page", and the composition falls back to the
 * 1600px asset it has always used.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePython } from "./extract";

const exec = promisify(execFile);

/** How much bigger a hi-res page is than the space its boxes are measured in. */
export const HI_SCALE = 2;
export const HI_LONG_EDGE = 1600 * HI_SCALE;

// Not `import.meta.url`: under Next's server runtime that points into
// Turbopack's virtual space (see scenes/icons.ts). extract.ts does the same.
const SCRIPT = path.join(process.cwd(), "src", "lib", "pdf", "render-pages.py");

export interface RenderPagesOptions {
  pdfPath: string;
  outDir: string;
  pageIndices: number[];
  longEdge: number;
}

export interface RenderPagesResult {
  /** Page index → absolute path of its hi-res JPEG. Pages that could not be rendered are absent. */
  rendered: Map<number, string>;
  /**
   * Pages the script deliberately left alone (no extractable text, or out of
   * range). Empty on any failure, so "skipped" and "failed" can be told apart:
   * only a script that ran to completion reports a skip.
   */
  skipped: number[];
}

export async function renderPagesAt(opts: RenderPagesOptions): Promise<RenderPagesResult> {
  const rendered = new Map<number, string>();
  if (opts.pageIndices.length === 0) return { rendered, skipped: [] };
  try {
    const { bin, args } = await resolvePython();
    const { stdout } = await exec(
      bin,
      [...args, SCRIPT, opts.pdfPath, opts.outDir, String(opts.longEdge), opts.pageIndices.join(",")],
      { timeout: 120_000, windowsHide: true, maxBuffer: 1 << 20 },
    );
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return { rendered, skipped: [] };
    const parsed = JSON.parse(line) as { type: string; rendered?: number[]; skipped?: number[] };
    if (parsed.type !== "done" || !Array.isArray(parsed.rendered)) return { rendered, skipped: [] };
    for (const index of parsed.rendered) {
      rendered.set(index, path.join(opts.outDir, `page-${String(index).padStart(4, "0")}@2x.jpg`));
    }
    return { rendered, skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [] };
  } catch {
    // Best effort by contract: the composition falls back to the 1600px assets.
    return { rendered: new Map(), skipped: [] };
  }
}
