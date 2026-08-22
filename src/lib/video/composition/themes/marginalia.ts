import type { BookTheme } from "../theme-contract";

/**
 * The page as a student's copy: warm paper, a felt-tip yellow that bleeds
 * slightly past the words, and annotations in the margin.
 *
 * `.annot` doubles as the styling hook for the shared cue-card element that
 * `build.ts` creates and times (see the theme-contract note there): this file
 * only says what an annotation looks like, never when or where one appears.
 */
export const marginalia: BookTheme = {
  id: "marginalia",
  mood: "warm",
  palette: {
    paper: "#f6f1e4",
    ink: "#221d16",
    marker: "#ffe14d",
    markerEdge: "#f2c200",
    captionBg: "rgba(20,17,12,0.86)",
    captionInk: "#fdfaf2",
    accent: "#d9531e",
    vignette: "rgba(60,45,20,0.35)",
  },

  css: () => `
    .backdrop { background: radial-gradient(120% 80% at 50% 20%, #fbf7ec 0%, #e8dfc9 100%); }
    .grain { position:absolute; inset:0; opacity:.14; mix-blend-mode:multiply;
             background-image: radial-gradient(#8a7a58 1px, transparent 1px);
             background-size: 3px 3px; pointer-events:none; }
    .stroke { border-radius:3px;
              background: linear-gradient(180deg, #ffe97a 0%, #ffe14d 55%, #f2c200 100%);
              mix-blend-mode: multiply; box-shadow: 0 0 6px 2px rgba(255,225,77,.45); }
    .annot { color:#d9531e; font-family: "Bradley Hand", "Segoe Script", cursive;
             font-size: 34px; transform: rotate(-4deg); background: #fff7d6;
             border: 1px solid rgba(217,83,30,0.35); box-shadow: 2px 3px 6px rgba(0,0,0,0.18); }
    .caption-line { background: rgba(20,17,12,0.86); color:#fdfaf2; }
    .vignette { position:absolute; inset:0; pointer-events:none;
                box-shadow: inset 0 0 220px 60px rgba(60,45,20,.35); }
  `,

  backdrop: () => `<div class="backdrop"></div><div class="grain"></div>`,
  overlay: () => `<div class="vignette"></div>`,

  // One element, one transform. The tween that drives it is a single scaleX,
  // which is the only shape a stroke may take: two tweens on one property are
  // order-dependent, and order does not survive a seek.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
