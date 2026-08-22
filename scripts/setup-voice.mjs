#!/usr/bin/env node
/**
 * Installs Kyutai Pocket TTS — the natural CPU voice used for narration.
 * https://github.com/kyutai-labs/pocket-tts
 *
 * Pocket TTS needs Python 3.10-3.14. Rather than depend on the system Python
 * (macOS still ships 3.9), this fetches `uv`, which manages its own runtime.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN_DIR = path.join(process.cwd(), "tools", "bin");
const POCKET = path.join(os.homedir(), ".local", "bin", "pocket-tts");

function have(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (fs.existsSync(POCKET) || have("pocket-tts")) {
  console.log("Pocket TTS is already installed.");
  process.exit(0);
}

const uv = fs.existsSync(path.join(BIN_DIR, "uv")) ? path.join(BIN_DIR, "uv") : have("uv") ? "uv" : null;

const UV_TARGET = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
}[`${os.platform()}-${os.arch()}`];

let uvBin = uv;
if (!uvBin) {
  if (!UV_TARGET) {
    console.log(
      "Install uv (https://docs.astral.sh/uv) then run: uv tool install --python 3.12 pocket-tts",
    );
    process.exit(0);
  }
  console.log("Fetching uv…");
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const target = UV_TARGET;
  execSync(
    `curl -sL -o "${BIN_DIR}/uv.tar.gz" "https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.tar.gz" && tar xzf "${BIN_DIR}/uv.tar.gz" --strip-components=1 -C "${BIN_DIR}" && rm -f "${BIN_DIR}/uv.tar.gz"`,
    { stdio: "inherit", shell: "/bin/bash" },
  );
  fs.chmodSync(path.join(BIN_DIR, "uv"), 0o755);
  uvBin = path.join(BIN_DIR, "uv");
}

console.log("Installing Python 3.12 and Pocket TTS (this takes a few minutes the first time)…");
execFileSync(uvBin, ["python", "install", "3.12"], { stdio: "inherit" });
execFileSync(uvBin, ["tool", "install", "--python", "3.12", "pocket-tts"], { stdio: "inherit" });

console.log("\nPocket TTS is ready. Select it under Settings → Voice.");
console.log("The model downloads and loads on first use (about 25 seconds), then stays warm.");
