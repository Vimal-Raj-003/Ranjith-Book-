#!/usr/bin/env node
/**
 * Set up word-level timing for narration: faster-whisper (MIT,
 * https://github.com/SYSTRAN/faster-whisper) in its own Python 3.12
 * environment under .bookreel/py/align, built with uv — the same tool Pocket
 * TTS is installed with. Nothing is installed into the system Python.
 *
 * Then downloads the speech model (base.en, ~150MB) once into
 * .bookreel/models/whisper by aligning one second of silence.
 *
 *   npm run setup:align
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const venv = path.join(root, ".bookreel", "py", "align");
const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
const FASTER_WHISPER = "faster-whisper==1.2.1";

function findUv() {
  const candidates = [
    process.env.BOOKREEL_UV,
    path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv"),
    process.platform === "win32" ? "uv.exe" : "uv",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true });
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

const uv = findUv();
if (!uv) {
  console.error("uv was not found. Install it (https://docs.astral.sh/uv/) — `npm run setup:voice` explains how — then run this again.");
  process.exit(1);
}

if (!fs.existsSync(py)) {
  console.log("Creating the alignment environment (Python 3.12)…");
  execFileSync(uv, ["venv", "--python", "3.12", venv], { stdio: "inherit", windowsHide: true });
}
console.log(`Installing ${FASTER_WHISPER}…`);
execFileSync(uv, ["pip", "install", "--python", py, FASTER_WHISPER], { stdio: "inherit", windowsHide: true });

// Warm the model cache with one second of silence.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bookreel-align-"));
const wav = path.join(tmp, "silence.wav");
const header = Buffer.alloc(44);
const samples = 16000;
header.write("RIFF", 0);
header.writeUInt32LE(36 + samples * 2, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(samples * 2, 40);
fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(samples * 2)]));
const job = path.join(tmp, "job.json");
fs.writeFileSync(job, JSON.stringify({
  audio: wav,
  model: "base.en",
  modelDir: path.join(root, ".bookreel", "models", "whisper"),
  windows: [{ start: 0, end: 1 }],
}));
console.log("Downloading the speech model (base.en) if needed…");
execFileSync(py, [path.join(root, "src", "lib", "media", "align.py"), job, path.join(tmp, "out.json")], {
  stdio: ["ignore", "ignore", "inherit"],
  windowsHide: true,
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log("Word timing is ready: subtitles and highlights will follow the recorded voice.");
