import type { BookTheme } from "../theme-contract";

/**
 * The page as a student's copy: warm paper, a felt-tip yellow that bleeds
 * slightly past the words, and annotations in the margin.
 *
 * The framed layout (spec 2026-08-23 §1) changed what this theme has to
 * carry. The photograph used to fill all 1080x1920, so everything behind it
 * was dead pixels; now the page lives on a 960x1120 card and the backdrop is
 * roughly two thirds of what the viewer actually sees. It is treated as a
 * real surface here — a deep warm desk with two soft colour blooms and grain
 * — because the cream card only reads as "floating paper" if there is
 * something darker for it to float against.
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

    backdropDeep: "#150f09",
    backdropBase: "#3a2617",
    bloomA: "rgba(217,83,30,0.55)",
    bloomB: "rgba(255,201,77,0.34)",
    cardFace: "#f6f1e4",
    cardEdge: "rgba(255,244,214,0.22)",
    cardShadow: "rgba(0,0,0,0.62)",
    hookInk: "#fdf6e6",
    hookKey: "#ffd23f",
    hookScrim: "rgba(12,8,5,0.68)",
    ctaInk: "#231a10",
    ctaFace: "#f8f2e2",
    progressTrack: "rgba(255,238,200,0.16)",
    progressFill: "#ffd23f",
  },

  css: () => `
    /* --- backdrop: deep warm desk, two blooms, grain ---------------------- */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(120% 70% at 50% 22%, #4b3220 0%, #2a1b10 46%, #150f09 100%),
                  linear-gradient(180deg, #241708 0%, #120c07 100%); }
    /* Blurred colour blooms. Static CSS filters, never tweened — a blur that
       animated would be both expensive per frame and pointless, since the
       renderer only ever screenshots single instants. */
    .bloom { position:absolute; border-radius:50%; filter: blur(150px);
             pointer-events:none; }
    .bloom-a { width:900px; height:900px; left:-220px; top:-160px;
               background: radial-gradient(circle, rgba(217,83,30,0.55) 0%, rgba(217,83,30,0) 70%); }
    .bloom-b { width:1000px; height:1000px; left:380px; top:1180px;
               background: radial-gradient(circle, rgba(255,201,77,0.34) 0%, rgba(255,201,77,0) 70%); }
    .grain { position:absolute; inset:0; opacity:.10; mix-blend-mode:overlay;
             background-image: radial-gradient(#d9c9a3 1px, transparent 1px);
             background-size: 3px 3px; pointer-events:none; }

    /* --- the paper card --------------------------------------------------- */
    .card { background:#efe7d3;
            box-shadow: 0 42px 90px -24px rgba(0,0,0,0.62),
                        0 8px 26px -10px rgba(0,0,0,0.45),
                        0 0 0 1px rgba(255,244,214,0.22); }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(168deg, #fbf6ea 0%, #f4eeddff 55%, #ebe2ca 100%); }

    /* --- highlight engine (look only) ------------------------------------- */
    .stroke { border-radius:3px;
              background: linear-gradient(180deg, #ffe97a 0%, #ffe14d 55%, #f2c200 100%);
              mix-blend-mode: multiply; box-shadow: 0 0 6px 2px rgba(255,225,77,.45); }

    /* The rotation deliberately stays on \`.cue\` in the shared skeleton rather
       than being restated here: a \`transform\` declared on \`.annot\` overrides
       \`.cue\`'s whole transform (same specificity, theme CSS appended later),
       which silently drops the \`translateX(-50%)\` that centres the card. */
    .annot { color:#d9531e; font-family: "Bradley Hand", "Segoe Script", cursive;
             font-size: 34px; background: #fff7d6;
             border: 1px solid rgba(217,83,30,0.35); box-shadow: 2px 3px 6px rgba(0,0,0,0.28); }

    /* --- captions, hook, CTA, progress ------------------------------------ */
    .caption-line { background: rgba(20,17,12,0.90); color:#fdfaf2;
                    box-shadow: 0 10px 30px -12px rgba(0,0,0,0.7); }
    .hook-scrim { background: rgba(12,8,5,0.68); }
    .hook-text { color:#fdf6e6; text-shadow: 0 6px 26px rgba(0,0,0,0.6); }
    .cta-card { background:#f8f2e2; color:#231a10;
                box-shadow: 0 36px 80px -24px rgba(0,0,0,0.66),
                            0 0 0 1px rgba(255,244,214,0.22); }
    .cta-kicker { color:#d9531e; }
    .progress-fill { background: linear-gradient(90deg, #d9531e 0%, #ffd23f 100%); }

    .vignette { position:absolute; inset:0; pointer-events:none;
                box-shadow: inset 0 0 260px 80px rgba(20,12,4,.55); }
  `,

  backdrop: () =>
    `<div class="backdrop"></div><div class="bloom bloom-a"></div><div class="bloom bloom-b"></div><div class="grain"></div>`,

  cardFace: () => `<div class="card-face"></div>`,

  overlay: () => `<div class="vignette"></div>`,

  // One element, one transform. The tween that drives it is a single scaleX,
  // which is the only shape a stroke may take: two tweens on one property are
  // order-dependent, and order does not survive a seek.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
