import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

/**
 * Kyutai Pocket TTS — a 100M-parameter neural voice that runs on CPU.
 * https://github.com/kyutai-labs/pocket-tts
 *
 * The model takes ~25s to load, so the server is started once and kept warm;
 * every beat after that is a plain HTTP POST.
 */

export interface PocketVoice {
  id: string;
  label: string;
  gender: "female" | "male";
  note: string;
}

/** Curated English voices from the Pocket TTS catalog, labelled by gender. */
export const POCKET_VOICES: PocketVoice[] = [
  { id: "alba", label: "Alba", gender: "female", note: "warm, casual" },
  { id: "cosette", label: "Cosette", gender: "female", note: "expressive, animated" },
  { id: "vera", label: "Vera", gender: "female", note: "clear, even-paced" },
  { id: "jane", label: "Jane", gender: "female", note: "bright, friendly" },
  { id: "eve", label: "Eve", gender: "female", note: "calm, measured" },
  { id: "caro_davy", label: "Caro", gender: "female", note: "conversational" },
  { id: "michael", label: "Michael", gender: "male", note: "steady, documentary" },
  { id: "charles", label: "Charles", gender: "male", note: "deep, deliberate — the default" },
  { id: "paul", label: "Paul", gender: "male", note: "natural, everyday" },
  { id: "george", label: "George", gender: "male", note: "crisp, energetic" },
  { id: "stuart_bell", label: "Stuart", gender: "male", note: "narrator tone" },
  { id: "peter_yearsley", label: "Peter", gender: "male", note: "mature, warm" },
];

// BookReel content targets motivation and business audiences, and the operator
// asked for a bold, projecting read rather than the warm/casual default —
// Charles ("deep, deliberate") fits that brief better than Alba does.
export const DEFAULT_POCKET_VOICE = "charles";

const PORT = Number(process.env.POCKET_TTS_PORT || 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 5 * 60_000;

function candidateBins(): string[] {
  const bins = [];
  if (process.env.POCKET_TTS_BIN) bins.push(process.env.POCKET_TTS_BIN);
  const home = path.join(os.homedir(), ".local", "bin", "pocket-tts");
  // uv installs a .exe on Windows and an extensionless binary elsewhere.
  if (process.platform === "win32") bins.push(`${home}.exe`);
  bins.push(home);
  bins.push("pocket-tts");
  return bins;
}

async function resolveBin(): Promise<string | null> {
  for (const bin of candidateBins()) {
    try {
      // path.join yields backslashes on Windows, so a "/" test would misread
      // an absolute path as a bare command name and hand it to the PATH lookup.
      if (bin.includes(path.sep) || bin.includes("/")) {
        await fs.access(bin);
        return bin;
      }
      await exec(process.platform === "win32" ? "where" : "which", [bin], {
        windowsHide: true,
      });
      return bin;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

let booting: Promise<void> | null = null;

/** Start the server if it is not already answering, and wait until it is. */
async function ensureServer(): Promise<void> {
  if (await isUp()) return;
  if (booting) return booting;

  booting = (async () => {
    const bin = await resolveBin();
    if (!bin) {
      throw new Error(
        "Pocket TTS is not installed. Run `npm run setup:voice`, or pick a different voice engine in Settings.",
      );
    }

    const child = spawn(bin, ["serve", "--port", String(PORT)], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      // This one is long-lived and detached: without this its console window
      // does not flash, it sits on the desktop for the rest of the session.
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await isUp()) return;
    }
    throw new Error("Pocket TTS did not start in time. Check that `pocket-tts serve` runs manually.");
  })().finally(() => {
    booting = null;
  });

  return booting;
}

export async function pocketTtsStatus(): Promise<{
  installed: boolean;
  running: boolean;
  bin: string | null;
}> {
  const bin = await resolveBin();
  return { installed: !!bin, running: await isUp(), bin };
}

/**
 * Synthesize one line. `voice` is a catalog name, or a path/URL to a sample for
 * voice cloning, which Pocket TTS supports natively.
 */
export async function synthPocket(text: string, out: string, voice: string): Promise<void> {
  await ensureServer();

  const form = new FormData();
  form.set("text", text);
  form.set("voice_url", voice || DEFAULT_POCKET_VOICE);

  const res = await fetch(`${BASE}/tts`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(4 * 60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Pocket TTS returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1024) throw new Error("Pocket TTS returned no audio");
  await fs.writeFile(out, audio);
}
