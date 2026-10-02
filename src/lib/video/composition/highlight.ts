import { PAGE_KINDS, SHOT_SCALE, type Scene } from "../scenes/types";

/** A tween's start time and duration, in composition seconds. */
export interface Keyed {
  t: number;
  d: number;
}

/**
 * How far the card is magnified, per page scene: the scene's shot size.
 *
 * A zoom scales the card's CONTENT rather than repositioning it, because the
 * camera has already parked the words being spoken at the card's vertical
 * centre (`cameraTrack`'s MIDDLE). Scaling about that centre therefore closes
 * in on exactly those words, and cannot fight the camera the way an absolute
 * pan would.
 *
 * The shot size was chosen upstream (`assignShots`) so the cited block fits, so
 * this function computes no scale of its own. `cardHeightInColumnPx` stays in the
 * signature so callers did not have to change.
 *
 * Caution, measured on real renders before shot sizes existed: a printed line
 * runs the full width of the page, and the zoom is about the card's centre, so
 * at 1.8x every line was cut mid-word at both edges. `assignShots` only checks
 * block HEIGHT; at medium (1.5x) and close (2.2x) a full-width block is
 * cropped horizontally even when it fits vertically.
 *
 * Each entry's duration is clipped so it ends before the next begins: one tween
 * per property per element, never overlapping.
 */
export function cardZooms(scenes: Scene[], shift: number, cardHeightInColumnPx: number): (Keyed & { v: number })[] {
  void cardHeightInColumnPx;
  const out: (Keyed & { v: number })[] = [];
  let current = 1;
  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    const target = SHOT_SCALE[s.shot ?? "wide"];
    if (Math.abs(target - current) < 0.02) continue;
    const t = Math.max(0, shift + s.start);
    const d = Math.min(1.4, Math.max(0.5, (s.end - s.start) * 0.35));
    const previous = out[out.length - 1];
    if (previous && previous.t + previous.d > t) previous.d = Math.max(0.05, t - previous.t);
    out.push({ t, d, v: Math.round(target * 1000) / 1000 });
    current = target;
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
