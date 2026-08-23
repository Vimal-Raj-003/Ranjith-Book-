import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * Page enhancement — spec §7 of `2026-08-23-bookreel-presentation.md`.
 *
 * An indoor phone photograph of a book page is dim, warm (tungsten light on
 * white paper reads yellow/pink), low in contrast and noisy. Dropped straight
 * into the composition it looks like a photocopy. This module grades it so it
 * reads as a printed book while staying the operator's own photograph — the
 * page shading, the curl of the spine and the thumb at the edge all survive.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────
 * Every OCR word box, line run, sweep step and camera key in this app is
 * measured in the exact pixel space of the 1600px-long-edge derivative. The
 * enhanced image REPLACES that derivative, so it must have byte-identical
 * width and height. Enhancement changes colour, never geometry: there is no
 * resize, crop, rotate, extend or trim anywhere below, the pixel loop writes
 * into the raw buffer in place, and `enhancePage` re-reads the finished file
 * and refuses to install it unless both dimensions match the input exactly.
 * A one-pixel difference would silently move every highlight in every video.
 * ─────────────────────────────────────────────────────────────────────────
 */

const GRADE = {
  /** Long edge of the image the tone analysis runs on. The grade is decided
   *  from a downscale — cheap, and averaging away sensor noise makes the
   *  percentiles steadier. Analysis resolution has no bearing on the output
   *  resolution: only the numbers it produces cross over. */
  analysisEdge: 384,

  /** Tiles across the long edge for the local paper-white field. Indoor light
   *  is never flat: one corner of the page catches a lamp, another catches
   *  bounce off a wooden table (that is the pink gradient in the operator's
   *  photographs). A single global white point cannot fix a cast that varies
   *  across the frame — worse, stretching contrast makes it MORE visible. So
   *  paper white is estimated per tile and interpolated, which flattens the
   *  illumination the way a book under even light would look. */
  grid: 16,

  /** Percentile within a tile that counts as "the paper here". Not the max:
   *  a specular glint off glossy stock would drag the whole tile dark. Not
   *  the median either — half of a dense text tile is ink. */
  paperPct: 82,

  /** The local paper estimate is clamped to this band around the page's
   *  overall paper level before use. A tile with no paper in it at all (the
   *  desk in the corner, the operator's thumb) would otherwise report its own
   *  dark level as "white" and get boosted into a bright blotch. Clamped, it
   *  simply stays dark, which is what it should be. */
  fieldMin: 0.6,
  fieldMax: 1.18,

  /** How far to go towards a perfectly flat page. 1.0 is a flatbed scan and
   *  loses the photograph; below ~0.8 the cast starts showing through again. */
  fieldStrength: 0.9,

  /** Percentile taken as the black point. Deliberately not 0: the darkest
   *  pixels in a photograph are noise and JPEG undershoot, and anchoring on
   *  them lifts nothing. Deliberately not high either — crushing the black
   *  point eats the antialiased edges of thin serif strokes and the text goes
   *  blobby. 1% is roughly "the body of the ink". */
  blackPct: 1,

  /** Where the local paper level lands on the 0..1 tone scale before the
   *  contrast curve. Below 1.0 on purpose: paper that clips to pure white has
   *  no texture left and reads as a bleached office scan. After the curve
   *  this sits around 248/255 — bright, but still paper. */
  paperTarget: 0.9,

  /** Exponent of the symmetric S-curve. Deepens the ink and brightens the
   *  paper without a hard clip at either end, so serif hairlines keep their
   *  gradient instead of snapping to black. 1.6 is as far as this can go
   *  before bold text starts to fatten. */
  contrast: 1.6,

  /** Gaussian sigma of the denoise. Phone sensors at indoor light levels are
   *  noisy, and the contrast lift below amplifies exactly that noise, so it
   *  goes first. Kept very small — this is grain removal, not smoothing; the
   *  unsharp mask afterwards puts the print's edges back. */
  denoiseSigma: 0.5,

  /** Chroma left after the grade. Photographic colour noise in the paper
   *  turns into visible mottling once contrast is lifted, so it is pulled
   *  back — but only part way. The yellow highlighter drawn over this page
   *  later must still read as yellow, and a page desaturated towards grey
   *  drags everything composited near it towards grey too. */
  saturation: 0.85,

  /** Per-channel gain applied last: the warm paper tone. The grade above
   *  neutralises the page to a clinical neutral white; a real book is ivory.
   *  Paper lands near #FFFCF0. Gains, never offsets — an offset would lift
   *  the ink into brown, a gain leaves black at black. */
  warm: [1, 0.99, 0.94] as const,

  /** Unsharp mask, AFTER the denoise. `m1` (flat areas) is held low so paper
   *  grain is not re-amplified into the noise the denoise just removed; `m2`
   *  (edges) carries the actual sharpening, which is where print lives. */
  sharpen: { sigma: 0.7, m1: 0.3, m2: 2.2 },

  /** The derivative is written at q88; re-encoding at 90 keeps this pass from
   *  compounding visible JPEG artefacts on top of the ones already there. */
  quality: 90,
} as const;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function percentile(hist: Uint32Array, count: number, pct: number): number {
  const target = (count * pct) / 100;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= target) return v;
  }
  return 255;
}

