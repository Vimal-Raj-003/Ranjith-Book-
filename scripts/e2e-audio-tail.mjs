// Audio-tail harness (spec §10, "A known gap fixed rather than inherited").
//
// The composition's DECLARED duration and the voice track's ACTUAL duration
// are not the same number — see AUDIO_OFFSET/OUTRO_TAIL in
// `src/lib/video/composition/build.ts`. Nothing about muxing a video
// guarantees the audio stream stays non-silent all the way to the end the
// video plays for: a track can validly run the full length of the file while
// carrying nothing in its last seconds. That is exactly the shape of the bug
// this harness exists to catch — it reached a real render undetected because
// every other check in this repo (unit tests, seek-safety, highlight
// accuracy) drives timing/geometry directly and never once measures decoded
// audio.
//
// Deliberately not a framework: one measurement, one threshold, one process
// exit code. `ffmpeg -af volumedetect` is the same tool this repo already
// uses for the same purpose (`meanLevelDb` in `src/lib/media/ffmpeg.ts`) —
// this script does not import that module, so it keeps working even if the
// mastering pipeline changes shape entirely.
//
// `tools/bin/ffprobe` is not guaranteed to exist (it is fetched by
// `npm run setup`, not committed) — duration is read from ffmpeg's own
// stderr banner instead of shelling out to ffprobe at all.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

/** Final window measured, in seconds. Matches the manual reproduction this harness formalizes. */
const TAIL_WINDOW = 1.2;
/** Digital silence reads as -91 dB; anything this quiet is unmistakably dead air, not just a quiet mix. */
const SILENCE_FLOOR_DB = -60;

function resolveFfmpeg() {
  const local = path.join(process.cwd(), "tools", "bin", "ffmpeg");
  if (fs.existsSync(local)) return local;
  return process.env.FFMPEG_PATH || "ffmpeg";
}

const FFMPEG = resolveFfmpeg();

async function run(args) {
  try {
    const { stdout, stderr } = await exec(FFMPEG, ["-hide_banner", ...args], {
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout + stderr;
  } catch (err) {
    // ffmpeg's `-f null -` run exits non-zero on plenty of harmless input
    // shapes; the text on stderr is what this script actually reads, not the
    // exit code, so a thrown error's own stdout/stderr is just as usable.
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}

/** Total duration of `file`, parsed from ffmpeg's own banner — no ffprobe dependency. */
async function durationOf(file) {
  const text = await run(["-i", file, "-f", "null", "-"]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) throw new Error(`could not read duration of ${file} — ffmpeg output:\n${text.slice(0, 500)}`);
  const [, h, min, s] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s);
}

/** Mean volume, in dB, of `file` from `start` for `len` seconds. */
async function meanVolumeDb(file, start, len) {
  const text = await run(["-ss", String(Math.max(0, start)), "-t", String(len), "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(text);
  if (!m) throw new Error(`could not measure volume of ${file} — ffmpeg output:\n${text.slice(0, 500)}`);
  return Number(m[1]);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: e2e-audio-tail.mjs <path-to-mp4>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`e2e:audio-tail: no such file — ${file}`);
    process.exit(1);
  }

  const duration = await durationOf(file);
  const windowStart = Math.max(0, duration - TAIL_WINDOW);
  const meanDb = await meanVolumeDb(file, windowStart, Math.min(TAIL_WINDOW, duration));

  console.log(
    `e2e:audio-tail: ${file} — duration ${duration.toFixed(2)}s, final ${TAIL_WINDOW}s mean volume ${meanDb.toFixed(1)} dB`,
  );

  if (meanDb < SILENCE_FLOOR_DB) {
    console.error(
      `e2e:audio-tail FAILED: the final ${TAIL_WINDOW}s of ${file} measure ${meanDb.toFixed(1)} dB — ` +
        `at or below the ${SILENCE_FLOOR_DB} dB digital-silence floor. The audio track runs the full ` +
        `length of the file but carries nothing at the end (the CTA card is playing in silence).`,
    );
    process.exit(1);
  }

  console.log("e2e:audio-tail: OK — audio is present through the final second.");
}

main().catch((err) => {
  console.error(`e2e:audio-tail: ${err.message ?? err}`);
  process.exit(1);
});
