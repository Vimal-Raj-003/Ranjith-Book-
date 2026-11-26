/**
 * 100% Local BookReel ("YT Book") — CLEAN WHITE KINETIC MOTION REFERENCE RUNNER
 * (`@divyansh.fx_` / Apple-SaaS Minimalist After Effects Pattern).
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini / external calls).
 * Choreographs Episode `cmwqeq5fb000nn6w00khoy2f5` ("Why Fast Decisions Reveal What You Really Want")
 * across ALL 10 signature motion scenes from the user's reference video at 1080×1920 (`--quality high`):
 *   1. Kinetic Scale-Down Hook ("Want to know" -> "Time how fast you choose") + floating green glyphs + corner arcs
 *   2. Macro Breguet Watch Hand sweeping across a curved neon-green gauge arc + italic serif accent
 *   3. Green L-Bracket Viewfinder Corners + 5-Silhouette Focus Group (1 sharp black center + 4 blurred green)
 *   4. Live Circular Neon-Green Millisecond Ring Counter (850 -> 180 ms · "With great swiftness")
 *   5. Blur-Typewriter "Internal doubt" over giant outlined "???" + 3 Floating White Book Study Cards (p. 114)
 *   6. 3-Hexagon Honeycomb Callout Triad (sequentially popping green hexagons + black corner brackets + leader lines)
 *   7. Minimalist Green-Aura Word Reveal -> Crisp Black Editorial Italic Serif ("Actual preference.")
 *   8. 6-Pill Staggered Cascade (alternating solid neon-green & black-outlined white pills + soft mint bokeh rings)
 *   9. Horizontal Camera-Pan Line ("Notice how fast you" -> "Reach today.") + Hand-Drawn Glowing Green Oval Circle
 *  10. Clean Minimalist White Studio Sign-Off Lockup ("BookReel · p. 114")
 */
process.env.BOOKREEL_VISUAL_LOCAL_ONLY = "1";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { synthesizeVoiceover } from "../src/lib/media/tts";
import { timeNarration } from "../src/lib/media/narration-timing";
import { generateCinematicScoreWav } from "../src/lib/media/cinematic-score";
import { toWav } from "../src/lib/media/music-synth";
import {
  loadProjectSfxLibrary,
  renderSelectiveLibrarySfxBuffer,
  type SelectiveLibrarySfxPlanItem,
} from "../src/lib/media/sfx-library";
import { renderProject, writeProject } from "../src/lib/video/render";
import type { Beat, ContentPackage } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";

const EPISODE_ID = "cmwqeq5fb000nn6w00khoy2f5";
const SLUG = "ref-white-kinetic-fast-decisions";
const VOICE_ID = "charles";
const AUDIO_OFFSET = 0.45;
const OUTRO_TAIL = 2.0;
const FPS = 30;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findWordStart(
  words: TimedWord[],
  winStart: number,
  winEnd: number,
  targetRegex: RegExp,
  fallbackRatio: number,
): number {
  const match = words.find(
    (w) => w.start >= winStart - 0.08 && w.start <= winEnd + 0.08 && targetRegex.test(w.word),
  );
  if (match) return +(AUDIO_OFFSET + match.start).toFixed(3);
  return +(AUDIO_OFFSET + winStart + (winEnd - winStart) * fallbackRatio).toFixed(3);
}

interface TimelineSpec {
  duration: number;
  s1Start: number;
  s1SubSwap: number;
  s1End: number;
  s2Start: number;
  s2End: number;
  s3Start: number;
  s3End: number;
  s4Start: number;
  s4End: number;
  s5Start: number;
  s5End: number;
  s6Start: number;
  s6End: number;
  s7Start: number;
  s7SerifAt: number;
  s7End: number;
  s8Start: number;
  s8End: number;
  s9Start: number;
  s9PanAt: number;
  s9End: number;
  s10Start: number;
}

