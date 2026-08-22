#!/usr/bin/env node
/**
 * Puts ffmpeg + ffprobe in tools/bin so rendering works without a system install.
 * Already-present binaries (system or previously fetched) are left alone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN_DIR = path.join(process.cwd(), "tools", "bin");

function onPath(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function alreadyLocal(name) {
  return fs.existsSync(path.join(BIN_DIR, name));
}

const missing = ["ffmpeg", "ffprobe"].filter((b) => !alreadyLocal(b) && !onPath(b));
if (missing.length === 0) {
  console.log("ffmpeg and ffprobe are available.");
  process.exit(0);
}

fs.mkdirSync(BIN_DIR, { recursive: true });

if (os.platform() === "darwin") {
  for (const name of missing) {
    const zip = path.join(BIN_DIR, `${name}.zip`);
    console.log(`Downloading ${name}…`);
    execFileSync("curl", ["-sL", "-o", zip, `https://evermeet.cx/ffmpeg/getrelease/${name}/zip`]);
    execFileSync("unzip", ["-o", "-q", zip, "-d", BIN_DIR]);
    fs.rmSync(zip, { force: true });
    fs.chmodSync(path.join(BIN_DIR, name), 0o755);
    try {
      execFileSync("xattr", ["-d", "com.apple.quarantine", path.join(BIN_DIR, name)], { stdio: "ignore" });
    } catch {
      /* attribute absent — nothing to clear */
    }
  }
} else if (os.platform() === "linux") {
  // John Van Sickle's static builds: one tarball carries both binaries and
  // needs no system libraries, which keeps the server free of an apt ffmpeg.
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  const tar = path.join(BIN_DIR, "ffmpeg.tar.xz");
  const work = path.join(BIN_DIR, "ffmpeg-extract");
  console.log(`Downloading static ffmpeg (${arch})…`);
  execFileSync("curl", [
    "-sL", "-o", tar,
    `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch}-static.tar.xz`,
  ]);
  fs.mkdirSync(work, { recursive: true });
  execFileSync("tar", ["xJf", tar, "--strip-components=1", "-C", work]);
  for (const name of ["ffmpeg", "ffprobe"]) {
    fs.copyFileSync(path.join(work, name), path.join(BIN_DIR, name));
    fs.chmodSync(path.join(BIN_DIR, name), 0o755);
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(tar, { force: true });
} else {
  console.log(
    `Missing: ${missing.join(", ")}. Install ffmpeg for your platform, or set FFMPEG_PATH and FFPROBE_PATH.`,
  );
  process.exit(0);
}

console.log("ffmpeg and ffprobe are ready in tools/bin.");