interface Analysis {
  /** Per channel, a `gx * gy` grid of local paper-white levels in 0..255. */
  field: Float64Array[];
  /** Per channel, the global black point in 0..255. */
  black: number[];
  gx: number;
  gy: number;
}

/**
 * Decide the grade from a downscaled copy: a per-channel black point for the
 * whole page, and a per-channel grid of local paper-white levels.
 *
 * Estimating white per channel is what neutralises the cast — paper is known
 * to be white, so whatever the blue channel reads on paper under a tungsten
 * bulb IS the illuminant, and normalising each channel to its own paper level
 * divides the light back out.
 */
function analyse(data: Buffer, width: number, height: number, channels: number): Analysis {
  const long = GRADE.grid;
  const gx = width >= height ? long : Math.max(2, Math.round((long * width) / height));
  const gy = height >= width ? long : Math.max(2, Math.round((long * height) / width));

  const field: Float64Array[] = [];
  const globalHist: Uint32Array[] = [];
  for (let c = 0; c < channels; c++) {
    field.push(new Float64Array(gx * gy));
    globalHist.push(new Uint32Array(256));
  }

  const tileHist: Uint32Array[] = [];
  for (let c = 0; c < channels; c++) tileHist.push(new Uint32Array(256));

  for (let ty = 0; ty < gy; ty++) {
    const y0 = Math.floor((ty * height) / gy);
    const y1 = Math.floor(((ty + 1) * height) / gy);
    for (let tx = 0; tx < gx; tx++) {
      const x0 = Math.floor((tx * width) / gx);
      const x1 = Math.floor(((tx + 1) * width) / gx);
      for (let c = 0; c < channels; c++) tileHist[c].fill(0);

      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * channels;
          for (let c = 0; c < channels; c++) {
            const v = data[i + c];
            tileHist[c][v]++;
            globalHist[c][v]++;
          }
          n++;
        }
      }
      if (n === 0) continue;
      for (let c = 0; c < channels; c++) {
        field[c][ty * gx + tx] = percentile(tileHist[c], n, GRADE.paperPct);
      }
    }
  }

  const total = width * height;
  const black: number[] = [];
  const smoothed: Float64Array[] = [];

  for (let c = 0; c < channels; c++) {
    black.push(percentile(globalHist[c], total, GRADE.blackPct));

    // The page's overall paper level: the 60th percentile of the tiles, not
    // the mean. Tiles that hold no paper (thumb, desk, the dark gutter) are
    // outliers and a mean would let them drag the reference down.
    const sorted = Array.from(field[c]).sort((a, b) => a - b);
    const paper = sorted[Math.floor(sorted.length * 0.6)] || 1;

    // 3x3 box smooth, then clamp, then ease towards the page-wide level.
    // Smoothing first is what stops the tile grid printing itself onto the
    // image as faint 16-square banding.
    const out = new Float64Array(gx * gy);
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        let sum = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= gy || xx >= gx) continue;
            sum += field[c][yy * gx + xx];
            k++;
          }
        }
        const local = clamp(sum / k, paper * GRADE.fieldMin, paper * GRADE.fieldMax);
        out[y * gx + x] = paper + GRADE.fieldStrength * (local - paper);
      }
    }
    smoothed.push(out);
  }

  return { field: smoothed, black, gx, gy };
}

/** The contrast S-curve, sampled once into a table instead of calling `pow`
 *  five million times. Symmetric about 0.5 and flat at both ends, so nothing
 *  clips: ink deepens, paper brightens, and the antialiased pixels between
 *  them stay a gradient. */
function contrastCurve(): Float64Array {
  const steps = 1024;
  const lut = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    lut[i] =
      t < 0.5 ? 0.5 * Math.pow(2 * t, GRADE.contrast) : 1 - 0.5 * Math.pow(2 * (1 - t), GRADE.contrast);
  }
  return lut;
}