function buildWhiteKineticHtml(t: TimelineSpec, bookTitle: string): string {
  // Generate 38 radial tick marks along the macro watch arc (center cx=180, cy=1280, radius=880, inner ticks r=790..836)
  const cx = 180;
  const cy = 1280;
  const rArc = 880;
  const ticksSvg: string[] = [];
  for (let deg = -84; deg <= -12; deg += 2) {
    const rad = (deg * Math.PI) / 180;
    const isMajor = deg % 16 === 0;
    const rIn = isMajor ? 772 : 806;
    const rOut = isMajor ? 838 : 834;
    const x1 = (cx + rIn * Math.cos(rad)).toFixed(1);
    const y1 = (cy + rIn * Math.sin(rad)).toFixed(1);
    const x2 = (cx + rOut * Math.cos(rad)).toFixed(1);
    const y2 = (cy + rOut * Math.sin(rad)).toFixed(1);
    ticksSvg.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isMajor ? "#1E293B" : "#CBD5E1"}" stroke-width="${isMajor ? "3.2" : "1.8"}" stroke-linecap="round" />`,
    );
  }
  const arcNodesSvg = [-76, -56, -36, -18]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const nx = (cx + rArc * Math.cos(rad)).toFixed(1);
      const ny = (cy + rArc * Math.sin(rad)).toFixed(1);
      return `<circle cx="${nx}" cy="${ny}" r="11" fill="#FFFFFF" stroke="#162019" stroke-width="5" />`;
    })
    .join("");

  // Arc path from -88 deg to -8 deg on radius 880 around (180, 1280)
  const a0 = (-88 * Math.PI) / 180;
  const a1 = (-8 * Math.PI) / 180;
  const ax0 = (cx + rArc * Math.cos(a0)).toFixed(1);
  const ay0 = (cy + rArc * Math.sin(a0)).toFixed(1);
  const ax1 = (cx + rArc * Math.cos(a1)).toFixed(1);
  const ay1 = (cy + rArc * Math.sin(a1)).toFixed(1);
  const watchArcPath = `M ${ax0} ${ay0} A ${rArc} ${rArc} 0 0 1 ${ax1} ${ay1}`;

  // Reusable human silhouette bust SVG
  const personBust = (fill: string) => `
    <svg viewBox="0 0 120 132" width="100%" height="100%" fill="none">
      <circle cx="60" cy="38" r="24" fill="${fill}" />
      <path d="M14 124 C14 88, 34 74, 60 74 C86 74, 106 88, 106 124 Z" fill="${fill}" />
    </svg>`;

  // Pointy-top hexagon helper (260x296 viewBox)
  const hexCard = (id: string, iconInner: string) => `
    <div class="hex-wrap" id="${id}">
      <svg viewBox="0 0 260 296" width="260" height="296" fill="none">
        <polygon points="130,10 246,77 246,219 130,286 14,219 14,77" fill="#18D422" />
        <!-- Crisp black architectural corner brackets matching reference -->
        <polyline points="92,32 130,10 168,32" stroke="#0B0D0E" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" />
        <polyline points="14,176 14,219 50,240" stroke="#0B0D0E" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" />
        <polyline points="246,176 246,219 210,240" stroke="#0B0D0E" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" />
        ${iconInner}
      </svg>
    </div>`;

  const payloadJson = JSON.stringify(t);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${esc(bookTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: 1080px; height: 1920px;
    background: #FFFFFF;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #0B0D0E;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .stage {
    position: relative;
    width: 1080px;
    height: 1920px;
    overflow: hidden;
    background: radial-gradient(90% 70% at 50% 48%, #FFFFFF 0%, #FAFCFA 100%);
  }
  .clip { position: absolute; inset: 0; }

  /* Soft ambient mint bokeh rings matching @divyansh.fx_ */
  .bokeh-layer { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
  .bokeh-ring {
    position: absolute;
    border-radius: 50%;
    border: 46px solid rgba(28, 218, 38, 0.14);
    filter: blur(26px);
  }
  .bokeh-tl { width: 540px; height: 540px; left: -170px; top: -130px; }
  .bokeh-br { width: 500px; height: 500px; left: 730px; top: 1500px; }

  .k-scene {
    position: absolute;
    inset: 0;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .k-cam {
    position: absolute;
    inset: 0;
    transform-origin: 50% 50%;
  }

  .serif-it {
    font-family: "Instrument Serif", Georgia, "Times New Roman", serif;
    font-style: italic;
    font-weight: 400;
    letter-spacing: -0.01em;
  }
  .txt-green { color: #18D422; }
  .green-aura {
    text-shadow: 0 0 48px rgba(24, 212, 34, 0.34), 0 0 18px rgba(24, 212, 34, 0.18);
  }

  /* --- SCENE 1: Kinetic Scale-Down Hook --- */
  .s1-arc-tl {
    position: absolute; left: -160px; top: -150px; width: 430px; height: 430px;
    border-radius: 50%; border: 2.2px solid rgba(24, 212, 34, 0.52);
  }
  .s1-arc-br {
    position: absolute; left: 820px; top: 1620px; width: 420px; height: 420px;
    border-radius: 50%; border: 2.2px solid rgba(24, 212, 34, 0.52);
  }
  .s1-center {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 960px; text-align: center;
  }
  .s1-lineA {
    font-size: 82px; font-weight: 600; letter-spacing: -0.04em; line-height: 1.08;
    color: #0B0D0E;
  }
  .s1-lineA-sub {
    margin-top: 14px;
    font-size: 86px; line-height: 1.05;
  }
  .s1-lineB {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 980px; text-align: center;
    font-size: 64px; font-weight: 500; letter-spacing: -0.035em;
    white-space: nowrap;
  }
  .s1-glyph {
    position: absolute;
    font-size: 32px; font-weight: 700; color: #18D422;
    filter: drop-shadow(0 0 12px rgba(24,212,34,0.35));
  }

  /* --- SCENE 2: Macro Breguet Watch Dial --- */
  .s2-dial-svg {
    position: absolute; left: 0; top: 0; width: 1080px; height: 1920px;
  }
  .s2-hand-group {
    transform-origin: 180px 1280px;
    filter: drop-shadow(18px 22px 16px rgba(11, 13, 14, 0.14));
  }
  .s2-copy {
    position: absolute; left: 540px; top: 1320px;
    transform: translateX(-50%);
    width: 780px; text-align: center;
  }
  .s2-kicker {
    font-size: 56px; font-weight: 500; letter-spacing: -0.035em; line-height: 1.05;
    color: #0B0D0E;
  }
  .s2-serif {
    font-size: 76px; line-height: 1.02; margin-top: 4px;
  }
  .s2-micro {
    margin-top: 20px;
    font-size: 25px; font-weight: 400; line-height: 1.38; color: #374151;
    letter-spacing: -0.01em;
  }

  /* --- SCENE 3: Viewfinder Brackets + 5 Silhouettes --- */
  .s3-box {
    position: absolute; left: 110px; top: 430px; width: 860px; height: 980px;
  }
  .vf-corner {
    position: absolute; width: 170px; height: 170px;
    border-color: #18D422; border-style: solid; border-width: 0;
  }
  .vf-tl { left: 0; top: 0; border-left-width: 4px; border-top-width: 4px; }
  .vf-tr { right: 0; top: 0; border-right-width: 4px; border-top-width: 4px; }
  .vf-bl { left: 0; bottom: 0; border-left-width: 4px; border-bottom-width: 4px; }
  .vf-br { right: 0; bottom: 0; border-right-width: 4px; border-bottom-width: 4px; }
  .s3-hdr {
    position: absolute; left: 0; right: 0; top: 120px; text-align: center;
  }
  .s3-title {
    font-size: 68px; font-weight: 500; letter-spacing: -0.035em; line-height: 1.06;
  }
  .s3-sub-serif {
    font-size: 76px; line-height: 1.02; margin-top: 2px;
  }
  .s3-people {
    position: absolute; left: 50%; top: 440px; transform: translateX(-50%);
    width: 780px; height: 220px;
    display: flex; align-items: flex-end; justify-content: center; gap: 22px;
  }
  .p-outer { width: 108px; height: 120px; filter: blur(4.5px); opacity: 0.82; }
  .p-inner { width: 138px; height: 152px; filter: blur(2.2px); opacity: 0.94; }
  .p-center {
    position: relative; width: 184px; height: 202px;
  }
  .p-reticle {
    position: absolute; inset: -10px;
    border: 0 solid #0B0D0E;
  }
  .s3-foot {
    position: absolute; left: 50%; top: 748px; transform: translateX(-50%);
    width: 660px; text-align: center;
    font-size: 26px; font-weight: 500; line-height: 1.35; color: #1F2937;
  }

  /* --- SCENE 4: Circular Neon Progress Counter --- */
  .s4-wrap {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 680px; text-align: center;
  }
  .s4-ring-box {
    position: relative; width: 350px; height: 350px; margin: 0 auto;
    filter: drop-shadow(0 0 38px rgba(24, 212, 34, 0.24));
  }
  .s4-num {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -52%);
    font-size: 98px; font-weight: 600; letter-spacing: -0.04em; color: #0B0D0E;
  }
  .s4-unit {
    position: absolute; left: 50%; top: 67%; transform: translateX(-50%);
    font-size: 24px; font-weight: 600; letter-spacing: 0.08em; color: #18D422;
    text-transform: uppercase;
  }
  .s4-lbl {
    margin-top: 34px;
    font-size: 52px; font-weight: 500; letter-spacing: -0.03em; color: #0B0D0E;
  }

  /* --- SCENE 5: Floating Book Study Cards + ??? + Internal Doubt --- */
  .s5-qmarks {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -54%);
    width: 720px; text-align: center;
    font-size: 250px; font-weight: 600; letter-spacing: -0.03em;
    color: transparent;
    -webkit-text-stroke: 3.5px rgba(24, 212, 34, 0.28);
    user-select: none;
  }
  .s5-headline {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 980px; text-align: center;
    font-size: 74px; font-weight: 500; letter-spacing: -0.035em; color: #0B0D0E;
  }
  .study-card {
    position: absolute;
    background: #FFFFFF;
    border: 1.5px solid #E5E7EB;
    border-radius: 28px;
    padding: 26px 28px;
    box-shadow: 0 24px 54px rgba(11, 13, 14, 0.07), 0 4px 12px rgba(11, 13, 14, 0.03);
  }
  .sc-c1 { left: 78px; top: 340px; width: 470px; }
  .sc-c2 { left: 560px; top: 540px; width: 442px; }
  .sc-c3 { left: 170px; top: 1190px; width: 430px; filter: blur(1.2px); opacity: 0.92; }
  .sc-top { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .sc-avatar {
    width: 50px; height: 50px; border-radius: 50%;
    background: #0B0D0E; color: #FFFFFF;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700;
  }
  .sc-avatar-grn { background: #18D422; color: #FFFFFF; }
  .sc-name { font-size: 20px; font-weight: 600; color: #0B0D0E; line-height: 1.2; }
  .sc-role { font-size: 16px; color: #6B7280; line-height: 1.2; margin-top: 2px; }
  .sc-quote { font-size: 19px; line-height: 1.42; color: #1F2937; margin-bottom: 14px; }
  .sc-stars { font-size: 20px; font-weight: 700; color: #18D422; letter-spacing: 2px; }
  .sc-score { color: #0B0D0E; font-size: 18px; letter-spacing: 0; margin-left: 8px; }

  /* --- SCENE 6: 3-Hexagon Honeycomb Triad --- */
  .s6-stage { position: absolute; inset: 0; }
  .hex-wrap { position: absolute; width: 260px; height: 296px; transform-origin: 50% 50%; }
  #hex-1 { left: 234px; top: 650px; }
  #hex-2 { left: 586px; top: 650px; }
  #hex-3 { left: 410px; top: 966px; }
  .s6-lines-svg { position: absolute; inset: 0; width: 1080px; height: 1920px; }
  .hex-lbl {
    position: absolute;
    font-size: 36px; font-weight: 500; letter-spacing: -0.025em; color: #0B0D0E;
    white-space: nowrap;
  }
  #hlbl-1 { left: 86px; top: 472px; }
  #hlbl-2 { left: 650px; top: 472px; }
  #hlbl-3 { left: 430px; top: 1396px; }

  /* --- SCENE 7: Minimalist Green Glow Words -> Editorial Serif --- */
  .s7-word {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 960px; text-align: center;
    font-size: 68px; font-weight: 500; letter-spacing: -0.03em;
    color: #18D422;
  }
  .s7-serif-final {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 980px; text-align: center;
    font-size: 96px; color: #0B0D0E;
  }

  /* --- SCENE 8: 6-Pill Staggered Cascade --- */
  .s8-stack {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 940px;
    display: flex; flex-direction: column; gap: 28px;
  }
  .pill-row { display: flex; align-items: center; gap: 24px; }
  .pill-row-1 { justify-content: flex-start; padding-left: 16px; }
  .pill-row-2 { justify-content: flex-start; padding-left: 16px; }
  .pill-row-3 { justify-content: flex-start; padding-left: 16px; }
  .pill-row-4 { justify-content: flex-end; padding-right: 12px; }
  .k-pill {
    display: inline-flex; align-items: center; justify-content: center;
    height: 98px; padding: 0 46px;
    border-radius: 999px;
    font-size: 40px; font-weight: 500; letter-spacing: -0.025em;
    white-space: nowrap;
  }
  .k-pill-green {
    background: #18D422; color: #FFFFFF;
    box-shadow: 0 14px 34px rgba(24, 212, 34, 0.24);
  }
  .k-pill-outline {
    background: #FFFFFF; color: #0B0D0E;
    border: 2.5px solid #0B0D0E;
  }

  /* --- SCENE 9: Horizontal Camera Pan + Glowing Green Oval --- */
  .s9-track {
    position: absolute; left: 540px; top: 960px;
    display: flex; align-items: center; gap: 28px;
    transform: translate(-50%, -50%);
    white-space: nowrap;
  }
  .s9-lead {
    font-size: 56px; font-weight: 500; letter-spacing: -0.03em; color: #0B0D0E;
  }
  .s9-focus-box {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    padding: 24px 48px;
  }
  .s9-payoff {
    font-size: 82px; font-weight: 600; letter-spacing: -0.04em; color: #0B0D0E;
  }
  .s9-oval-svg {
    position: absolute; left: -24px; top: -18px;
    width: calc(100% + 48px); height: calc(100% + 36px);
    overflow: visible; pointer-events: none;
  }

  /* --- SCENE 10: Clean Minimalist Sign-Off --- */
  .s10-center {
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }
  .s10-mark {
    width: 112px; height: 112px; margin: 0 auto 20px;
  }
  .s10-brand {
    font-size: 42px; font-weight: 600; letter-spacing: -0.03em; color: #0B0D0E;
  }
  .s10-cite {
    margin-top: 10px;
    font-size: 22px; font-weight: 400; color: #6B7280; letter-spacing: -0.01em;
  }
</style>
</head>
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${t.duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${t.duration.toFixed(3)}" data-track-index="0">

    <!-- Ambient Mint Bokeh Rings -->
    <div class="bokeh-layer" id="bokeh-layer">
      <div class="bokeh-ring bokeh-tl" id="bokeh-tl"></div>
      <div class="bokeh-ring bokeh-br" id="bokeh-br"></div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 1: Kinetic Scale-Down Hook ("Want to know..." -> "fast you choose") -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-1">
      <div class="k-cam" id="cam-1">
        <div class="s1-arc-tl" id="s1-arc-tl"></div>
        <div class="s1-arc-br" id="s1-arc-br"></div>
        <div class="s1-center" id="s1-partA">
          <div class="s1-lineA" id="s1-w1">Want to know</div>
          <div class="s1-lineA-sub serif-it txt-green green-aura" id="s1-w2">what you really want?</div>
        </div>
        <div class="s1-lineB" id="s1-partB">
          <span id="s1-b1">Time how </span><span class="txt-green green-aura" id="s1-b2">fast you choose.</span>
          <span class="s1-glyph" id="s1-g1" style="left:470px; top:-64px;">⏱</span>
          <span class="s1-glyph" id="s1-g2" style="left:650px; top:86px;">⚡</span>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 2: Giant Macro Breguet Watch Dial + Sweeping Green Arc        -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-2">
      <div class="k-cam" id="cam-2-in">
      <div class="k-cam" id="cam-2">
        <svg class="s2-dial-svg" viewBox="0 0 1080 1920" fill="none">
          ${ticksSvg.join("\n          ")}
          <path id="s2-arc" d="${watchArcPath}" stroke="#18D422" stroke-width="8" stroke-linecap="round" stroke-dasharray="1400" stroke-dashoffset="1400" style="filter:drop-shadow(0 0 16px rgba(24,212,34,0.35))" />
          <g id="s2-nodes">${arcNodesSvg}</g>
          <!-- Ornate Breguet Skeleton Watch Hand pivoting around (180, 1280) -->
          <g class="s2-hand-group" id="s2-hand">
            <circle cx="180" cy="1280" r="34" fill="#0B0D0E" />
            <circle cx="180" cy="1280" r="16" fill="#18D422" />
            <!-- Tapered black shaft -->
            <polygon points="162,1280 198,1280 191,680 169,680" fill="#0B0D0E" />
            <!-- Green collar ring -->
            <rect x="156" y="664" width="48" height="22" rx="8" fill="#18D422" />
            <!-- Breguet hollow diamond pointer & needle tip -->
            <path d="M180 664 L224 560 L180 448 L136 560 Z" fill="#0B0D0E" />
            <path d="M180 628 L202 562 L180 492 L158 562 Z" fill="#FFFFFF" />
            <polygon points="174,454 186,454 180,308" fill="#0B0D0E" />
          </g>
        </svg>
        <div class="s2-copy" id="s2-copy">
          <div class="s2-kicker">Because speed</div>
          <div class="s2-serif serif-it txt-green green-aura">matches the pull</div>
          <div class="s2-micro">The speed of a selection matches the<br/>true weight of its underlying pull.</div>
        </div>
      </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 3: Green L-Bracket Viewfinder + 5-Silhouette Focus Group      -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-3">
      <div class="k-cam" id="cam-3">
        <div class="s3-box">
          <div class="vf-corner vf-tl" id="vf-tl"></div>
          <div class="vf-corner vf-tr" id="vf-tr"></div>
          <div class="vf-corner vf-bl" id="vf-bl"></div>
          <div class="vf-corner vf-br" id="vf-br"></div>
          <div class="s3-hdr" id="s3-hdr">
            <div class="s3-title">Even with</div>
            <div class="s3-sub-serif serif-it txt-green">negative options</div>
          </div>
          <div class="s3-people" id="s3-people">
            <div class="p-outer">${personBust("#18D422")}</div>
            <div class="p-inner">${personBust("#18D422")}</div>
            <div class="p-center" id="s3-hero-person">
              <svg viewBox="0 0 200 220" width="200" height="220" style="position:absolute;left:-8px;top:-8px;pointer-events:none" fill="none">
                <polyline points="8,28 8,8 28,8" stroke="#0B0D0E" stroke-width="3" />
                <polyline points="172,8 192,8 192,28" stroke="#0B0D0E" stroke-width="3" />
                <polyline points="8,192 8,212 28,212" stroke="#0B0D0E" stroke-width="3" />
                <polyline points="172,212 192,212 192,192" stroke="#0B0D0E" stroke-width="3" />
              </svg>
              ${personBust("#0B0D0E")}
            </div>
            <div class="p-inner">${personBust("#18D422")}</div>
            <div class="p-outer">${personBust("#18D422")}</div>
          </div>
          <div class="s3-foot" id="s3-foot">
            Your mind scans every choice in milliseconds<br/>and locks onto what you truly prefer.
          </div>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 4: Circular Neon-Green Millisecond Ring Counter               -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-4">
      <div class="k-cam" id="cam-4">
        <div class="s4-wrap">
          <div class="s4-ring-box" id="s4-ring-box">
            <svg viewBox="0 0 350 350" width="350" height="350" fill="none">
              <circle cx="175" cy="175" r="146" stroke="#E5E7EB" stroke-width="20" />
              <circle id="s4-arc" cx="175" cy="175" r="146" stroke="#18D422" stroke-width="20" stroke-linecap="round"
                transform="rotate(-90 175 175)" stroke-dasharray="918" stroke-dashoffset="918" />
            </svg>
            <div class="s4-num" id="s4-num">840</div>
            <div class="s4-unit">ms snap</div>
          </div>
          <div class="s4-lbl" id="s4-lbl">With <span class="txt-green">great swiftness</span></div>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 5: Outlined "???" + "Internal doubt" + 3 Floating Book Cards  -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-5">
      <div class="k-cam" id="cam-5">
        <div class="study-card sc-c1" id="sc5-c1">
          <div class="sc-top">
            <div class="sc-avatar">P.114</div>
            <div>
              <div class="sc-name">Motive Force Study</div>
              <div class="sc-role">Experimental Will Psychology</div>
            </div>
          </div>
          <div class="sc-quote">“A direct correlation existed between the quickness of the reaction and the motive-force of the choice.”</div>
          <div class="sc-stars">★★★★★ <span class="sc-score">p. 114</span></div>
        </div>

        <div class="study-card sc-c2" id="sc5-c2">
          <div class="sc-top">
            <div class="sc-avatar sc-avatar-grn">LAB</div>
            <div>
              <div class="sc-name">Reaction Trial</div>
              <div class="sc-role">Three-Subject Verification</div>
            </div>
          </div>
          <div class="sc-quote">“When hesitation appears, competing internal doubt is holding back the weaker alternative.”</div>
          <div class="sc-stars">★★★★★ <span class="sc-score">Verified</span></div>
        </div>

        <div class="study-card sc-c3" id="sc5-c3">
          <div class="sc-top">
            <div class="sc-avatar">EXP</div>
            <div>
              <div class="sc-name">Relative Value</div>
              <div class="sc-role">Archival Finding</div>
            </div>
          </div>
          <div class="sc-quote">“Slow choices signal friction; instant picks expose true desire.”</div>
          <div class="sc-stars">★★★★★ <span class="sc-score">5.00</span></div>
        </div>

        <div class="s5-qmarks" id="s5-qmarks">???</div>
        <div class="s5-headline" id="s5-headline">Hesitation signals <span class="txt-green">doubt</span></div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 6: 3-Hexagon Honeycomb Callout Triad                          -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-6">
      <div class="k-cam" id="cam-6">
        <svg class="s6-lines-svg" viewBox="0 0 1080 1920" fill="none">
          <polyline id="hline-1" points="364,660 364,586 276,526" stroke="#0B0D0E" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="240" stroke-dashoffset="240" />
          <polyline id="hline-2" points="716,660 716,586 804,526" stroke="#0B0D0E" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="240" stroke-dashoffset="240" />
          <polyline id="hline-3" points="540,1252 540,1328 612,1384" stroke="#0B0D0E" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="240" stroke-dashoffset="240" />
        </svg>

        ${hexCard(
          "hex-1",
          `<circle cx="130" cy="148" r="64" stroke="#FFFFFF" stroke-width="3.5" />
           <line x1="130" y1="72" x2="130" y2="92" stroke="#FFFFFF" stroke-width="3.5" />
           <line x1="130" y1="204" x2="130" y2="224" stroke="#FFFFFF" stroke-width="3.5" />
           <line x1="54" y1="148" x2="74" y2="148" stroke="#FFFFFF" stroke-width="3.5" />
           <line x1="186" y1="148" x2="206" y2="148" stroke="#FFFFFF" stroke-width="3.5" />
           <path d="M138 110 L108 152 H134 L122 188 L156 144 H130 Z" stroke="#FFFFFF" stroke-width="3.5" stroke-linejoin="round" />`,
        )}

        ${hexCard(
          "hex-2",
          `<circle cx="130" cy="148" r="66" stroke="#FFFFFF" stroke-width="3.5" />
           <circle cx="130" cy="148" r="50" stroke="#FFFFFF" stroke-width="2.5" stroke-dasharray="8 8" />
           <path d="M130 104 C144 120, 146 144, 144 162 L130 176 L116 162 C114 144, 116 120, 130 104 Z" stroke="#FFFFFF" stroke-width="3.5" />
           <circle cx="130" cy="138" r="8" stroke="#FFFFFF" stroke-width="3" />`,
        )}

        ${hexCard(
          "hex-3",
          `<rect x="86" y="156" width="18" height="36" rx="3" stroke="#FFFFFF" stroke-width="3.5" />
           <rect x="120" y="136" width="18" height="56" rx="3" stroke="#FFFFFF" stroke-width="3.5" />
           <rect x="154" y="114" width="18" height="78" rx="3" stroke="#FFFFFF" stroke-width="3.5" />
           <circle cx="130" cy="96" r="14" stroke="#FFFFFF" stroke-width="3.2" />
           <path d="M76 198 H186" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" />`,
        )}

        <div class="hex-lbl" id="hlbl-1">Instant reaction</div>
        <div class="hex-lbl" id="hlbl-2">True motive force</div>
        <div class="hex-lbl" id="hlbl-3">Driving your action</div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 7: Minimalist Green Glow Words -> Crisp Black Italic Serif    -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-7">
      <div class="k-cam" id="cam-7">
        <div id="s7-w1-exit" style="position:absolute;inset:0;"><div class="s7-word green-aura" id="s7-w1">Reaction time lays bare</div></div>
        <div class="s7-serif-final serif-it" id="s7-serif">Actual preference.</div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 8: 6-Pill Staggered Cascade                                   -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-8">
      <div class="k-cam" id="cam-8">
        <div class="s8-stack">
          <div class="pill-row pill-row-1">
            <div class="k-pill k-pill-green" id="pill-1">Actual preference.</div>
            <div class="k-pill k-pill-outline" id="pill-2">Zero doubt</div>
          </div>
          <div class="pill-row pill-row-2">
            <div class="k-pill k-pill-outline" id="pill-3">Unfiltered</div>
            <div class="k-pill k-pill-green" id="pill-4">Bypasses excuses</div>
          </div>
          <div class="pill-row pill-row-3">
            <div class="k-pill k-pill-green" id="pill-5">Exposes true desire</div>
          </div>
          <div class="pill-row pill-row-4">
            <div class="k-pill k-pill-outline" id="pill-6">Whatever story you tell yourself</div>
          </div>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 9: Horizontal Camera-Pan + Hand-Drawn Glowing Green Oval      -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-9">
      <div class="k-cam" id="cam-9">
        <div class="s9-track" id="s9-track">
          <span class="s9-lead" id="s9-lead">Notice how fast you</span>
          <span class="s9-focus-box" id="s9-focus">
            <span class="s9-payoff">Reach today.</span>
            <svg class="s9-oval-svg" viewBox="0 0 620 180" fill="none">
              <path id="s9-oval-glow" d="M 38 94 C 34 32, 184 14, 318 16 C 468 18, 594 40, 590 92 C 586 146, 444 166, 304 164 C 156 162, 26 138, 48 80"
                stroke="rgba(24, 212, 34, 0.28)" stroke-width="18" stroke-linecap="round" stroke-dasharray="1420" stroke-dashoffset="1420" style="filter:blur(8px)" />
              <path id="s9-oval-main" d="M 38 94 C 34 32, 184 14, 318 16 C 468 18, 594 40, 590 92 C 586 146, 444 166, 304 164 C 156 162, 26 138, 48 80"
                stroke="#18D422" stroke-width="5.5" stroke-linecap="round" stroke-dasharray="1420" stroke-dashoffset="1420" />
            </svg>
          </span>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- SCENE 10: Clean Minimalist Brand Sign-Off                           -->
    <!-- =================================================================== -->
    <div class="k-scene" id="sc-10">
      <div class="k-cam" id="cam-10">
        <div class="s10-center" id="s10-lockup">
          <svg class="s10-mark" viewBox="0 0 120 120" fill="none">
            <path d="M24 92 L64 28 L96 92" stroke="#0B0D0E" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M20 76 C48 62, 76 48, 102 28" stroke="#18D422" stroke-width="8" stroke-linecap="round" />
            <circle cx="102" cy="28" r="7" fill="#18D422" />
          </svg>
          <div class="s10-brand">BookReel</div>
          <div class="s10-cite">Motive Force &amp; Motivation Tracks · p. 114</div>
        </div>
      </div>
    </div>

    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${(t.duration - AUDIO_OFFSET - OUTRO_TAIL).toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    <audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${t.duration.toFixed(3)}" data-track-index="15" data-volume="1"></audio>
    <audio id="music" src="assets/music.wav" data-start="0" data-duration="${t.duration.toFixed(3)}" data-track-index="10" data-volume="0.18"></audio>
  </div>
</div>

<script id="timeline-spec" type="application/json">${payloadJson}</script>
<script>
(function () {
  var t = JSON.parse(document.getElementById("timeline-spec").textContent);
  var tl = gsap.timeline({ paused: true });

  function showWindow(id, start, end) {
    var el = document.getElementById(id);
    if (!el) return;
    gsap.set(el, { autoAlpha: start === 0 ? 1 : 0 });
    if (start > 0) tl.set(el, { autoAlpha: 1 }, start);
    if (end < t.duration) tl.set(el, { autoAlpha: 0 }, end);
  }

  function blurIn(id, at, dur, dy, scaleFrom) {
    var el = document.getElementById(id);
    if (!el) return;
    gsap.set(el, { autoAlpha: 0 });
    tl.fromTo(
      el,
      { autoAlpha: 0, y: dy == null ? 24 : dy, scale: scaleFrom == null ? 0.94 : scaleFrom, filter: "blur(12px)" },
      { autoAlpha: 1, y: 0, scale: 1, filter: "blur(0px)", duration: dur || 0.44, ease: "expo.out", immediateRender: false },
      at
    );
  }

  // Ambient bokeh gentle drift + visibility during Scene 1, Scene 4, Scene 8, Scene 9
  var bokehLayer = document.getElementById("bokeh-layer");
  gsap.set(bokehLayer, { autoAlpha: 0.9 });
  tl.to("#bokeh-tl", { x: 85, y: 65, duration: t.duration, ease: "none" }, 0);
  tl.to("#bokeh-br", { x: -80, y: -70, duration: t.duration, ease: "none" }, 0);

  // =========================================================================
  // SCENE 1: Kinetic Scale-Down Hook ("Want to know..." -> "Time how fast you choose")
  // =========================================================================
  showWindow("sc-1", 0, t.s2Start);
  gsap.set("#s1-partB", { autoAlpha: 0 });
  tl.fromTo("#s1-arc-tl", { scale: 0.7, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.7, ease: "expo.out" }, 0.05);
  tl.fromTo("#s1-arc-br", { scale: 0.7, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.7, ease: "expo.out" }, 0.12);
  tl.fromTo(
    "#s1-w1",
    { scale: 1.55, autoAlpha: 0, filter: "blur(14px)" },
    { scale: 1, autoAlpha: 1, filter: "blur(0px)", duration: 0.52, ease: "expo.out" },
    0.04
  );
  blurIn("s1-w2", 0.52, 0.48, 22, 0.92);

  // Swap Part A -> Part B ("Time how fast you choose.")
  tl.to("#s1-partA", { autoAlpha: 0, scale: 0.88, filter: "blur(10px)", duration: 0.28, ease: "power2.in" }, Math.max(0.9, t.s1SubSwap - 0.18));
  tl.fromTo(
    "#s1-partB",
    { autoAlpha: 0, scale: 1.18, filter: "blur(12px)" },
    { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.46, ease: "expo.out", immediateRender: false },
    t.s1SubSwap
  );
  tl.fromTo("#s1-g1", { autoAlpha: 0, y: 24 }, { autoAlpha: 0.9, y: -10, duration: 0.9, ease: "power2.out", immediateRender: false }, t.s1SubSwap + 0.18);
  tl.fromTo("#s1-g2", { autoAlpha: 0, y: -24 }, { autoAlpha: 0.9, y: 10, duration: 0.9, ease: "power2.out", immediateRender: false }, t.s1SubSwap + 0.26);
  tl.to("#cam-1", { scale: 0.9, autoAlpha: 0, filter: "blur(10px)", duration: 0.26, ease: "power2.in" }, t.s2Start - 0.26);

  // =========================================================================
  // SCENE 2: Macro Breguet Watch Dial + Sweeping Green Arc
  // =========================================================================
  var s2OverlapExit = 0.34;
  showWindow("sc-2", t.s2Start - 0.05, t.s3Start + s2OverlapExit);
  tl.fromTo(
    "#cam-2-in",
    { y: 180, scale: 1.06, autoAlpha: 0, filter: "blur(12px)" },
    { y: 0, scale: 1, autoAlpha: 1, filter: "blur(0px)", duration: 0.52, ease: "expo.out", immediateRender: false },
    t.s2Start - 0.05
  );
  tl.fromTo("#s2-arc", { strokeDashoffset: 1400 }, { strokeDashoffset: 0, duration: 1.15, ease: "power3.out", immediateRender: false }, t.s2Start + 0.05);
  blurIn("s2-nodes", t.s2Start + 0.28, 0.45, 0, 0.86);
  tl.fromTo(
    "#s2-hand",
    { rotation: -24 },
    { rotation: 34, duration: Math.max(0.8, t.s2End - t.s2Start), ease: "power1.inOut", immediateRender: false },
    t.s2Start
  );
  blurIn("s2-copy", t.s2Start + 0.22, 0.52, 30, 0.95);
  // Camera glides watch downward out of frame as Scene 3 enters from above (exact reference transition!)
  tl.to(
    "#cam-2",
    { y: 680, autoAlpha: 0, filter: "blur(10px)", duration: s2OverlapExit + 0.08, ease: "power2.in" },
    t.s3Start - 0.08
  );

  // =========================================================================
  // SCENE 3: Green L-Bracket Viewfinder + 5-Silhouette Focus Group
  // =========================================================================
  showWindow("sc-3", t.s3Start, t.s4Start);
  tl.fromTo("#vf-tl", { x: -40, y: -40, autoAlpha: 0 }, { x: 0, y: 0, autoAlpha: 1, duration: 0.42, ease: "expo.out", immediateRender: false }, t.s3Start);
  tl.fromTo("#vf-tr", { x: 40, y: -40, autoAlpha: 0 }, { x: 0, y: 0, autoAlpha: 1, duration: 0.42, ease: "expo.out", immediateRender: false }, t.s3Start + 0.04);
  tl.fromTo("#vf-bl", { x: -40, y: 40, autoAlpha: 0 }, { x: 0, y: 0, autoAlpha: 1, duration: 0.42, ease: "expo.out", immediateRender: false }, t.s3Start + 0.08);
  tl.fromTo("#vf-br", { x: 40, y: 40, autoAlpha: 0 }, { x: 0, y: 0, autoAlpha: 1, duration: 0.42, ease: "expo.out", immediateRender: false }, t.s3Start + 0.12);
  blurIn("s3-hdr", t.s3Start + 0.1, 0.46, -24, 0.94);
  blurIn("s3-people", t.s3Start + 0.2, 0.5, 28, 0.9);
  blurIn("s3-foot", t.s3Start + 0.34, 0.46, 20, 0.96);
  tl.to("#cam-3", { scale: 1.08, autoAlpha: 0, filter: "blur(10px)", duration: 0.26, ease: "power2.in" }, t.s4Start - 0.26);

  // =========================================================================
  // SCENE 4: Circular Neon Millisecond Ring Counter (840 -> 180 ms)
  // =========================================================================
  showWindow("sc-4", t.s4Start, t.s5Start);
  blurIn("s4-ring-box", t.s4Start, 0.45, 24, 0.85);
  blurIn("s4-lbl", t.s4Start + 0.18, 0.45, 20, 0.94);
  var s4CountDur = Math.max(0.5, t.s4End - t.s4Start - 0.35);
  tl.fromTo(
    "#s4-arc",
    { strokeDashoffset: 918 },
    { strokeDashoffset: 165, duration: s4CountDur, ease: "power3.out", immediateRender: false },
    t.s4Start + 0.08
  );
  var numEl = document.getElementById("s4-num");
  tl.fromTo(
    {},
    {},
    {
      duration: s4CountDur,
      ease: "none",
      immediateRender: false,
      onUpdate: function () {
        var p = Math.max(0, Math.min(1, (tl.time() - (t.s4Start + 0.08)) / s4CountDur));
        var eased = 1 - Math.pow(1 - p, 3);
        var val = Math.round(840 - (840 - 180) * eased);
        if (numEl) numEl.textContent = String(val);
      },
    },
    t.s4Start + 0.08
  );
  tl.to("#cam-4", { scale: 0.88, autoAlpha: 0, filter: "blur(10px)", duration: 0.24, ease: "power2.in" }, t.s5Start - 0.24);

  // =========================================================================
  // SCENE 5: Outlined "???" + "Hesitation signals doubt" + 3 Floating Cards
  // =========================================================================
  showWindow("sc-5", t.s5Start, t.s6Start);
  blurIn("s5-qmarks", t.s5Start, 0.45, 16, 0.88);
  blurIn("s5-headline", t.s5Start + 0.08, 0.48, 22, 0.93);
  blurIn("sc5-c1", t.s5Start + 0.18, 0.55, 36, 0.9);
  blurIn("sc5-c2", t.s5Start + 0.32, 0.55, 36, 0.9);
  blurIn("sc5-c3", t.s5Start + 0.46, 0.55, 36, 0.9);
  tl.to("#cam-5", { y: -40, autoAlpha: 0, filter: "blur(10px)", duration: 0.26, ease: "power2.in" }, t.s6Start - 0.26);

  // =========================================================================
  // SCENE 6: 3-Hexagon Honeycomb Callout Triad (1 -> 2 -> 3)
  // =========================================================================
  showWindow("sc-6", t.s6Start, t.s7Start);
  var hSpan = Math.max(1.2, t.s6End - t.s6Start);
  var hStep = Math.min(0.55, hSpan * 0.24);
  blurIn("hex-1", t.s6Start + 0.04, 0.46, 26, 0.76);
  tl.fromTo("#hline-1", { strokeDashoffset: 240 }, { strokeDashoffset: 0, duration: 0.36, ease: "power2.out", immediateRender: false }, t.s6Start + 0.22);
  blurIn("hlbl-1", t.s6Start + 0.28, 0.38, 12, 0.95);

  blurIn("hex-2", t.s6Start + hStep, 0.46, 26, 0.76);
  tl.fromTo("#hline-2", { strokeDashoffset: 240 }, { strokeDashoffset: 0, duration: 0.36, ease: "power2.out", immediateRender: false }, t.s6Start + hStep + 0.18);
  blurIn("hlbl-2", t.s6Start + hStep + 0.24, 0.38, 12, 0.95);

  blurIn("hex-3", t.s6Start + hStep * 2, 0.46, 26, 0.76);
  tl.fromTo("#hline-3", { strokeDashoffset: 240 }, { strokeDashoffset: 0, duration: 0.36, ease: "power2.out", immediateRender: false }, t.s6Start + hStep * 2 + 0.18);
  blurIn("hlbl-3", t.s6Start + hStep * 2 + 0.24, 0.38, 12, 0.95);

  tl.to("#cam-6", { scale: 0.92, autoAlpha: 0, filter: "blur(10px)", duration: 0.26, ease: "power2.in" }, t.s7Start - 0.26);

  // =========================================================================
  // SCENE 7: Minimalist Green Glow Words -> Editorial Italic Serif
  // =========================================================================
  showWindow("sc-7", t.s7Start, t.s8Start);
  gsap.set("#s7-serif", { autoAlpha: 0 });
  blurIn("s7-w1", t.s7Start, 0.42, 20, 0.94);
  tl.to("#s7-w1-exit", { autoAlpha: 0, filter: "blur(10px)", duration: 0.24, ease: "power2.in" }, Math.max(t.s7Start + 0.45, t.s7SerifAt - 0.18));
  tl.fromTo(
    "#s7-serif",
    { autoAlpha: 0, x: 26, filter: "blur(12px)" },
    { autoAlpha: 1, x: 0, filter: "blur(0px)", duration: 0.46, ease: "expo.out", immediateRender: false },
    t.s7SerifAt
  );
  tl.to("#cam-7", { autoAlpha: 0, filter: "blur(10px)", duration: 0.24, ease: "power2.in" }, t.s8Start - 0.24);

  // =========================================================================
  // SCENE 8: 6-Pill Staggered Cascade
  // =========================================================================
  showWindow("sc-8", t.s8Start, t.s9Start);
  var pSpan = Math.max(1.8, t.s8End - t.s8Start - 0.55);
  var pGap = pSpan / 6;
  for (var pi = 1; pi <= 6; pi++) {
    blurIn("pill-" + pi, t.s8Start + (pi - 1) * pGap, 0.42, 22, 0.88);
  }
  tl.to("#cam-8", { autoAlpha: 0, filter: "blur(14px)", scale: 0.96, duration: 0.32, ease: "power2.in" }, t.s9Start - 0.32);

  // =========================================================================
  // SCENE 9: Horizontal Camera-Pan Line + Hand-Drawn Glowing Green Oval
  // =========================================================================
  showWindow("sc-9", t.s9Start, t.s10Start);
  gsap.set("#s9-focus", { autoAlpha: 0 });
  // Start with "#s9-lead" centered, then pan left so "#s9-focus" ("Reach today.") sits dead-center!
  gsap.set("#s9-track", { xPercent: -50, yPercent: -50, x: 245 });
  tl.fromTo(
    "#s9-track",
    { xPercent: -50, yPercent: -50, x: 245 },
    { xPercent: -50, yPercent: -50, x: -210, duration: 0.62, ease: "expo.inOut", immediateRender: false },
    t.s9PanAt
  );
  blurIn("s9-lead", t.s9Start, 0.42, 18, 0.95);
  tl.to("#s9-lead", { color: "#9CA3AF", duration: 0.45, ease: "power2.out" }, t.s9PanAt);
  tl.fromTo(
    "#s9-focus",
    { autoAlpha: 0, filter: "blur(10px)", scale: 0.94 },
    { autoAlpha: 1, filter: "blur(0px)", scale: 1, duration: 0.46, ease: "expo.out", immediateRender: false },
    t.s9PanAt + 0.08
  );
  tl.fromTo("#s9-oval-glow", { strokeDashoffset: 1420 }, { strokeDashoffset: 0, duration: 0.72, ease: "power3.out", immediateRender: false }, t.s9PanAt + 0.22);
  tl.fromTo("#s9-oval-main", { strokeDashoffset: 1420 }, { strokeDashoffset: 0, duration: 0.72, ease: "power3.out", immediateRender: false }, t.s9PanAt + 0.22);
  tl.to("#cam-9", { autoAlpha: 0, filter: "blur(10px)", duration: 0.28, ease: "power2.in" }, t.s10Start - 0.28);

  // =========================================================================
  // SCENE 10: Clean Minimalist Brand Sign-Off
  // =========================================================================
  showWindow("sc-10", t.s10Start, t.duration);
  blurIn("s10-lockup", t.s10Start, 0.52, 20, 0.9);

  tl.set({}, {}, t.duration);
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>`;
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });

  try {
    const ep = await prisma.episode.findUnique({
      where: { id: EPISODE_ID },
      include: { book: true },
    });
    if (!ep) throw new Error(`Episode not found: ${EPISODE_ID}`);

    const parsed = JSON.parse(ep.script ?? "[]") as ContentPackage | Beat[];
    const beats: Beat[] = Array.isArray(parsed) ? parsed : parsed.beats ?? [];

    console.log(`\n======================================================`);
    console.log(`Rendering Clean White Kinetic Reference: ${SLUG}`);
    console.log(`Book: ${ep.book.title}`);
    console.log(`Episode: ${ep.title} (voice=${VOICE_ID})`);
    console.log(`======================================================`);

    const projDir = path.join(os.tmpdir(), "bookreel-proj", SLUG);
    const workDir = path.join(os.tmpdir(), "bookreel-work", SLUG);
    await fs.rm(projDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(projDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    // 1. Studio Voiceover + exact word-level timestamps via faster-whisper
    const voice = await synthesizeVoiceover(
      beats.map((b) => b.voiceover),
      workDir,
      VOICE_ID,
    );
    const timing = await timeNarration(voice, workDir);
    const totalVoice = voice.totalDuration;
    const duration = +(AUDIO_OFFSET + totalVoice + OUTRO_TAIL).toFixed(3);

    const b = timing.beats;
    // Map each beat's spoken boundaries onto composition timeline clock (+ AUDIO_OFFSET)
    const b0Start = 0;
    const b0End = +(AUDIO_OFFSET + b[0].end).toFixed(3);
    const b1Start = b0End;
    const b1End = +(AUDIO_OFFSET + b[1].end).toFixed(3);
    const b2Start = b1End;
    const b2End = +(AUDIO_OFFSET + b[2].end).toFixed(3);
    const b3Start = b2End;
    const b3End = +(AUDIO_OFFSET + b[3].end).toFixed(3);
    const b4Start = b3End;
    const b4End = +(AUDIO_OFFSET + b[4].end).toFixed(3);
    const b5Start = b4End;
    const b5End = +(AUDIO_OFFSET + totalVoice).toFixed(3);

    // Exact word-synced sub-scene split points!
    const s1SubSwap = findWordStart(timing.words, b[0].start, b[0].end, /^time$/i, 0.56);
    const s4Start = findWordStart(timing.words, b[2].start, b[2].end, /^(the|mind|still|snatches)$/i, 0.46);
    const s6Start = findWordStart(timing.words, b[3].start, b[3].end, /^(but|instant)$/i, 0.38);
    const s7SerifAt = findWordStart(timing.words, b[4].start, b[4].end, /^actual$/i, 0.34);
    const s8Start = findWordStart(timing.words, b[4].start, b[4].end, /^bypassing$/i, 0.54);
    const s9PanAt = findWordStart(timing.words, b[5].start, b[5].end, /^(reach|today)$/i, 0.52);

    const spec: TimelineSpec = {
      duration,
      s1Start: b0Start,
      s1SubSwap,
      s1End: b0End,
      s2Start: b1Start,
      s2End: b1End,
      s3Start: b2Start,
      s3End: s4Start,
      s4Start,
      s4End: b2End,
      s5Start: b3Start,
      s5End: s6Start,
      s6Start,
      s6End: b3End,
      s7Start: b4Start,
      s7SerifAt,
      s7End: s8Start,
      s8Start,
      s8End: b4End,
      s9Start: b5Start,
      s9PanAt,
      s9End: b5End + 0.35,
      s10Start: b5End + 0.35,
    };

    console.log("  [Word-Synced Scene Windows]", JSON.stringify(spec, null, 2));

    // 2. Subtle minimalist ambient score (-26 dB) + frame-accurate studio `sfx/` cues
    const musicPath = path.join(workDir, "music.wav");
    await generateCinematicScoreWav(duration, musicPath, {
      style: "editorial",
      voicePath: voice.audioPath,
      voiceOffsetSec: AUDIO_OFFSET,
      targetMeanDb: -26,
    });

    const lib = await loadProjectSfxLibrary();
    const sfxPlan: SelectiveLibrarySfxPlanItem[] = [
      { timeSec: spec.s1SubSwap, kind: "ui-click", role: "bento-ui", modelId: "white-kinetic", fileName: "SFX_01_05.wav", gainScale: 0.9, sceneIndex: 1 },
      { timeSec: spec.s2Start + 0.12, kind: "clock-tick", role: "chrono-gear", modelId: "white-kinetic", fileName: "SFX_01_08.wav", gainScale: 0.95, sceneIndex: 2 },
      { timeSec: spec.s3Start + 0.06, kind: "shutter-snap", role: "archival-shutter", modelId: "white-kinetic", fileName: "SFX_01_06.wav", gainScale: 0.85, sceneIndex: 3 },
      { timeSec: spec.s6Start + 0.08, kind: "ui-click", role: "vector-pop", modelId: "white-kinetic", fileName: "SFX_01_09.wav", gainScale: 0.95, sceneIndex: 6 },
      { timeSec: spec.s8Start + 0.05, kind: "card-pop", role: "bento-ui", modelId: "white-kinetic", fileName: "SFX_01_03.wav", gainScale: 0.9, sceneIndex: 8 },
      { timeSec: spec.s9PanAt + 0.18, kind: "scene-whoosh", role: "cinema-deep", modelId: "white-kinetic", fileName: "14 Quick Swing.wav", gainScale: 0.9, sceneIndex: 9 },
    ];
    const speechSpans = timing.words.map((w) => ({ start: w.start, end: w.end }));
    const sfxBuf = renderSelectiveLibrarySfxBuffer({
      durationSec: duration,
      plan: sfxPlan,
      library: lib,
      speechSpans,
      audioOffsetSec: AUDIO_OFFSET,
    });
    const sfxPath = path.join(workDir, "sfx.wav");
    await fs.writeFile(sfxPath, toWav(sfxBuf));

    // 3. Write HyperFrames project & render 1080×1920 (`--quality high`)
    const html = buildWhiteKineticHtml(spec, ep.book.title);
    await writeProject({
      dir: projDir,
      indexHtml: html,
      audioSource: voice.audioPath,
      musicSource: musicPath,
      sfxSource: sfxPath,
      assets: [],
    });

    const outMp4 = path.join(outDir, `${SLUG}.mp4`);
    const tmpMp4 = path.join(os.tmpdir(), `${SLUG}-${Date.now()}.mp4`);
    const t0 = Date.now();
    await renderProject(projDir, tmpMp4, "high", "local", 1);
    await fs.copyFile(tmpMp4, outMp4);
    await fs.rm(tmpMp4, { force: true }).catch(() => {});
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

    const st = await fs.stat(outMp4);
    console.log(
      `\n  [DONE] ${SLUG}.mp4 -> ${(st.size / (1024 * 1024)).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
