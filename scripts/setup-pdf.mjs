#!/usr/bin/env node
/**
 * Make sure a Python with PyMuPDF is available for book-PDF analysis.
 *
 * PyMuPDF (https://pymupdf.readthedocs.io) reads the PDF: its text layer with
 * word positions, its fonts and outline, and a rendered image of every page.
 * Note its licence: PyMuPDF is AGPL-3.0 (or commercial, from Artifex).
 *
 * Checks the interpreter the app will use (BOOKREEL_PYTHON, else `python` /
 * `py -3` on Windows, `python3` / `python` elsewhere) and installs PyMuPDF with
 * pip only if it is missing.
 */
import { execFileSync } from "node:child_process";

const candidates = process.env.BOOKREEL_PYTHON
  ? [[process.env.BOOKREEL_PYTHON]]
  : process.platform === "win32"
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];

function run(cmd, args) {
  return execFileSync(cmd[0], [...cmd.slice(1), ...args], { stdio: "pipe", windowsHide: true }).toString().trim();
}

let python = null;
for (const c of candidates) {
  try {
    run(c, ["--version"]);
    python = c;
    break;
  } catch {
    /* try the next */
  }
}
if (!python) {
  console.error("No Python 3 found. Install Python 3.10+ (https://www.python.org/downloads/) and run this again.");
  process.exit(1);
}

try {
  const version = run(python, ["-c", "import pymupdf; print(pymupdf.VersionBind)"]);
  console.log(`PyMuPDF ${version} is already installed for ${python.join(" ")}. Book PDFs are ready.`);
  process.exit(0);
} catch {
  console.log(`Installing PyMuPDF for ${python.join(" ")}…`);
}

execFileSync(python[0], [...python.slice(1), "-m", "pip", "install", "--user", "pymupdf"], { stdio: "inherit" });
console.log(`PyMuPDF ${run(python, ["-c", "import pymupdf; print(pymupdf.VersionBind)"])} installed. Book PDFs are ready.`);
