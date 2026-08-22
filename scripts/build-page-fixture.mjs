// One-off generator for tests/fixtures/page-fixture.png + page-fixture.json,
// consumed by scripts/e2e-highlight.mjs.
//
// Renders a synthetic "page" from an SVG containing 12 words in a grid WE
// lay out (known slot positions, generous non-overlapping cells — never
// relying on guessed font metrics to know where a word's ink will land).
//
// The ground-truth box for each word is then found by scanning the RENDERED
// PIXELS inside that word's own cell for the tight bounding box of ink
// (anything darker than a fixed threshold against the flat background) —
// not by running the OCR engine the harness is testing. This is a different,
// much simpler technique (pixel thresholding, no text recognition) than
// tesseract's, so the ground truth is independent of the thing being
// measured: the assertion "the stroke covers >=90% of the target box" would
// be circular if the target box itself came from the same OCR call the
// alignment step consumes.
//
// This is a build script, run once; its output (the PNG and JSON) is
// committed so the harness itself does no SVG rendering or pixel scanning.
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "tests", "fixtures");

const WIDTH = 1600;
const HEIGHT = 2000;
const FONT_SIZE = 70;
const MARGIN = 80;
const COLS = 3;
const SLOT_WIDTH = (WIDTH - 2 * MARGIN) / COLS; // 480
const BASELINES = [300, 650, 1000, 1350]; // four lines, generously spaced
const INK_THRESHOLD = 180; // greyscale value below which a pixel counts as ink
const CELL_ABOVE = 110; // scan window above/below baseline — generous, never
const CELL_BELOW = 50; // touches a neighbouring line's own window

const WORDS = [
  ["the", "quick", "brown"],
  ["fox", "jumps", "over"],
  ["lazy", "dogs", "while"],
  ["reading", "every", "page"],
];

function cellFor(lineIdx, colIdx) {
  const x0 = MARGIN + colIdx * SLOT_WIDTH;
  const baseline = BASELINES[lineIdx];
  return { x0, y0: baseline - CELL_ABOVE, x1: x0 + SLOT_WIDTH, y1: baseline + CELL_BELOW };
}

function svgFor() {
  const texts = [];
  WORDS.forEach((line, lineIdx) => {
    line.forEach((word, colIdx) => {
      const cell = cellFor(lineIdx, colIdx);
      const x = cell.x0 + 24; // left-aligned within the slot, with padding
      texts.push(
        `<text x="${x}" y="${BASELINES[lineIdx]}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${FONT_SIZE}" fill="#101010">${word}</text>`,
      );
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#f7f3e8" />
  ${texts.join("\n  ")}
</svg>`;
}

/** Tight ink bounding box inside `cell`, scanning a raw greyscale buffer. */
function inkBoxIn(raw, width, cell) {
  const x0 = Math.max(0, Math.floor(cell.x0));
  const x1 = Math.min(width, Math.ceil(cell.x1));
  const y0 = Math.max(0, Math.floor(cell.y0));
  const y1 = Math.min(Math.floor(raw.length / width), Math.ceil(cell.y1));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (raw[y * width + x] < INK_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX === Infinity) return null; // no ink found in this cell — a real problem, not silently ignored
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

async function main() {
  const svg = svgFor();
  const pngPath = path.join(OUT_DIR, "page-fixture.png");
  const jsonPath = path.join(OUT_DIR, "page-fixture.json");

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(pngPath, pngBuffer);

  const { data: raw, info } = await sharp(pngBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    throw new Error(`rendered page is ${info.width}x${info.height}, expected ${WIDTH}x${HEIGHT}`);
  }

  const words = [];
  const boxes = [];
  WORDS.forEach((line, lineIdx) => {
    line.forEach((word, colIdx) => {
      const cell = cellFor(lineIdx, colIdx);
      const box = inkBoxIn(raw, info.width, cell);
      if (!box) throw new Error(`no ink found for "${word}" in its cell — rendering or layout is broken`);
      words.push(word);
      boxes.push(box);
    });
  });

  await writeFile(jsonPath, JSON.stringify({ width: WIDTH, height: HEIGHT, words, boxes }, null, 2) + "\n");

  console.log(`Wrote ${pngPath}`);
  console.log(`Wrote ${jsonPath}`);
}

await main();
