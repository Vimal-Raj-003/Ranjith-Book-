import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentSignal } from "../cancel";

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
  // 10 Gemini 3.8 Studio Female Voices (F01 – F10)
  { id: "kore", label: "Kore (F01)", gender: "female", note: "sharp magnetic authority · Gemini Studio US" },
  { id: "sulafat", label: "Sulafat (F02)", gender: "female", note: "warm velvety storyteller · Gemini Studio US" },
  { id: "aoede", label: "Aoede (F03)", gender: "female", note: "natural modern creator · Gemini Studio US" },
  { id: "zephyr", label: "Zephyr (F04)", gender: "female", note: "bright high-retention Reels · Gemini Studio US" },
  { id: "despina", label: "Despina (F05)", gender: "female", note: "smooth luxury editorial · Gemini Studio US" },
  { id: "laomedeia", label: "Laomedeia (F06)", gender: "female", note: "upbeat vibrant creator · Gemini Studio US" },
  { id: "leda", label: "Leda (F07)", gender: "female", note: "youthful crisp energy · Gemini Studio US" },
  { id: "achernar", label: "Achernar (F08)", gender: "female", note: "calm soothing reflection · Gemini Studio US" },
  { id: "clara_uk", label: "Clara (F09)", gender: "female", note: "polished British podcast · Gemini Studio UK" },
  { id: "ananya_in", label: "Ananya (F10)", gender: "female", note: "velvety Indian-English · Gemini Studio IN" },
  // 6 Classic Studio Female Voices
  { id: "alba", label: "Alba", gender: "female", note: "magnetic viral creator (US)" },
  { id: "cosette", label: "Cosette", gender: "female", note: "bright, upbeat Reels (US)" },
  { id: "vera", label: "Vera", gender: "female", note: "sharp, confident clarity (US)" },
  { id: "jane", label: "Jane", gender: "female", note: "warm podcast host (US)" },
  { id: "eve", label: "Eve", gender: "female", note: "polished British studio (UK)" },
  { id: "caro_davy", label: "Caro", gender: "female", note: "expressive Indian-English (IN)" },
  // 10 Gemini 3.8 Studio Male Voices (M01 – M10)
  { id: "algenib", label: "Algenib (M01)", gender: "male", note: "deep gravelly cinema · Gemini Studio US" },
  { id: "puck", label: "Puck (M02)", gender: "male", note: "charismatic podcast creator · Gemini Studio US" },
  { id: "fenrir", label: "Fenrir (M03)", gender: "male", note: "high-energy viral motivator · Gemini Studio US" },
  { id: "enceladus", label: "Enceladus (M04)", gender: "male", note: "intimate late-night narrator · Gemini Studio US" },
  { id: "charon", label: "Charon (M05)", gender: "male", note: "steady documentary authority · Gemini Studio US" },
  { id: "sadachbia", label: "Sadachbia (M06)", gender: "male", note: "lively dynamic host · Gemini Studio US" },
  { id: "algieba", label: "Algieba (M07)", gender: "male", note: "smooth velvety advisor · Gemini Studio US" },
  { id: "achird", label: "Achird (M08)", gender: "male", note: "warm friendly creator · Gemini Studio US" },
  { id: "arthur_uk", label: "Arthur (M09)", gender: "male", note: "deep British documentary · Gemini Studio UK" },
  { id: "vikram_in", label: "Vikram (M10)", gender: "male", note: "confident Indian-English podcast · Gemini Studio IN" },
  // 6 Classic Studio Male Voices
  { id: "michael", label: "Michael", gender: "male", note: "smooth creator podcast (US)" },
  { id: "charles", label: "Charles", gender: "male", note: "deep viral storyteller (US) — default" },
  { id: "paul", label: "Paul", gender: "male", note: "bold cinema baritone (US)" },
  { id: "george", label: "George", gender: "male", note: "high-energy motivator (US)" },
  { id: "stuart_bell", label: "Stuart", gender: "male", note: "crisp British narrator (UK)" },
  { id: "peter_yearsley", label: "Peter", gender: "male", note: "clear Indian-English studio (IN)" },
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

  // The server itself is shared and long-lived (`ensureServer` above never
  // tears it down) — cancelling one episode must only abort ITS request, not
  // touch the server other episodes' beats are also using it through.
  const ambient = currentSignal();
  const res = await fetch(`${BASE}/tts`, {
    method: "POST",
    body: form,
    signal: ambient ? AbortSignal.any([ambient, AbortSignal.timeout(4 * 60_000)]) : AbortSignal.timeout(4 * 60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Pocket TTS returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1024) throw new Error("Pocket TTS returned no audio");
  await fs.writeFile(out, audio);
}
