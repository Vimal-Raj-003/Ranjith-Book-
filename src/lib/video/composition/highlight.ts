import { PAGE_KINDS, SHOT_SCALE, type Scene, type ShotSize } from "../scenes/types";

/** A tween's start time and duration, in composition seconds. */
export interface Keyed {
  t: number;
  d: number;
}

export interface CardZoomOptions {
  columnWidth?: number;
  columnHeight?: number;
  strokes?: { x: number; y: number; w: number; h: number; start: number; end: number }[];
  camera?: { t: number; y: number }[];
  guardStrokeWidth?: boolean;
  enablePan?: boolean;
}

const CARD_W_PX = 960;
const CARD_H_PX = 1120;
const DRIFT_HEADROOM = 1.03;

function cameraYAt(camera: { t: number; y: number }[], t: number): number {
  if (camera.length === 0) return 0;
  if (t <= camera[0].t) return camera[0].y;
  for (let i = 0; i < camera.length - 1; i++) {
    const a = camera[i];
    const b = camera[i + 1];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-6) return b.y;
      return a.y + ((t - a.t) / span) * (b.y - a.y);
    }
  }
  return camera[camera.length - 1].y;
}

/**
 * How far the card is magnified, per page scene: the scene's shot size, plus
 * optional horizontal/vertical centering pan so zoomed single-column passages
 * never clip at the card edges.
 *
 * Each entry's duration is clipped so it ends before the next begins: one tween
 * per property per element, never overlapping.
 */
export function cardZooms(
  scenes: Scene[],
  shift: number,
  cardHeightInColumnPx: number,
  opts?: CardZoomOptions,
): (Keyed & { v: number; x?: number; y?: number })[] {
  const out: (Keyed & { v: number; x?: number; y?: number })[] = [];
  const colW = opts?.columnWidth ?? 0;
  const colH = opts?.columnHeight ?? 0;
  let current = 1;
  let currentX = 0;
  let currentY = 0;

  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    const winStart = shift + s.start;
    const winEnd = shift + s.end;

    let bx0 = 0;
    let bx1 = 0;
    let by0 = 0;
    let by1 = 0;
    let hasBounds = false;

    if (opts?.strokes && opts.strokes.length > 0) {
      const active = opts.strokes.filter((st) => st.end > winStart - 0.05 && st.start < winEnd + 0.05);
      if (active.length > 0) {
        bx0 = Math.min(...active.map((st) => st.x));
        bx1 = Math.max(...active.map((st) => st.x + st.w));
        by0 = Math.min(...active.map((st) => st.y));
        by1 = Math.max(...active.map((st) => st.y + st.h));
        hasBounds = bx1 > bx0;
      }
    }
    if (!hasBounds && s.crop) {
      bx0 = s.crop.x0;
      bx1 = s.crop.x1;
      by0 = s.crop.y0;
      by1 = s.crop.y1;
      hasBounds = bx1 > bx0;
    }

    let shot: ShotSize = s.shot ?? "wide";
    if (opts?.guardStrokeWidth && colW > 0 && hasBounds) {
      const order: ShotSize[] = ["close", "medium", "wide"];
      let picked: ShotSize = "wide";
      for (const cand of order.slice(order.indexOf(shot))) {
        const sc = SHOT_SCALE[cand];
        const fitsHoriz = cand === "wide" || (bx1 - bx0) * 1.12 * DRIFT_HEADROOM <= colW / sc;
        const fitsVert =
          cand === "wide" ||
          cardHeightInColumnPx <= 0 ||
          (by1 - by0) * 1.08 * DRIFT_HEADROOM <= cardHeightInColumnPx / sc;
        if (fitsHoriz && fitsVert) {
          picked = cand;
          break;
        }
      }
      shot = picked;
    }

    const target = SHOT_SCALE[shot];
    let panX = 0;
    let panY = 0;
    if (opts?.enablePan && target > 1 && colW > 0 && hasBounds) {
      const scale0 = CARD_W_PX / colW;
      const cxMid = ((bx0 + bx1) / 2) * scale0;
      const maxPanX = (CARD_W_PX / 2) * (target - 1);
      panX = Math.max(-maxPanX, Math.min(maxPanX, (CARD_W_PX / 2 - cxMid) * target));
      if (Math.abs(panX) < 3) panX = 0;

      if (opts.camera && opts.camera.length > 0 && colH > 0 && by1 > by0) {
        const camY = cameraYAt(opts.camera, (winStart + winEnd) / 2);
        const cyMid = ((by0 + by1) / 2 - camY) * scale0;
        const topCard = -camY * scale0;
        const botCard = (colH - camY) * scale0;
        const maxPanY = Math.max(0, (CARD_H_PX / 2 - topCard) * target - CARD_H_PX / 2);
        const minPanY =
          botCard >= CARD_H_PX ? Math.min(0, CARD_H_PX / 2 - (botCard - CARD_H_PX / 2) * target) : 0;
        panY = Math.max(minPanY, Math.min(maxPanY, (CARD_H_PX / 2 - cyMid) * target));
        if (Math.abs(panY) < 3) panY = 0;
      }
    }

    if (
      Math.abs(target - current) < 0.02 &&
      Math.abs(panX - currentX) < 4 &&
      Math.abs(panY - currentY) < 4
    ) {
      continue;
    }
    const t = Math.max(0, winStart);
    const d = Math.min(1.4, Math.max(0.5, (s.end - s.start) * 0.35));
    const previous = out[out.length - 1];
    if (previous && previous.t + previous.d > t) previous.d = Math.max(0.05, t - previous.t);
    const roundedX = Math.round(panX * 10) / 10;
    const roundedY = Math.round(panY * 10) / 10;
    out.push({
      t,
      d,
      v: Math.round(target * 1000) / 1000,
      ...(roundedX !== 0 ? { x: roundedX } : {}),
      ...(roundedY !== 0 ? { y: roundedY } : {}),
    });
    current = target;
    currentX = panX;
    currentY = panY;
  }
  return out;
}