/**
 * Grade one page image. Returns `true` when `output` now holds the enhanced
 * image, `false` when it does not — and `false` means the caller's existing
 * file is untouched and must be used as-is.
 *
 * **Best-effort by contract: this never throws.** A page that cannot be graded
 * is a page that ships ungraded, never an upload that fails. Nothing is ever
 * half-written either: the grade goes to a temp file beside `output` and is
 * renamed over it only after its dimensions have been read back and confirmed
 * identical to the input's. `input` and `output` may be the same path.
 */
export async function enhancePage(input: string, output: string): Promise<boolean> {
  const tmp = `${output}.enhance-${process.pid}-${Date.now()}.tmp`;
  try {
    const decode = () => sharp(input, { failOn: "none" }).removeAlpha().toColourspace("srgb");

    const source = await decode().metadata();
    if (!source.width || !source.height) return false;

    const small = await decode()
      .resize({ width: GRADE.analysisEdge, height: GRADE.analysisEdge, fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const stats = analyse(small.data, small.info.width, small.info.height, small.info.channels);

    // Denoise first, then read the pixels out. `blur` is a convolution: it
    // cannot change the raster's dimensions, and `info` below carries the
    // real ones straight back into the encode, so the round trip through raw
    // pixels is dimension-preserving by construction.
    const { data, info } = await decode().blur(GRADE.denoiseSigma).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (width !== source.width || height !== source.height) return false;

    const curve = contrastCurve();
    const px = new Float64Array(channels);

    for (let y = 0; y < height; y++) {
      // Bilinear position in the paper-white grid. Sampling the field
      // smoothly is what keeps the correction invisible; a nearest-tile
      // lookup would show as a patchwork.
      const fy = clamp(((y + 0.5) * stats.gy) / height - 0.5, 0, stats.gy - 1);
      const gy0 = Math.floor(fy);
      const gy1 = Math.min(gy0 + 1, stats.gy - 1);
      const wy = fy - gy0;

      for (let x = 0; x < width; x++) {
        const fx = clamp(((x + 0.5) * stats.gx) / width - 0.5, 0, stats.gx - 1);
        const gx0 = Math.floor(fx);
        const gx1 = Math.min(gx0 + 1, stats.gx - 1);
        const wx = fx - gx0;
        const i = (y * width + x) * channels;

        let luma = 0;
        for (let c = 0; c < channels; c++) {
          const f = stats.field[c];
          const paper =
            (f[gy0 * stats.gx + gx0] * (1 - wx) + f[gy0 * stats.gx + gx1] * wx) * (1 - wy) +
            (f[gy1 * stats.gx + gx0] * (1 - wx) + f[gy1 * stats.gx + gx1] * wx) * wy;

          const black = stats.black[c];
          // A degenerate page (a photograph of a black table, a blown-out
          // scan) can put paper at or under black. Floor the span so the
          // division can never explode or invert the image.
          const white = Math.max(paper, black + 24);

          const t = clamp((data[i + c] - black) / (white - black), 0, 1);
          const graded = curve[Math.round(t * 1024)];
          px[c] = graded;
          luma += graded * (channels === 3 ? (c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114) : 1);
        }

        for (let c = 0; c < channels; c++) {
          // Desaturate towards this pixel's own luma, then warm. In that
          // order: warming first and desaturating second would pull the ivory
          // straight back out again.
          const desaturated = luma + GRADE.saturation * (px[c] - luma);
          const warm = channels === 3 ? GRADE.warm[c] : 1;
          data[i + c] = clamp(Math.round(255 * desaturated * warm), 0, 255);
        }
      }
    }

    await fs.mkdir(path.dirname(output), { recursive: true });
    const written = await sharp(data, { raw: { width, height, channels } })
      .sharpen(GRADE.sharpen)
      .jpeg({ quality: GRADE.quality, mozjpeg: true })
      .toFile(tmp);

    // The invariant, enforced rather than assumed. Everything above is a
    // per-pixel colour operation, so this can only fail if someone later adds
    // a geometric step — in which case the grade is dropped on the floor and
    // the untouched derivative ships, instead of every highlight in every
    // video quietly moving.
    if (written.width !== source.width || written.height !== source.height) {
      await fs.rm(tmp, { force: true });
      return false;
    }

    await fs.rename(tmp, output);
    return true;
  } catch {
    // Deliberately swallowed: enhancement is cosmetic and the upload is not.
    // The temp file goes with it — a half-written grade must never be left
    // where a later run could mistake it for a finished one.
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
