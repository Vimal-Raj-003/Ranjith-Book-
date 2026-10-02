import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderPagesAt, HI_LONG_EDGE, HI_SCALE } from "../src/lib/pdf/render-pages";

const VECTOR_PDF = path.join(process.cwd(), ".bookreel", "uploads", "cmuo1h91x0002n60sv9qah7rr", "source.pdf");
const SCANNED_PDF = path.join(process.cwd(), ".bookreel", "uploads", "cmukwbffp0002n6ikm6fvkcff", "source.pdf");

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), "brhi-"));

test("the scale and the long edge agree with the 1600px space every box is measured in", () => {
  assert.equal(HI_LONG_EDGE, 1600 * HI_SCALE);
});

test("a vector page renders at the high resolution and lands where it says it did", async (t) => {
  if (!(await fs.stat(VECTOR_PDF).catch(() => null))) return t.skip("fixture PDF not on this machine");
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: VECTOR_PDF, outDir: out, pageIndices: [8, 10], longEdge: HI_LONG_EDGE });
    assert.deepEqual([...got.rendered.keys()].sort((a, b) => a - b), [8, 10]);
    assert.deepEqual(got.skipped, []);
    for (const p of got.rendered.values()) {
      const st = await fs.stat(p);
      assert.ok(st.size > 50_000, `${p} is a real image, not an empty file`);
    }
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("a scanned page is skipped — upscaling a photograph buys nothing", async (t) => {
  if (!(await fs.stat(SCANNED_PDF).catch(() => null))) return t.skip("fixture PDF not on this machine");
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: SCANNED_PDF, outDir: out, pageIndices: [0, 1], longEdge: HI_LONG_EDGE });
    assert.equal(got.rendered.size, 0, "no page with zero extractable text is rendered");
    // Absent is not the same as skipped: a crash, a corrupt file or a missing
    // PyMuPDF also yields an empty map. Only the script itself reports a scan
    // as skipped, so this proves the skip branch ran.
    assert.deepEqual(got.skipped, [0, 1], "the scan's pages are reported as skipped, not merely missing");
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("a missing PDF resolves to an empty map rather than throwing — the render must survive it", async () => {
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: path.join(out, "nope.pdf"), outDir: out, pageIndices: [0], longEdge: HI_LONG_EDGE });
    assert.equal(got.rendered.size, 0);
    assert.deepEqual(got.skipped, [], "a failure is not a skip");
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("the script is located from the working directory, not from import.meta.url, which Next rewrites", async () => {
  const src = await fs.readFile(path.join(process.cwd(), "src", "lib", "pdf", "render-pages.ts"), "utf8");
  assert.ok(!/import\.meta\.url/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "no import.meta.url in code");
  await fs.stat(path.join(process.cwd(), "src", "lib", "pdf", "render-pages.py"));
});