/**
 * The page outside the cited lines, dimmed so the eye has one place to go.
 *
 * One element inside `#column`, in the same coordinate space as the strokes, so
 * it scrolls and scales with the page for free. The hole is a transparent band
 * over the cited lines and the dimming is a large `box-shadow` spread in the
 * backdrop colour — one element, one tween, no clip-path and no second copy of
 * the page.
 *
 * A page scene that does not dim (a wide shot, or no cited span to frame) while
 * the layer is still up emits a key back to `o: 0`, keeping the previous window
 * so it fades in place instead of jumping. Without it the last scene's surround
 * would stay dimmed over the whole page for the rest of the video.
 */
export function dimKeys(scenes: Scene[], shift: number): (Keyed & { o: number; y: number; h: number })[] {
  const out: (Keyed & { o: number; y: number; h: number })[] = [];
  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    // A wide establishing shot shows the whole page; dimming it would be noise.
    const wanted = s.shot === "close" ? 0.62 : s.shot === "medium" ? 0.34 : 0;
    const crop = s.crop;
    const dims = wanted > 0 && !!crop;
    const previous = out[out.length - 1];
    if (!dims && (!previous || previous.o === 0)) continue;
    const t = Math.max(0, shift + s.start);
    const d = Math.min(1.2, Math.max(0.4, (s.end - s.start) * 0.3));
    if (previous && previous.t + previous.d > t) previous.d = Math.max(0.05, t - previous.t);
    if (dims && crop) {
      out.push({ t, d, o: wanted, y: Math.round(crop.y0), h: Math.round(Math.max(1, crop.y1 - crop.y0)) });
    } else if (previous) {
      out.push({ t, d, o: 0, y: previous.y, h: previous.h });
    }
  }
  return out;
}
