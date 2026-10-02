/**
 * The frame's layout, in one place.
 *
 * Before this module every absolutely positioned element in `build.ts` carried
 * its own hardcoded `y` — `BYLINE_Y = 1388`, `CUE_TOP = 1450`,
 * `CAPTION_BASELINE = 1720` — and nothing compared them against each other, or
 * against the full-frame cinematic heroes, or against the chrome the publishing
 * platforms draw over the video. A collision was therefore invisible until
 * somebody watched a render, and one shipped: the bottom of every caption sat
 * under Instagram's own caption row.
 *
 * Elements now ask this module where they go, and `gridViolations` is called by
 * both a unit test and a live-browser test, so a collision fails a test instead.
 */

export const FRAME = { width: 1080, height: 1920 } as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Band {
  top: number;
  bottom: number;
  x: number;
  w: number;
}

export type BandName = "progress" | "title" | "stage" | "caption";

/**
 * How wide anything carrying text may be.
 *
 * 820 rather than the full frame so that a centred element ends at x=950,
 * exactly where both platforms' button rail begins. The captions were 920 wide,
 * which put their last 35px under it.
 */
export const CONTENT_WIDTH = 820;
export const CONTENT_X = (FRAME.width - CONTENT_WIDTH) / 2;

export const BANDS: Record<BandName, Band> = {
  /** The progress bar, hard against the top edge. */
  progress: { top: 0, bottom: 8, x: 0, w: FRAME.width },
  /** The persistent byline. Above the card, out of every scene's way. */
  title: { top: 60, bottom: 150, x: CONTENT_X, w: CONTENT_WIDTH },
  /** The page card, the cinematic heroes, and all scene type. */
  stage: { top: 200, bottom: 1370, x: 0, w: FRAME.width },
  /** Captions, bottom-anchored at `bottom`, growing upward to at most two lines. */
  caption: { top: 1380, bottom: 1560, x: CONTENT_X, w: CONTENT_WIDTH },
};

/** The bands that carry words, and so must clear the platforms' own chrome. */
export const TEXT_BANDS: BandName[] = ["title", "caption"];

/**
 * What the publishing platforms draw over the video.
 *
 * The stage deliberately runs under the action rail: the page card is imagery,
 * and nobody needs its right margin. Only `TEXT_BANDS` are held clear.
 */
export const RESERVED: { name: string; box: Box }[] = [
  /** Instagram Reels: username, caption and the audio ticker. */
  { name: "reels-bottom", box: { x: 0, y: 1670, w: FRAME.width, h: FRAME.height - 1670 } },
  /** YouTube Shorts: the title and channel row. */
  { name: "shorts-bottom", box: { x: 0, y: 1760, w: FRAME.width, h: FRAME.height - 1760 } },
  /** Both platforms' like / comment / share column. */
  { name: "action-rail", box: { x: 950, y: 1000, w: FRAME.width - 950, h: 800 } },
];

export function bandBox(name: BandName): Box {
  const b = BANDS[name];
  return { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top };
}

/** Strict overlap: boxes that merely share an edge do not overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Every way a set of placed boxes can be wrong, named. Empty means the layout is
 * sound. Pure, so the unit test and the live-browser test share one judgement.
 */
export function gridViolations(items: { name: string; box: Box }[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const { name, box } = item;
    if (box.x < 0 || box.y < 0 || box.x + box.w > FRAME.width || box.y + box.h > FRAME.height) {
      out.push(`${name} is outside the frame: ${JSON.stringify(box)}`);
      continue;
    }
    let foundReservedViolation = false;
    for (const r of RESERVED) {
      if (overlaps(box, r.box)) {
        out.push(`${name} reaches into ${r.name}, which the platform covers`);
        foundReservedViolation = true;
        break;
      }
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let k = i + 1; k < items.length; k++) {
      if (overlaps(items[i].box, items[k].box)) {
        out.push(`${items[i].name} overlaps ${items[k].name}`);
      }
    }
  }
  return out;
}
