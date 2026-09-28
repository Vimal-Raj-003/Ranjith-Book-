/**
 * Runs `extract.py` (PyMuPDF) over an uploaded PDF and reads back its pages.
 *
 * PyMuPDF is a Python library, so it runs in a child process, the same way
 * Pocket TTS does. The interpreter is found once per process:
 * `BOOKREEL_PYTHON` wins; otherwise the usual names are probed until one can
 * `import pymupdf`. Failing that, the operator gets one sentence naming the
 * fix (`npm run setup:pdf`), never a Python traceback.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors";
import type { RawPdfManifest, RawPdfPage } from "../analysis/types";

const exec = promisify(execFile);

export const MAX_PDF_PAGES = 200;
/** Long edge of each rendered page, px — the same size as a photographed page's derivative. */
export const PAGE_LONG_EDGE = 1600;
/** A 200-page scanned book at print resolution; extraction is killed past this. */
const EXTRACT_TIMEOUT_MS = 20 * 60_000;

export class PdfError extends AppError {
  constructor(code: string, message: string) {
    super(`pdf_${code}`, message, 422);
  }
}

const SCRIPT = path.join(process.cwd(), "src", "lib", "pdf", "extract.py");

let python: Promise<{ bin: string; args: string[] }> | null = null;

async function probe(bin: string, args: string[]): Promise<boolean> {
  try {
    await exec(bin, [...args, "-c", "import pymupdf"], { timeout: 30_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The Python interpreter that has PyMuPDF, found once per process. */
export function resolvePython(): Promise<{ bin: string; args: string[] }> {
  if (!python) {
    python = (async () => {
      const override = process.env.BOOKREEL_PYTHON?.trim();
      const candidates: { bin: string; args: string[] }[] = override
        ? [{ bin: override, args: [] }]
        : process.platform === "win32"
          ? [{ bin: "python", args: [] }, { bin: "py", args: ["-3"] }, { bin: "python3", args: [] }]
          : [{ bin: "python3", args: [] }, { bin: "python", args: [] }];
      for (const c of candidates) if (await probe(c.bin, c.args)) return c;
      throw new PdfError(
        "no_pymupdf",
        "PDF support is not set up on this machine: no Python with PyMuPDF was found. Run `npm run setup:pdf`, or set BOOKREEL_PYTHON to a Python that has it.",
      );
    })();
    python.catch(() => {
      python = null;
    });
  }
  return python;
}

export interface ExtractProgress {
  pageCount: number;
  done: number;
}

/**
 * Extract every page of `pdfPath` into `outDir`. `onProgress` fires as each
 * page lands. Resolves with the manifest; the pages are read with `readPage`.
 */
export async function extractPdf(
  pdfPath: string,
  outDir: string,
  onProgress: (p: ExtractProgress) => void,
): Promise<RawPdfManifest> {
  const py = await resolvePython();
  await fs.mkdir(outDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      py.bin,
      [...py.args, SCRIPT, pdfPath, outDir, "--max-pages", String(MAX_PDF_PAGES), "--long-edge", String(PAGE_LONG_EDGE)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let pageCount = 0;
    let done = 0;
    let failure: PdfError | null = null;
    let finished = false;
    let buf = "";
    let stderr = "";

    const timer = setTimeout(() => {
      failure = new PdfError("timeout", `Reading the PDF took longer than ${EXTRACT_TIMEOUT_MS / 60_000} minutes and was stopped.`);
      child.kill("SIGKILL");
    }, EXTRACT_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { type: string; pageCount?: number; code?: string; message?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "start") pageCount = msg.pageCount ?? 0;
        else if (msg.type === "page") onProgress({ pageCount, done: ++done });
        else if (msg.type === "error") failure = new PdfError(msg.code ?? "failed", msg.message ?? "The PDF could not be read.");
        else if (msg.type === "done") finished = true;
      }
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new PdfError("spawn", `The PDF reader could not be started: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0 && finished) resolve();
      else reject(new PdfError("failed", `The PDF reader stopped unexpectedly (exit ${code}). ${stderr.trim().split("\n").slice(-1)[0] ?? ""}`.trim()));
    });
  });

  return JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as RawPdfManifest;
}

export async function readRawPage(outDir: string, index: number): Promise<RawPdfPage> {
  const file = path.join(outDir, `page-${String(index).padStart(4, "0")}.json`);
  return JSON.parse(await fs.readFile(file, "utf8")) as RawPdfPage;
}
