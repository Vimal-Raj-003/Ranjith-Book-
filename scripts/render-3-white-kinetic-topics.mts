/**
 * 100% Local BookReel ("YT Book") — 3-TOPIC MULTI-PATTERN CLEAN WHITE KINETIC RUNNER.
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini / external calls).
 * Renders 3 distinct book topics from the user's BookReel database in the 100%-approved
 * Clean White Minimalist Kinetic Motion aesthetic (`#FFFFFF` canvas, `Inter` + italic
 * `Instrument Serif`, directional `blur(12px) -> blur(0px)` exponential choreography,
 * matched `sfx/` studio foley, 18% subtle ambient bed), while giving EACH video its own
 * distinct accent palette, Studio Voice, and 100% non-repeating motion patterns:
 *
 *   1. `kinetic-1-doing-less-work.mp4` (Electric Cobalt `#146EF5` · Voice: `george` · 6 beats)
 *      Book: How to Live on 24 Hours a Day — "The Fastest Productivity Gain Is Doing Less Work"
 *      Patterns: Strikeout Hook, Live To-Do Strike-Through Card, Cascading Meeting Modals,
 *                Dual Capacity Bars, Floating 24H Book Proof Cards, Tactile Delete Keycap,
 *                Horizontal Pan + Hand-Drawn Cobalt Brush Underline.
 *
 *   2. `kinetic-2-pay-and-perks.mp4` (Editorial Vermilion-Coral `#F04424` · Voice: `stuart_bell` · 6 beats)
 *      Book: Personnel Motivation & Management — "Why Pay and Perks Don't Actually Motivate"
 *      Patterns: Rising Dollar Counter + Flatline ECG, Sliding X-Ray Magnifier Lens,
 *                -100..0..+100 Equilibrium Axis Needle, Floating Study Cards + Outlined "%",
 *                3-Diamond Ascending Triad + Leader Lines, Editorial Serif Reveal,
 *                Horizontal Pan + Hand-Drawn Coral Frame Highlight.
 *
 *   3. `kinetic-3-divided-attention.mp4` (Royal Electric Violet `#6D28D9` · Voice: `charles` · 5 beats)
 *      Book: The Psychology of Success — "Why Studying 20 Times With Divided Attention Fails"
 *      Patterns: 20x Ghost-Stamp Dissolve Hook, 3-Way Scattered Attention Ray Splitter,
 *                Laser Lens Focal Converger (100% Retention), Shallow vs Deep Memory Groove Wave,
 *                Archival Book Card + Staggered Violet Pill Cascade,
 *                Horizontal Pan + Hand-Drawn Violet Double-Loop Highlight.
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

const AUDIO_OFFSET = 0.45;
const OUTRO_TAIL = 2.0;
const FPS = 30;

interface TopicTarget {
  episodeId: string;
  slug: string;
  voiceId: string;
  accent: string;
  accentSoft: string;
  musicStyle: string;
}

const TOPICS: ReadonlyArray<TopicTarget> = [
  {
    episodeId: "cmuusv2jm00djn60k9y3h3u8o",
    slug: "kinetic-1-doing-less-work",
    voiceId: "george",
    accent: "#146EF5",
    accentSoft: "rgba(20, 110, 245, 0.16)",
    musicStyle: "editorial",
  },
  {
    episodeId: "cmvxeqjw5000fn618kuud616e",
    slug: "kinetic-2-pay-and-perks",
    voiceId: "stuart_bell",
    accent: "#F04424",
    accentSoft: "rgba(240, 68, 36, 0.15)",
    musicStyle: "blueprint",
  },
  {
    episodeId: "cmw4tl8ox000fn6dg1ghepxhl",
    slug: "kinetic-3-divided-attention",
    voiceId: "charles",
    accent: "#6D28D9",
    accentSoft: "rgba(109, 40, 217, 0.15)",
    musicStyle: "terminal",
  },
];

function findWordTime(
  words: TimedWord[],
  winStart: number,
  winEnd: number,
  regex: RegExp,
  fallbackRatio: number,
): number {
  const hit = words.find(
    (w) => w.start >= winStart - 0.08 && w.start <= winEnd + 0.08 && regex.test(w.word),
  );
  if (hit) return +(AUDIO_OFFSET + hit.start).toFixed(3);
  return +(AUDIO_OFFSET + winStart + (winEnd - winStart) * fallbackRatio).toFixed(3);
}

function baseHeadAndStyles(title: string, accent: string, accentSoft: string, extraCss: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${title.replace(/[<>&"]/g, "")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  :root {
    --acc: ${accent};
    --acc-soft: ${accentSoft};
  }
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
    position: relative; width: 1080px; height: 1920px; overflow: hidden;
    background: radial-gradient(92% 74% at 50% 48%, #FFFFFF 0%, #FAFAFC 100%);
  }
  .clip { position: absolute; inset: 0; }
  .bokeh-layer { position: absolute; inset: 0; pointer-events: none; opacity: 0.92; }
  .bokeh-ring {
    position: absolute; border-radius: 50%;
    border: 46px solid var(--acc-soft);
    filter: blur(28px);
  }
  .bokeh-tl { width: 540px; height: 540px; left: -170px; top: -130px; }
  .bokeh-br { width: 500px; height: 500px; left: 730px; top: 1500px; }

  .k-scene { position: absolute; inset: 0; opacity: 0; visibility: hidden; pointer-events: none; }
  .k-cam { position: absolute; inset: 0; transform-origin: 50% 50%; }
  .serif-it {
    font-family: "Instrument Serif", Georgia, "Times New Roman", serif;
    font-style: italic; font-weight: 400; letter-spacing: -0.01em;
  }
  .txt-acc { color: var(--acc); }
  .acc-aura { text-shadow: 0 0 42px var(--acc-soft); }

  .white-card {
    background: #FFFFFF;
    border: 1.5px solid #E5E7EB;
    border-radius: 28px;
    box-shadow: 0 24px 56px rgba(11, 13, 14, 0.07), 0 4px 14px rgba(11, 13, 14, 0.03);
  }
  .k-pill {
    display: inline-flex; align-items: center; justify-content: center;
    height: 96px; padding: 0 44px; border-radius: 999px;
    font-size: 38px; font-weight: 500; letter-spacing: -0.025em; white-space: nowrap;
  }
  .k-pill-acc { background: var(--acc); color: #FFFFFF; box-shadow: 0 14px 34px var(--acc-soft); }
  .k-pill-out { background: #FFFFFF; color: #0B0D0E; border: 2.5px solid #0B0D0E; }

  .pan-track {
    position: absolute; left: 540px; top: 960px;
    display: flex; align-items: center; gap: 28px;
    white-space: nowrap;
  }
  .pan-lead { font-size: 54px; font-weight: 500; letter-spacing: -0.03em; color: #0B0D0E; }
  .pan-focus { position: relative; display: inline-flex; align-items: center; padding: 22px 44px; }
  .pan-payoff { font-size: 80px; font-weight: 600; letter-spacing: -0.04em; color: #0B0D0E; }

  .signoff-center {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center;
  }
  .signoff-brand { font-size: 44px; font-weight: 600; letter-spacing: -0.03em; color: #0B0D0E; margin-top: 16px; }
  .signoff-cite { font-size: 22px; color: #6B7280; margin-top: 8px; }
  ${extraCss}
</style>
</head>`;
}

const GSAP_HELPERS_JS = `
  function showWindow(id, start, end, totalDur) {
    var el = document.getElementById(id);
    if (!el) return;
    gsap.set(el, { autoAlpha: start === 0 ? 1 : 0 });
    if (start > 0) tl.set(el, { autoAlpha: 1 }, start);
    if (end < totalDur) tl.set(el, { autoAlpha: 0 }, end);
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
  function exitCam(id, at, dur, dy, scaleTo) {
    tl.to("#" + id, {
      y: dy == null ? 0 : dy,
      scale: scaleTo == null ? 0.94 : scaleTo,
      autoAlpha: 0,
      filter: "blur(11px)",
      duration: dur || 0.26,
      ease: "power2.in"
    }, at);
  }
`;

// ============================================================================
// VIDEO 1 BUILDER: Electric Cobalt (#146EF5) — "Doing Less Work" (Arnold Bennett)
// ============================================================================
function buildVideo1Html(
  target: TopicTarget,
  beats: Array<{ start: number; end: number }>,
  words: TimedWord[],
  duration: number,
  voiceDur: number,
): { html: string; sfxMoments: Array<{ t: number; file: string; kind: SelectiveLibrarySfxPlanItem["kind"]; role: SelectiveLibrarySfxPlanItem["role"] }> } {
  const b0e = +(AUDIO_OFFSET + beats[0].end).toFixed(3);
  const b1e = +(AUDIO_OFFSET + beats[1].end).toFixed(3);
  const b2e = +(AUDIO_OFFSET + beats[2].end).toFixed(3);
  const b3e = +(AUDIO_OFFSET + beats[3].end).toFixed(3);
  const b4e = +(AUDIO_OFFSET + beats[4].end).toFixed(3);
  const b5e = +(AUDIO_OFFSET + voiceDur).toFixed(3);

  const s1AskAt = findWordTime(words, beats[0].start, beats[0].end, /^ask$/i, 0.52);
  const s3ShaveAt = findWordTime(words, beats[2].start, beats[2].end, /^shaving$/i, 0.55);
  const s4GoalAt = findWordTime(words, beats[3].start, beats[3].end, /^(real|goal|capacity)$/i, 0.52);
  const s5DeleteAt = findWordTime(words, beats[4].start, beats[4].end, /^delete$/i, 0.42);
  const s6End = Math.min(duration - 0.8, b5e + 0.4);

  const t = { duration, b0e, b1e, b2e, b3e, b4e, b5e, s1AskAt, s3ShaveAt, s4GoalAt, s5DeleteAt, s6End };

  const extraCss = `
    /* Scene 1: Strikeout Hook + Crosshair Grid */
    .v1-cross-tl, .v1-cross-br { position:absolute; width:90px; height:90px; pointer-events:none; }
    .v1-cross-tl { left:86px; top:160px; border-left:3px solid var(--acc); border-top:3px solid var(--acc); }
    .v1-cross-br { right:86px; bottom:160px; border-right:3px solid var(--acc); border-bottom:3px solid var(--acc); }
    .v1-s1-box { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:940px; text-align:center; }
    .v1-s1-top { font-size:74px; font-weight:600; letter-spacing:-0.038em; line-height:1.1; }
    .v1-strike-wrap { position:relative; display:inline-block; padding:0 8px; }
    .v1-strike-bar {
      position:absolute; left:0; top:54%; width:100%; height:9px; border-radius:6px;
      background:var(--acc); transform-origin:left center; transform:scaleX(0);
    }
    .v1-s1-serif { font-size:88px; margin-top:14px; }
    .v1-s1-ask { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:900px; text-align:center; font-size:62px; font-weight:500; letter-spacing:-0.03em; line-height:1.2; }

    /* Scene 2: Live To-Do Checklist Card */
    .todo-card { position:absolute; left:90px; top:480px; width:900px; padding:44px 48px; }
    .todo-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:30px; }
    .todo-title { font-size:30px; font-weight:600; letter-spacing:-0.02em; }
    .todo-badge { background:var(--acc-soft); color:var(--acc); padding:10px 22px; border-radius:999px; font-size:22px; font-weight:600; }
    .todo-row { position:relative; display:flex; align-items:center; gap:22px; padding:24px 18px; border-bottom:1.5px solid #F1F5F9; font-size:34px; font-weight:500; }
    .todo-row:last-child { border-bottom:none; }
    .todo-chk { width:38px; height:38px; border-radius:11px; border:2.5px solid #CBD5E1; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
    .todo-chk-keep { background:var(--acc); border-color:var(--acc); color:#FFF; font-size:22px; font-weight:700; }
    .todo-slash { position:absolute; left:72px; right:36px; top:52%; height:5px; background:var(--acc); border-radius:4px; transform-origin:left center; transform:scaleX(0); }
    .todo-cap { position:absolute; left:50%; top:1350px; transform:translateX(-50%); width:860px; text-align:center; font-size:48px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 3: Cascading Meeting Modals */
    .cal-modal { position:absolute; width:740px; padding:34px 38px; }
    .cal-dots { display:flex; gap:10px; margin-bottom:18px; }
    .cal-dot { width:14px; height:14px; border-radius:50%; background:#E2E8F0; }
    .cal-dot-b { background:var(--acc); }
    .cal-time { font-size:22px; font-weight:600; color:var(--acc); text-transform:uppercase; letter-spacing:0.06em; }
    .cal-name { font-size:38px; font-weight:600; letter-spacing:-0.025em; margin-top:6px; }
    .cal-sub { font-size:24px; color:#64748B; margin-top:6px; }
    #cal-1 { left:110px; top:420px; filter:blur(2px); opacity:0.8; }
    #cal-2 { left:170px; top:650px; filter:blur(1px); opacity:0.9; }
    #cal-3 { left:230px; top:880px; border-color:var(--acc); border-width:2.5px; }
    .cal-foot { position:absolute; left:50%; top:1290px; transform:translateX(-50%); width:880px; text-align:center; font-size:50px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 4: Dual Capacity Vessel Bars + Floating 24H Quote Cards */
    .cap-wrap { position:absolute; left:90px; top:420px; width:900px; height:760px; display:flex; align-items:flex-end; justify-content:center; gap:90px; }
    .cap-col { width:310px; text-align:center; }
    .cap-vessel { width:310px; height:540px; border-radius:36px; border:2.5px solid #E2E8F0; padding:18px; display:flex; flex-direction:column; justify-content:flex-end; gap:12px; background:#FFFFFF; overflow:hidden; }
    .cap-vessel-acc { border-color:var(--acc); box-shadow:0 24px 60px var(--acc-soft); }
    .cap-block-grey { height:76px; border-radius:18px; background:#E2E8F0; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:500; color:#64748B; }
    .cap-block-acc { height:360px; border-radius:22px; background:var(--acc); color:#FFFFFF; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px; transform-origin:bottom center; }
    .cap-col-lbl { margin-top:24px; font-size:32px; font-weight:500; letter-spacing:-0.02em; }
    .cap-foot { position:absolute; left:50%; top:1290px; transform:translateX(-50%); width:900px; text-align:center; font-size:58px; }

    /* Scene 5: Tactile Delete Keycap + Floating Arnold Bennett Card */
    .wmark-24 { position:absolute; left:50%; top:34%; transform:translate(-50%,-50%); font-size:280px; font-weight:700; color:transparent; -webkit-text-stroke:3.5px var(--acc-soft); }
    .bennett-card { position:absolute; left:140px; top:360px; width:800px; padding:32px 38px; }
    .keycap-outer {
      position:absolute; left:50%; top:980px; transform:translate(-50%,-50%);
      width:380px; height:210px; border-radius:40px;
      background:#E2E8F0; padding-bottom:18px;
      box-shadow:0 30px 60px rgba(20,110,245,0.18);
    }
    .keycap-top {
      width:100%; height:100%; border-radius:36px;
      background:#FFFFFF; border:3px solid var(--acc);
      display:flex; align-items:center; justify-content:center; gap:18px;
      font-size:52px; font-weight:600; letter-spacing:-0.03em; color:var(--acc);
    }
    .keycap-caption { position:absolute; left:50%; top:1220px; transform:translateX(-50%); width:880px; text-align:center; font-size:54px; font-weight:500; letter-spacing:-0.03em; }
  `;

  const html = `${baseHeadAndStyles("The Fastest Productivity Gain Is Doing Less Work", target.accent, target.accentSoft, extraCss)}
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    <div class="bokeh-layer">
      <div class="bokeh-ring bokeh-tl" id="bokeh-tl"></div>
      <div class="bokeh-ring bokeh-br" id="bokeh-br"></div>
    </div>

    <!-- SCENE 1: Strikeout Hook -->
    <div class="k-scene" id="sc-1">
      <div class="k-cam" id="cam-1">
        <div class="v1-cross-tl" id="v1-ctl"></div>
        <div class="v1-cross-br" id="v1-cbr"></div>
        <div id="v1-s1a-exit" style="position:absolute;inset:0;">
          <div class="v1-s1-box" id="v1-s1a">
            <div class="v1-s1-top">Speeding up <span class="v1-strike-wrap">wrong work<span class="v1-strike-bar" id="v1-sbar"></span></span></div>
            <div class="v1-s1-serif serif-it txt-acc acc-aura" id="v1-s1-sub">is just failing faster.</div>
          </div>
        </div>
        <div class="v1-s1-ask" id="v1-s1b">Ask what could <span class="txt-acc">vanish from your list</span><br/>without anyone noticing.</div>
      </div>
    </div>

    <!-- SCENE 2: Live To-Do Strike-Through Card -->
    <div class="k-scene" id="sc-2">
      <div class="k-cam" id="cam-2">
        <div class="white-card todo-card" id="todo-card">
          <div class="todo-hdr">
            <span class="todo-title">Today's Unquestioned List</span>
            <span class="todo-badge">CUT 75% NOISE</span>
          </div>
          <div class="todo-row" id="tr-1"><div class="todo-chk"></div><span>Routine status report nobody reads</span><div class="todo-slash" id="ts-1"></div></div>
          <div class="todo-row" id="tr-2"><div class="todo-chk"></div><span>Polishing low-impact slides</span><div class="todo-slash" id="ts-2"></div></div>
          <div class="todo-row" id="tr-3"><div class="todo-chk"></div><span>Habitual check-in sync</span><div class="todo-slash" id="ts-3"></div></div>
          <div class="todo-row" id="tr-4"><div class="todo-chk todo-chk-keep">✓</div><span class="txt-acc" style="font-weight:600">One task that moves the needle</span></div>
        </div>
        <div class="todo-cap" id="todo-cap">Removing work beats <span class="serif-it txt-acc" style="font-size:64px">grinding harder.</span></div>
      </div>
    </div>

    <!-- SCENE 3: Cascading Meeting Modals -->
    <div class="k-scene" id="sc-3">
      <div class="k-cam" id="cam-3">
        <div class="white-card cal-modal" id="cal-1">
          <div class="cal-dots"><span class="cal-dot"></span><span class="cal-dot"></span><span class="cal-dot"></span></div>
          <div class="cal-time">10:00 AM · Calendar</div>
          <div class="cal-name">Weekly Sync Meeting</div>
          <div class="cal-sub">Outcome: No clear decision reached</div>
        </div>
        <div class="white-card cal-modal" id="cal-2">
          <div class="cal-dots"><span class="cal-dot"></span><span class="cal-dot"></span><span class="cal-dot"></span></div>
          <div class="cal-time">02:00 PM · Spawned</div>
          <div class="cal-name">Follow-Up Alignment</div>
          <div class="cal-sub">Discussing morning sync notes</div>
        </div>
        <div class="white-card cal-modal" id="cal-3">
          <div class="cal-dots"><span class="cal-dot cal-dot-b"></span><span class="cal-dot"></span><span class="cal-dot"></span></div>
          <div class="cal-time">04:30 PM · Trap</div>
          <div class="cal-name">Shaving Minutes Off Zero</div>
          <div class="cal-sub">Optimizing a task that shouldn't exist</div>
        </div>
        <div class="cal-foot" id="cal-foot">Meetings without results <span class="txt-acc">breed more meetings.</span></div>
      </div>
    </div>

    <!-- SCENE 4: Dual Capacity Vessels -->
    <div class="k-scene" id="sc-4">
      <div class="k-cam" id="cam-4">
        <div class="cap-wrap">
          <div class="cap-col" id="cap-left">
            <div class="cap-vessel">
              <div class="cap-block-grey">Urgent noise</div>
              <div class="cap-block-grey">Busywork</div>
              <div class="cap-block-grey">Extra calls</div>
              <div class="cap-block-grey"> Packed gaps</div>
              <div class="cap-block-grey">Zero margin</div>
            </div>
            <div class="cap-col-lbl" style="color:#64748B">Packed Busyness</div>
          </div>
          <div class="cap-col" id="cap-right">
            <div class="cap-vessel cap-vessel-acc">
              <div class="cap-block-acc" id="cap-fill">
                <div style="font-size:68px;font-weight:700;letter-spacing:-0.04em">100%</div>
                <div style="font-size:26px;opacity:0.92;margin-top:8px"> Mental Space</div>
              </div>
            </div>
            <div class="cap-col-lbl txt-acc" style="font-weight:600">True Capacity ✓</div>
          </div>
        </div>
        <div class="cap-foot serif-it" id="cap-foot">Capacity for <span class="txt-acc">what actually matters.</span></div>
      </div>
    </div>

    <!-- SCENE 5: Floating Book Quote Card + Tactile Delete Keycap -->
    <div class="k-scene" id="sc-5">
      <div class="k-cam" id="cam-5">
        <div class="wmark-24" id="wmark-24">24H</div>
        <div class="white-card bennett-card" id="bennett-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <span style="font-size:22px;font-weight:600;color:var(--acc)">HOW TO LIVE ON 24 HOURS A DAY · P. 54</span>
            <span style="color:var(--acc);font-size:20px;font-weight:700">★★★★★</span>
          </div>
          <div style="font-size:26px;line-height:1.42;color:#1E293B">“Before adding anything new to an already crowded day, ask which habitual obligation has lost its reason to exist.”</div>
        </div>
        <div class="keycap-outer" id="keycap-box">
          <div class="keycap-top" id="keycap-face"><span>Delete</span><span>⌫</span></div>
        </div>
        <div class="keycap-caption" id="keycap-cap">Before adding today — <span class="txt-acc" style="font-weight:600">delete one thing.</span></div>
      </div>
    </div>

    <!-- SCENE 6: Horizontal Camera Pan + Hand-Drawn Cobalt Underline -->
    <div class="k-scene" id="sc-6">
      <div class="k-cam" id="cam-6">
        <div class="pan-track" id="v1-pan">
          <span class="pan-lead" id="v1-plead">When the day is loud</span>
          <span class="pan-focus" id="v1-pfocus">
            <span class="pan-payoff">Do less, better.</span>
            <svg viewBox="0 0 600 44" width="600" height="44" fill="none" style="position:absolute;left:18px;bottom:-6px;overflow:visible">
              <path id="v1-uline" d="M 8 24 C 160 8, 410 10, 588 22 C 430 34, 210 36, 64 34" stroke="#146EF5" stroke-width="7" stroke-linecap="round" stroke-dasharray="1160" stroke-dashoffset="1160" style="filter:drop-shadow(0 6px 16px rgba(20,110,245,0.35))" />
            </svg>
          </span>
        </div>
      </div>
    </div>

    <!-- SCENE 7: Clean Sign-Off -->
    <div class="k-scene" id="sc-7">
      <div class="k-cam" id="cam-7">
        <div class="signoff-center" id="v1-sign">
          <svg width="108" height="108" viewBox="0 0 120 120" fill="none" style="margin:0 auto">
            <rect x="20" y="20" width="80" height="80" rx="22" stroke="#0B0D0E" stroke-width="8" />
            <path d="M42 62 L56 76 L82 44" stroke="#146EF5" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <div class="signoff-brand">BookReel</div>
          <div class="signoff-cite">How to Live on 24 Hours a Day · Arnold Bennett · p. 54</div>
        </div>
      </div>
    </div>

    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${voiceDur.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    <audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="15" data-volume="1"></audio>
    <audio id="music" src="assets/music.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="10" data-volume="0.18"></audio>
  </div>
</div>
<script id="spec" type="application/json">${JSON.stringify(t)}</script>
<script>
(function () {
  var t = JSON.parse(document.getElementById("spec").textContent);
  var tl = gsap.timeline({ paused: true });
  ${GSAP_HELPERS_JS}

  tl.to("#bokeh-tl", { x: 90, y: 70, duration: t.duration, ease: "none" }, 0);
  tl.to("#bokeh-br", { x: -85, y: -65, duration: t.duration, ease: "none" }, 0);

  // Scene 1
  showWindow("sc-1", 0, t.b0e, t.duration);
  gsap.set("#v1-s1b", { autoAlpha: 0 });
  blurIn("v1-ctl", 0.05, 0.5, -16, 0.85);
  blurIn("v1-cbr", 0.1, 0.5, 16, 0.85);
  blurIn("v1-s1a", 0.04, 0.48, 22, 1.25);
  blurIn("v1-s1-sub", 0.45, 0.48, 20, 0.94);
  tl.to("#v1-sbar", { scaleX: 1, duration: 0.42, ease: "expo.out" }, 0.65);
  tl.to("#v1-s1a-exit", { autoAlpha: 0, filter: "blur(10px)", duration: 0.24, ease: "power2.in" }, Math.max(1.2, t.s1AskAt - 0.2));
  blurIn("v1-s1b", t.s1AskAt, 0.46, 24, 0.94);
  exitCam("cam-1", t.b0e - 0.26, 0.26, -24, 0.94);

  // Scene 2: To-Do Strikeout
  showWindow("sc-2", t.b0e, t.b1e, t.duration);
  blurIn("todo-card", t.b0e, 0.5, 34, 0.92);
  blurIn("todo-cap", t.b0e + 0.22, 0.48, 20, 0.95);
  var s2Span = Math.max(1.5, t.b1e - t.b0e - 0.6);
  tl.to("#ts-1", { scaleX: 1, duration: 0.36, ease: "expo.out" }, t.b0e + s2Span * 0.22);
  tl.to("#tr-1", { opacity: 0.38, duration: 0.3 }, t.b0e + s2Span * 0.32);
  tl.to("#ts-2", { scaleX: 1, duration: 0.36, ease: "expo.out" }, t.b0e + s2Span * 0.48);
  tl.to("#tr-2", { opacity: 0.38, duration: 0.3 }, t.b0e + s2Span * 0.58);
  tl.to("#ts-3", { scaleX: 1, duration: 0.36, ease: "expo.out" }, t.b0e + s2Span * 0.72);
  tl.to("#tr-3", { opacity: 0.38, duration: 0.3 }, t.b0e + s2Span * 0.82);
  exitCam("cam-2", t.b1e - 0.26, 0.26, -30, 0.94);

  // Scene 3: Cascading Meeting Modals
  showWindow("sc-3", t.b1e, t.b2e, t.duration);
  blurIn("cal-1", t.b1e + 0.04, 0.46, 30, 0.9);
  blurIn("cal-2", t.b1e + 0.52, 0.46, 34, 0.9);
  blurIn("cal-3", Math.max(t.b1e + 1.0, t.s3ShaveAt - 0.1), 0.48, 38, 0.92);
  blurIn("cal-foot", t.b1e + 0.3, 0.48, 20, 0.95);
  exitCam("cam-3", t.b2e - 0.26, 0.26, 30, 0.92);

  // Scene 4: Dual Capacity Vessels
  showWindow("sc-4", t.b2e, t.b3e, t.duration);
  blurIn("cap-left", t.b2e + 0.05, 0.48, 30, 0.92);
  blurIn("cap-right", t.b2e + 0.35, 0.52, 30, 0.92);
  gsap.set("#cap-fill", { scaleY: 0.1 });
  tl.fromTo("#cap-fill", { scaleY: 0.1 }, { scaleY: 1, duration: 0.78, ease: "expo.out", immediateRender: false }, t.b2e + 0.55);
  blurIn("cap-foot", t.b2e + 0.68, 0.48, 22, 0.95);
  exitCam("cam-4", t.b3e - 0.26, 0.26, -24, 0.94);

  // Scene 5: 24H Quote + Tactile Delete Keycap
  showWindow("sc-5", t.b3e, t.b4e, t.duration);
  blurIn("wmark-24", t.b3e, 0.5, 16, 0.9);
  blurIn("bennett-card", t.b3e + 0.08, 0.5, 28, 0.92);
  blurIn("keycap-box", Math.max(t.b3e + 0.4, t.s5DeleteAt - 0.25), 0.48, 34, 0.86);
  // Tactile key press down & release on #keycap-face
  tl.fromTo("#keycap-face", { y: 0 }, { y: 14, duration: 0.14, yoyo: true, repeat: 1, ease: "power2.inOut", immediateRender: false }, t.s5DeleteAt + 0.15);
  blurIn("keycap-cap", t.s5DeleteAt, 0.46, 20, 0.95);
  exitCam("cam-5", t.b4e - 0.26, 0.26, 0, 0.92);

  // Scene 6: Horizontal Pan + Cobalt Brush Underline
  showWindow("sc-6", t.b4e, t.s6End, t.duration);
  var panMoment = t.b4e + Math.max(0.45, (t.b5e - t.b4e) * 0.42);
  gsap.set("#v1-pan", { xPercent: -50, yPercent: -50, x: 260 });
  gsap.set("#v1-pfocus", { autoAlpha: 0 });
  blurIn("v1-plead", t.b4e + 0.04, 0.4, 18, 0.95);
  tl.fromTo("#v1-pan", { xPercent: -50, yPercent: -50, x: 260 }, { xPercent: -50, yPercent: -50, x: -215, duration: 0.62, ease: "expo.inOut", immediateRender: false }, panMoment);
  tl.to("#v1-plead", { color: "#9CA3AF", duration: 0.4 }, panMoment);
  blurIn("v1-pfocus", panMoment + 0.08, 0.46, 0, 0.94);
  tl.fromTo("#v1-uline", { strokeDashoffset: 1160 }, { strokeDashoffset: 0, duration: 0.72, ease: "power3.out", immediateRender: false }, panMoment + 0.22);
  exitCam("cam-6", t.s6End - 0.25, 0.25, 0, 0.95);

  // Scene 7: Sign-Off
  showWindow("sc-7", t.s6End, t.duration, t.duration);
  blurIn("v1-sign", t.s6End, 0.5, 20, 0.9);

  tl.set({}, {}, t.duration);
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>`;

  return {
    html,
    sfxMoments: [
      { t: 0.65, file: "SFX_01_01.wav", kind: "marker-swish", role: "paper-slide" },
      { t: +(b0e + 0.45).toFixed(3), file: "SFX_01_02.wav", kind: "ui-click", role: "dossier-stamp" },
      { t: +(b1e + 0.52).toFixed(3), file: "SFX_01_05.wav", kind: "card-pop", role: "bento-ui" },
      { t: +(Math.max(b2e + 0.55, s4GoalAt)).toFixed(3), file: "SFX_01_03.wav", kind: "card-pop", role: "bento-ui" },
      { t: +(s5DeleteAt + 0.15).toFixed(3), file: "SFX_01_07.wav", kind: "ui-click", role: "archival-shutter" },
      { t: +(b4e + 0.65).toFixed(3), file: "14 Quick Swing.wav", kind: "scene-whoosh", role: "cinema-deep" },
    ],
  };
}

// ============================================================================
// VIDEO 2 BUILDER: Editorial Vermilion-Coral (#F04424) — "Pay & Perks Myth"
// ============================================================================
function buildVideo2Html(
  target: TopicTarget,
  beats: Array<{ start: number; end: number }>,
  words: TimedWord[],
  duration: number,
  voiceDur: number,
): { html: string; sfxMoments: Array<{ t: number; file: string; kind: SelectiveLibrarySfxPlanItem["kind"]; role: SelectiveLibrarySfxPlanItem["role"] }> } {
  const b0e = +(AUDIO_OFFSET + beats[0].end).toFixed(3);
  const b1e = +(AUDIO_OFFSET + beats[1].end).toFixed(3);
  const b2e = +(AUDIO_OFFSET + beats[2].end).toFixed(3);
  const b3e = +(AUDIO_OFFSET + beats[3].end).toFixed(3);
  const b4e = +(AUDIO_OFFSET + beats[4].end).toFixed(3);
  const b5e = +(AUDIO_OFFSET + voiceDur).toFixed(3);
  const s6End = Math.min(duration - 0.8, b5e + 0.4);
  const s6PanAt = findWordTime(words, beats[5].start, beats[5].end, /^(focus|meaningful|responsibility)$/i, 0.54);

  const t = { duration, b0e, b1e, b2e, b3e, b4e, b5e, s6PanAt, s6End };

  const extraCss = `
    /* Scene 1: Rising Dollar Counter + Flatline Motivation ECG */
    .v2-s1-wrap { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:900px; text-align:center; }
    .v2-money { font-size:116px; font-weight:600; letter-spacing:-0.045em; color:#0B0D0E; }
    .v2-kicker { font-size:30px; font-weight:500; color:#6B7280; margin-top:-6px; margin-bottom:36px; }
    .v2-ecg-card { width:820px; margin:0 auto; padding:32px 36px; }
    .v2-s1-foot { margin-top:36px; font-size:58px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 2: X-Ray Magnifying Lens Reveal */
    .v2-s2-wrap { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:920px; text-align:center; }
    .xray-pill-top { display:inline-block; padding:18px 40px; border-radius:999px; border:2px dashed #CBD5E1; color:#64748B; font-size:34px; margin-bottom:34px; }
    .xray-lens { width:780px; margin:0 auto; padding:48px 44px; border:3px solid var(--acc); border-radius:40px; background:#FFFFFF; box-shadow:0 28px 64px var(--acc-soft); }
    .xray-tag { font-size:22px; font-weight:700; letter-spacing:0.1em; color:var(--acc); text-transform:uppercase; }
    .xray-big { font-size:74px; font-weight:600; letter-spacing:-0.035em; margin-top:10px; }
    .xray-sub { font-size:30px; color:#4B5563; margin-top:12px; }

    /* Scene 3: -100 .. 0 .. +100 Equilibrium Axis + Floating Study Cards */
    .axis-card { position:absolute; left:80px; top:430px; width:920px; padding:46px 46px; }
    .axis-labels { display:flex; justify-content:space-between; font-size:24px; font-weight:600; color:#64748B; margin-bottom:26px; }
    .axis-track { position:relative; height:22px; border-radius:999px; background:#F1F5F9; }
    .axis-neg-bar { position:absolute; right:50%; top:0; width:42%; height:100%; border-radius:999px 0 0 999px; background:var(--acc); transform-origin:right center; }
    .axis-zero { position:absolute; left:50%; top:-18px; width:4px; height:58px; background:#0B0D0E; }
    .axis-needle { position:absolute; left:50%; top:-14px; width:50px; height:50px; margin-left:-25px; border-radius:50%; background:#FFFFFF; border:6px solid #0B0D0E; box-shadow:0 8px 20px rgba(0,0,0,0.15); }
    .sc-float-row { position:absolute; left:80px; top:860px; width:920px; display:flex; gap:28px; }
    .sc-mini { flex:1; padding:30px 30px; }
    .axis-foot { position:absolute; left:50%; top:1320px; transform:translateX(-50%); width:880px; text-align:center; font-size:52px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 4: Neutral Maintenance Flatline -> Serif Contrast */
    .v2-s4-center { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:920px; text-align:center; }

    /* Scene 5: 3 Rotated Coral Diamonds Triad + Leader Lines */
    .dia-box {
      position:absolute; width:196px; height:196px;
      background:var(--acc); border-radius:36px;
      transform:rotate(45deg);
      box-shadow:0 22px 48px var(--acc-soft);
      display:flex; align-items:center; justify-content:center;
    }
    .dia-inner { transform:rotate(-45deg); color:#FFFFFF; text-align:center; }
    #dia-1 { left:190px; top:940px; }
    #dia-2 { left:442px; top:730px; }
    #dia-3 { left:694px; top:520px; border:4px solid #0B0D0E; }
    .dia-lbl { position:absolute; font-size:36px; font-weight:500; letter-spacing:-0.025em; color:#0B0D0E; }
  `;

  const html = `${baseHeadAndStyles("Why Pay and Perks Don't Actually Motivate", target.accent, target.accentSoft, extraCss)}
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    <div class="bokeh-layer">
      <div class="bokeh-ring bokeh-tl" id="bokeh-tl"></div>
      <div class="bokeh-ring bokeh-br" id="bokeh-br"></div>
    </div>

    <!-- SCENE 1: Rising Dollar Counter + Flatline Motivation Wave -->
    <div class="k-scene" id="sc-1">
      <div class="k-cam" id="cam-1">
        <div class="v2-s1-wrap">
          <div class="v2-money" id="v2-num">$40k</div>
          <div class="v2-kicker" id="v2-kick">POURED INTO PERKS &amp; RAISES</div>
          <div class="white-card v2-ecg-card" id="v2-ecg-card">
            <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:600;margin-bottom:14px">
              <span>ACTUAL DRIVE PULSE</span><span class="txt-acc">FLATLINE 0%</span>
            </div>
            <svg viewBox="0 0 740 120" width="740" height="120" fill="none">
              <path id="v2-ecg" d="M 10 64 L 180 64 L 210 22 L 242 102 L 272 64 L 730 64" stroke="#F04424" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="900" stroke-dashoffset="900" />
            </svg>
          </div>
          <div class="v2-s1-foot" id="v2-s1-foot">Hoping for a <span class="serif-it txt-acc" style="font-size:74px">productivity surge.</span></div>
        </div>
      </div>
    </div>

    <!-- SCENE 2: X-Ray Lens Myth Reveal -->
    <div class="k-scene" id="sc-2">
      <div class="k-cam" id="cam-2">
        <div class="v2-s2-wrap">
          <div class="xray-pill-top" id="xray-myth">Management myth: “Motivators”</div>
          <div class="xray-lens" id="xray-lens">
            <div class="xray-tag">BOOK FINDING · P. 10</div>
            <div class="xray-big">Dissatisfiers.</div>
            <div class="xray-sub">They prevent complaints — they don't ignite drive.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- SCENE 3: -100 .. 0 .. +100 Equilibrium Axis + Study Cards -->
    <div class="k-scene" id="sc-3">
      <div class="k-cam" id="cam-3">
        <div class="white-card axis-card" id="axis-card">
          <div class="axis-labels">
            <span class="txt-acc">← DETERIORATION (COMPLAINTS)</span>
            <span style="color:#0B0D0E">0 · NEUTRAL</span>
            <span>HIGH MOTIVATION →</span>
          </div>
          <div class="axis-track">
            <div class="axis-neg-bar" id="axis-bar"></div>
            <div class="axis-zero"></div>
            <div class="axis-needle" id="axis-needle"></div>
          </div>
        </div>
        <div class="sc-float-row">
          <div class="white-card sc-mini" id="v2-c1">
            <div style="font-size:20px;font-weight:700;color:var(--acc);margin-bottom:8px">STUDY · P. 10 ★★★★★</div>
            <div style="font-size:22px;line-height:1.4;color:#1F2937">“Deterioration causes direct complaints from staff.”</div>
          </div>
          <div class="white-card sc-mini" id="v2-c2">
            <div style="font-size:20px;font-weight:700;color:#0B0D0E;margin-bottom:8px">RESULT · P. 19 ★★★★★</div>
            <div style="font-size:22px;line-height:1.4;color:#1F2937">“Improving perks stops at zero — never true enthusiasm.”</div>
          </div>
        </div>
        <div class="axis-foot" id="axis-foot">Fixing perks stops fault — <span class="txt-acc">not apathy.</span></div>
      </div>
    </div>

    <!-- SCENE 4: Editorial Minimalist Contrast (Beat 4) -->
    <div class="k-scene" id="sc-4">
      <div class="k-cam" id="cam-4">
        <div class="v2-s4-center">
          <div style="font-size:52px;font-weight:500;color:#6B7280;letter-spacing:-0.025em" id="v2-s4-a">Maintenance needs stop complaints</div>
          <div class="serif-it" style="font-size:92px;color:#0B0D0E;margin-top:16px" id="v2-s4-b">Yet leave <span class="txt-acc">drive flat.</span></div>
        </div>
      </div>
    </div>

    <!-- SCENE 5: 3 Ascending Coral Diamonds Triad (Achievement · Challenge · Growth) -->
    <div class="k-scene" id="sc-5">
      <div class="k-cam" id="cam-5">
        <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
          <polyline id="dline-1" points="288,1160 288,1255 370,1300" stroke="#0B0D0E" stroke-width="3.2" stroke-dasharray="220" stroke-dashoffset="220" />
          <polyline id="dline-2" points="540,700 540,610 450,560" stroke="#0B0D0E" stroke-width="3.2" stroke-dasharray="220" stroke-dashoffset="220" />
          <polyline id="dline-3" points="792,490 792,400 710,350" stroke="#0B0D0E" stroke-width="3.2" stroke-dasharray="220" stroke-dashoffset="220" />
        </svg>

        <div class="dia-box" id="dia-1"><div class="dia-inner"><div style="font-size:46px;font-weight:700">01</div><div style="font-size:20px;font-weight:600">TASK</div></div></div>
        <div class="dia-box" id="dia-2"><div class="dia-inner"><div style="font-size:46px;font-weight:700">02</div><div style="font-size:20px;font-weight:600">WIN</div></div></div>
        <div class="dia-box" id="dia-3"><div class="dia-inner"><div style="font-size:46px;font-weight:700">03</div><div style="font-size:20px;font-weight:600">GROW</div></div></div>

        <div class="dia-lbl" id="dlbl-1" style="left:386px;top:1282px">Challenge of the job</div>
        <div class="dia-lbl" id="dlbl-2" style="left:156px;top:526px">Real achievement</div>
        <div class="dia-lbl" id="dlbl-3" style="left:450px;top:316px;font-weight:600">Personal growth ✓</div>
      </div>
    </div>

    <!-- SCENE 6: Horizontal Pan + Hand-Drawn Coral Frame -->
    <div class="k-scene" id="sc-6">
      <div class="k-cam" id="cam-6">
        <div class="pan-track" id="v2-pan">
          <span class="pan-lead" id="v2-plead">Don't buy loyalty with perks</span>
          <span class="pan-focus" id="v2-pfocus">
            <span class="pan-payoff">Give ownership.</span>
            <svg viewBox="0 0 650 164" width="650" height="164" fill="none" style="position:absolute;left:-14px;top:-12px;width:calc(100% + 28px);height:calc(100% + 24px);overflow:visible">
              <path id="v2-box" d="M 22 24 L 628 18 L 634 144 L 18 148 L 22 24" stroke="#F04424" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1490" stroke-dashoffset="1490" style="filter:drop-shadow(0 8px 20px rgba(240,68,36,0.28))" />
            </svg>
          </span>
        </div>
      </div>
    </div>

    <!-- SCENE 7: Sign-Off -->
    <div class="k-scene" id="sc-7">
      <div class="k-cam" id="cam-7">
        <div class="signoff-center" id="v2-sign">
          <svg width="108" height="108" viewBox="0 0 120 120" fill="none" style="margin:0 auto">
            <circle cx="60" cy="60" r="44" stroke="#0B0D0E" stroke-width="8" />
            <path d="M40 68 L56 48 L70 62 L86 38" stroke="#F04424" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <div class="signoff-brand">BookReel</div>
          <div class="signoff-cite">Personnel Motivation &amp; Management · p. 10–19</div>
        </div>
      </div>
    </div>

    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${voiceDur.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    <audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="15" data-volume="1"></audio>
    <audio id="music" src="assets/music.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="10" data-volume="0.18"></audio>
  </div>
</div>
<script id="spec" type="application/json">${JSON.stringify(t)}</script>
<script>
(function () {
  var t = JSON.parse(document.getElementById("spec").textContent);
  var tl = gsap.timeline({ paused: true });
  ${GSAP_HELPERS_JS}

  tl.to("#bokeh-tl", { x: 80, y: 65, duration: t.duration, ease: "none" }, 0);
  tl.to("#bokeh-br", { x: -80, y: -65, duration: t.duration, ease: "none" }, 0);

  // Scene 1: Dollar Counter + ECG Flatline
  showWindow("sc-1", 0, t.b0e, t.duration);
  blurIn("v2-num", 0.04, 0.45, 22, 0.9);
  blurIn("v2-kick", 0.14, 0.45, 16, 0.95);
  blurIn("v2-ecg-card", 0.25, 0.5, 28, 0.92);
  blurIn("v2-s1-foot", 0.42, 0.5, 20, 0.95);
  var numEl = document.getElementById("v2-num");
  var cDur = Math.max(0.8, t.b0e - 0.6);
  tl.fromTo({}, {}, {
    duration: cDur, ease: "none", immediateRender: false,
    onUpdate: function () {
      var p = Math.max(0, Math.min(1, (tl.time() - 0.1) / cDur));
      var v = Math.round(40 + 140 * (1 - Math.pow(1 - p, 3)));
      if (numEl) numEl.textContent = "$" + v + "k+";
    }
  }, 0.1);
  tl.fromTo("#v2-ecg", { strokeDashoffset: 900 }, { strokeDashoffset: 0, duration: 1.2, ease: "power2.out", immediateRender: false }, 0.35);
  exitCam("cam-1", t.b0e - 0.26, 0.26, -26, 0.94);

  // Scene 2: X-Ray Myth Lens
  showWindow("sc-2", t.b0e, t.b1e, t.duration);
  blurIn("xray-myth", t.b0e + 0.05, 0.45, -20, 0.94);
  blurIn("xray-lens", t.b0e + 0.38, 0.55, 34, 0.88);
  exitCam("cam-2", t.b1e - 0.26, 0.26, 26, 0.94);

  // Scene 3: Equilibrium Axis + Cards
  showWindow("sc-3", t.b1e, t.b2e, t.duration);
  blurIn("axis-card", t.b1e + 0.04, 0.48, 28, 0.92);
  gsap.set("#axis-bar", { scaleX: 0 });
  tl.fromTo("#axis-bar", { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "expo.out", immediateRender: false }, t.b1e + 0.35);
  tl.fromTo("#axis-needle", { x: 0 }, { x: -340, duration: 0.75, ease: "expo.out", immediateRender: false }, t.b1e + 0.35);
  blurIn("v2-c1", t.b1e + 0.42, 0.5, 30, 0.92);
  blurIn("v2-c2", t.b1e + 0.62, 0.5, 30, 0.92);
  blurIn("axis-foot", t.b1e + 0.78, 0.46, 20, 0.95);
  exitCam("cam-3", t.b2e - 0.26, 0.26, -24, 0.94);

  // Scene 4: Maintenance Flat
  showWindow("sc-4", t.b2e, t.b3e, t.duration);
  blurIn("v2-s4-a", t.b2e + 0.06, 0.46, 20, 0.94);
  blurIn("v2-s4-b", t.b2e + 0.55, 0.52, 26, 0.92);
  exitCam("cam-4", t.b3e - 0.26, 0.26, 0, 0.94);

  // Scene 5: 3 Coral Diamonds Triad
  showWindow("sc-5", t.b3e, t.b4e, t.duration);
  var dStep = Math.min(0.55, (t.b4e - t.b3e) * 0.24);
  gsap.set(["#dia-1", "#dia-2", "#dia-3"], { rotation: 45, autoAlpha: 0, scale: 0.75 });
  tl.fromTo("#dia-1", { autoAlpha: 0, scale: 0.72, rotation: 45, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, rotation: 45, filter: "blur(0px)", duration: 0.46, ease: "expo.out", immediateRender: false }, t.b3e + 0.05);
  tl.fromTo("#dline-1", { strokeDashoffset: 220 }, { strokeDashoffset: 0, duration: 0.35, immediateRender: false }, t.b3e + 0.22);
  blurIn("dlbl-1", t.b3e + 0.28, 0.38, 12, 0.95);

  tl.fromTo("#dia-2", { autoAlpha: 0, scale: 0.72, rotation: 45, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, rotation: 45, filter: "blur(0px)", duration: 0.46, ease: "expo.out", immediateRender: false }, t.b3e + dStep);
  tl.fromTo("#dline-2", { strokeDashoffset: 220 }, { strokeDashoffset: 0, duration: 0.35, immediateRender: false }, t.b3e + dStep + 0.18);
  blurIn("dlbl-2", t.b3e + dStep + 0.24, 0.38, 12, 0.95);

  tl.fromTo("#dia-3", { autoAlpha: 0, scale: 0.72, rotation: 45, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, rotation: 45, filter: "blur(0px)", duration: 0.46, ease: "expo.out", immediateRender: false }, t.b3e + dStep * 2);
  tl.fromTo("#dline-3", { strokeDashoffset: 220 }, { strokeDashoffset: 0, duration: 0.35, immediateRender: false }, t.b3e + dStep * 2 + 0.18);
  blurIn("dlbl-3", t.b3e + dStep * 2 + 0.24, 0.38, 12, 0.95);
  exitCam("cam-5", t.b4e - 0.26, 0.26, 0, 0.92);

  // Scene 6: Horizontal Pan + Coral Box Frame
  showWindow("sc-6", t.b4e, t.s6End, t.duration);
  gsap.set("#v2-pan", { xPercent: -50, yPercent: -50, x: 310 });
  gsap.set("#v2-pfocus", { autoAlpha: 0 });
  blurIn("v2-plead", t.b4e + 0.05, 0.42, 18, 0.95);
  tl.fromTo("#v2-pan", { xPercent: -50, yPercent: -50, x: 310 }, { xPercent: -50, yPercent: -50, x: -245, duration: 0.64, ease: "expo.inOut", immediateRender: false }, t.s6PanAt);
  tl.to("#v2-plead", { color: "#9CA3AF", duration: 0.4 }, t.s6PanAt);
  blurIn("v2-pfocus", t.s6PanAt + 0.08, 0.46, 0, 0.94);
  tl.fromTo("#v2-box", { strokeDashoffset: 1490 }, { strokeDashoffset: 0, duration: 0.72, ease: "power3.out", immediateRender: false }, t.s6PanAt + 0.22);
  exitCam("cam-6", t.s6End - 0.25, 0.25, 0, 0.95);

  // Scene 7: Sign-Off
  showWindow("sc-7", t.s6End, t.duration, t.duration);
  blurIn("v2-sign", t.s6End, 0.5, 20, 0.9);

  tl.set({}, {}, t.duration);
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>`;

  return {
    html,
    sfxMoments: [
      { t: 0.35, file: "SFX_01_08.wav", kind: "counter-tick", role: "chrono-gear" },
      { t: +(b0e + 0.38).toFixed(3), file: "SFX_01_06.wav", kind: "shutter-snap", role: "archival-shutter" },
      { t: +(b1e + 0.35).toFixed(3), file: "SFX- Swoosh02.mp3", kind: "scene-whoosh", role: "whip-accent" },
      { t: +(b3e + 0.08).toFixed(3), file: "SFX_01_09.wav", kind: "ui-click", role: "vector-pop" },
      { t: +(s6PanAt + 0.18).toFixed(3), file: "SFX_01_01.wav", kind: "marker-swish", role: "paper-slide" },
    ],
  };
}

// ============================================================================
// VIDEO 3 BUILDER: Royal Electric Violet (#6D28D9) — "Divided Attention Fails"
// ============================================================================
function buildVideo3Html(
  target: TopicTarget,
  beats: Array<{ start: number; end: number }>,
  words: TimedWord[],
  duration: number,
  voiceDur: number,
): { html: string; sfxMoments: Array<{ t: number; file: string; kind: SelectiveLibrarySfxPlanItem["kind"]; role: SelectiveLibrarySfxPlanItem["role"] }> } {
  const b0e = +(AUDIO_OFFSET + beats[0].end).toFixed(3);
  const b1e = +(AUDIO_OFFSET + beats[1].end).toFixed(3);
  const b2e = +(AUDIO_OFFSET + beats[2].end).toFixed(3);
  const b3e = +(AUDIO_OFFSET + beats[3].end).toFixed(3);
  const b4e = +(AUDIO_OFFSET + voiceDur).toFixed(3);
  const s5PanAt = findWordTime(words, beats[4].start, beats[4].end, /^(master|absolute|presence)$/i, 0.56);
  const s5End = Math.min(duration - 0.8, b4e + 0.4);

  const t = { duration, b0e, b1e, b2e, b3e, b4e, s5PanAt, s5End };

  const extraCss = `
    /* Scene 1: 20x Ghost Stamp Dissolve Hook */
    .ghost-stack { position:absolute; left:50%; top:36%; transform:translate(-50%,-50%); width:800px; height:260px; }
    .ghost-20 { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:210px; font-weight:700; letter-spacing:-0.05em; }
    .g-back1 { color:rgba(109,40,217,0.12); margin-left:-76px; margin-top:-26px; filter:blur(5px); }
    .g-back2 { color:rgba(109,40,217,0.2); margin-left:76px; margin-top:24px; filter:blur(3px); }
    .g-main { color:#0B0D0E; }
    .v3-s1-copy { position:absolute; left:50%; top:58%; transform:translateX(-50%); width:900px; text-align:center; }

    /* Scene 2: 3-Way Attention Splitter Diagram */
    .split-card { position:absolute; left:80px; top:470px; width:920px; padding:44px 44px; }
    .split-foot { position:absolute; left:50%; top:1240px; transform:translateX(-50%); width:880px; text-align:center; font-size:52px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 3: Laser Magnifier Focus Converger (1x Concentration) */
    .lens-stage { position:absolute; left:80px; top:450px; width:920px; padding:44px 44px; border-color:var(--acc); border-width:2.5px; }
    .lens-foot { position:absolute; left:50%; top:1240px; transform:translateX(-50%); width:900px; text-align:center; font-size:54px; font-weight:500; letter-spacing:-0.03em; }

    /* Scene 4: Memory Impression Groove + Staggered Violet Pills + Book Card */
    .mem-card { position:absolute; left:90px; top:340px; width:900px; padding:34px 40px; }
    .v3-pills { position:absolute; left:90px; top:860px; width:900px; display:flex; flex-direction:column; gap:24px; }
    .v3-prow { display:flex; gap:22px; }
  `;

  const html = `${baseHeadAndStyles("Why Studying 20 Times With Divided Attention Fails", target.accent, target.accentSoft, extraCss)}
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    <div class="bokeh-layer">
      <div class="bokeh-ring bokeh-tl" id="bokeh-tl"></div>
      <div class="bokeh-ring bokeh-br" id="bokeh-br"></div>
    </div>

    <!-- SCENE 1: 20x Ghost Stamp Dissolve Hook -->
    <div class="k-scene" id="sc-1">
      <div class="k-cam" id="cam-1">
        <div class="ghost-stack" id="v3-ghosts">
          <div class="ghost-20 g-back1">20×</div>
          <div class="ghost-20 g-back2">20×</div>
          <div class="ghost-20 g-main">20×</div>
        </div>
        <div class="v3-s1-copy" id="v3-s1-copy">
          <div style="font-size:60px;font-weight:500;letter-spacing:-0.035em">Reviewing while distracted</div>
          <div class="serif-it txt-acc acc-aura" style="font-size:86px;margin-top:8px">yields poor results.</div>
        </div>
      </div>
    </div>

    <!-- SCENE 2: 3-Way Attention Splitter Diagram -->
    <div class="k-scene" id="sc-2">
      <div class="k-cam" id="cam-2">
        <div class="white-card split-card" id="split-card">
          <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:600;color:#64748B;margin-bottom:20px">
            <span>DIVIDED ATTENTION</span><span class="txt-acc">0 DEFINITE MEMORIES</span>
          </div>
          <svg viewBox="0 0 830 480" width="830" height="480" fill="none">
            <circle cx="90" cy="240" r="46" fill="#0B0D0E" />
            <text x="90" y="248" text-anchor="middle" fill="#FFF" font-size="22" font-weight="600">MIND</text>
            <!-- 3 scattered dashed rays that fade before memory wall -->
            <path id="sray-1" d="M 136 226 C 280 180, 380 86, 560 86" stroke="#94A3B8" stroke-width="5" stroke-dasharray="14 12" />
            <path id="sray-2" d="M 136 240 L 560 240" stroke="#94A3B8" stroke-width="5" stroke-dasharray="14 12" />
            <path id="sray-3" d="M 136 254 C 280 300, 380 394, 560 394" stroke="#94A3B8" stroke-width="5" stroke-dasharray="14 12" />
            <rect x="576" y="54" width="210" height="64" rx="32" stroke="#CBD5E1" stroke-width="2.5" />
            <text x="681" y="94" text-anchor="middle" fill="#64748B" font-size="24" font-weight="500">Study (33%)</text>
            <rect x="576" y="208" width="210" height="64" rx="32" stroke="#CBD5E1" stroke-width="2.5" />
            <text x="681" y="248" text-anchor="middle" fill="#64748B" font-size="24" font-weight="500">Play (33%)</text>
            <rect x="576" y="362" width="210" height="64" rx="32" stroke="#CBD5E1" stroke-width="2.5" />
            <text x="681" y="402" text-anchor="middle" fill="#64748B" font-size="24" font-weight="500">Daydream (33%)</text>
          </svg>
        </div>
        <div class="split-foot" id="split-foot">Pulled focus leaves <span class="txt-acc">no definite memory.</span></div>
      </div>
    </div>

    <!-- SCENE 3: Laser Lens Focus Converger (1x Intense Concentration) -->
    <div class="k-scene" id="sc-3">
      <div class="k-cam" id="cam-3">
        <div class="white-card lens-stage" id="lens-card">
          <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:700;color:var(--acc);margin-bottom:20px">
            <span>1× UNWAVERING CONCENTRATION</span><span>TEST-READY ✓</span>
          </div>
          <svg viewBox="0 0 830 480" width="830" height="480" fill="none">
            <!-- Parallel input rays -->
            <path id="lray-in" d="M 40 120 L 380 120 M 40 240 L 380 240 M 40 360 L 380 360" stroke="#6D28D9" stroke-width="6" stroke-linecap="round" stroke-dasharray="1100" stroke-dashoffset="1100" />
            <!-- Convex Optical Lens -->
            <path d="M 390 60 C 446 150, 446 330, 390 420 C 334 330, 334 150, 390 60 Z" fill="rgba(109,40,217,0.12)" stroke="#6D28D9" stroke-width="5" />
            <!-- Converging laser beams into single focal point -->
            <path id="lray-out" d="M 404 126 L 690 240 M 418 240 L 690 240 M 404 354 L 690 240" stroke="#6D28D9" stroke-width="7" stroke-linecap="round" stroke-dasharray="1000" stroke-dashoffset="1000" style="filter:drop-shadow(0 0 16px rgba(109,40,217,0.4))" />
            <circle id="lfocal" cx="690" cy="240" r="34" fill="#6D28D9" />
            <circle cx="690" cy="240" r="12" fill="#FFFFFF" />
          </svg>
        </div>
        <div class="lens-foot" id="lens-foot">Once or twice with <span class="serif-it txt-acc" style="font-size:68px">unwavering focus.</span></div>
      </div>
    </div>

    <!-- SCENE 4: Archival Book Card (p. 51) + 4 Staggered Violet/Outline Pills -->
    <div class="k-scene" id="sc-4">
      <div class="k-cam" id="cam-4">
        <div class="white-card mem-card" id="mem-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <span style="font-size:21px;font-weight:700;color:var(--acc)">THE PSYCHOLOGY OF SUCCESS · P. 51–52</span>
            <span style="color:var(--acc);font-size:20px;font-weight:700">★★★★★</span>
          </div>
          <div style="font-size:27px;line-height:1.42;color:#1E293B">“True concentration carves a sharp, deep mental impression that can be reproduced at will when needed.”</div>
          <svg viewBox="0 0 800 96" width="800" height="96" fill="none" style="margin-top:18px">
            <path id="mem-wave" d="M 10 50 Q 90 46, 170 50 T 330 50 L 410 14 L 460 84 L 510 12 L 560 82 L 610 48 L 790 48" stroke="#6D28D9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1000" stroke-dashoffset="1000" />
          </svg>
        </div>

        <div class="v3-pills">
          <div class="v3-prow">
            <div class="k-pill k-pill-acc" id="vp-1">Sharp deep impression.</div>
            <div class="k-pill k-pill-out" id="vp-2">1× > 20×</div>
          </div>
          <div class="v3-prow" style="justify-content:flex-end">
            <div class="k-pill k-pill-out" id="vp-3">Zero distraction</div>
            <div class="k-pill k-pill-acc" id="vp-4">Reproduced at will ✓</div>
          </div>
        </div>
      </div>
    </div>

    <!-- SCENE 5: Horizontal Pan + Hand-Drawn Violet Double Loop -->
    <div class="k-scene" id="sc-5">
      <div class="k-cam" id="cam-5">
        <div class="pan-track" id="v3-pan">
          <span class="pan-lead" id="v3-plead">Stop distracted hours</span>
          <span class="pan-focus" id="v3-pfocus" style="padding:22px 62px">
            <span class="pan-payoff">Absolute presence.</span>
            <svg viewBox="0 0 820 184" width="820" height="184" fill="none" style="position:absolute;left:-16px;top:-16px;width:calc(100% + 32px);height:calc(100% + 32px);overflow:visible">
              <path id="v3-oval" d="M 34 94 C 30 28, 224 12, 414 14 C 618 16, 792 38, 788 94 C 784 150, 598 170, 402 168 C 198 166, 26 140, 52 78" stroke="#6D28D9" stroke-width="6" stroke-linecap="round" stroke-dasharray="1860" stroke-dashoffset="1860" style="filter:drop-shadow(0 8px 22px rgba(109,40,217,0.32))" />
            </svg>
          </span>
        </div>
      </div>
    </div>

    <!-- SCENE 6: Sign-Off -->
    <div class="k-scene" id="sc-6">
      <div class="k-cam" id="cam-6">
        <div class="signoff-center" id="v3-sign">
          <svg width="108" height="108" viewBox="0 0 120 120" fill="none" style="margin:0 auto">
            <polygon points="60,16 104,96 16,96" stroke="#0B0D0E" stroke-width="8" stroke-linejoin="round" />
            <circle cx="60" cy="68" r="14" fill="#6D28D9" />
          </svg>
          <div class="signoff-brand">BookReel</div>
          <div class="signoff-cite">The Psychology of Success · p. 51–52</div>
        </div>
      </div>
    </div>

    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${voiceDur.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    <audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="15" data-volume="1"></audio>
    <audio id="music" src="assets/music.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="10" data-volume="0.18"></audio>
  </div>
</div>
<script id="spec" type="application/json">${JSON.stringify(t)}</script>
<script>
(function () {
  var t = JSON.parse(document.getElementById("spec").textContent);
  var tl = gsap.timeline({ paused: true });
  ${GSAP_HELPERS_JS}

  tl.to("#bokeh-tl", { x: 85, y: 65, duration: t.duration, ease: "none" }, 0);
  tl.to("#bokeh-br", { x: -85, y: -65, duration: t.duration, ease: "none" }, 0);

  // Scene 1: 20x Ghost Stamp
  showWindow("sc-1", 0, t.b0e, t.duration);
  blurIn("v3-ghosts", 0.04, 0.52, -24, 1.3);
  blurIn("v3-s1-copy", 0.35, 0.5, 24, 0.94);
  exitCam("cam-1", t.b0e - 0.26, 0.26, -24, 0.92);

  // Scene 2: 3-Way Attention Splitter
  showWindow("sc-2", t.b0e, t.b1e, t.duration);
  blurIn("split-card", t.b0e + 0.05, 0.5, 28, 0.92);
  blurIn("split-foot", t.b0e + 0.35, 0.48, 20, 0.95);
  exitCam("cam-2", t.b1e - 0.26, 0.26, 26, 0.94);

  // Scene 3: Laser Lens Converger
  showWindow("sc-3", t.b1e, t.b2e, t.duration);
  blurIn("lens-card", t.b1e + 0.04, 0.48, 28, 0.92);
  tl.fromTo("#lray-in", { strokeDashoffset: 1100 }, { strokeDashoffset: 0, duration: 0.65, ease: "power2.out", immediateRender: false }, t.b1e + 0.2);
  tl.fromTo("#lray-out", { strokeDashoffset: 1000 }, { strokeDashoffset: 0, duration: 0.7, ease: "expo.out", immediateRender: false }, t.b1e + 0.55);
  blurIn("lfocal", t.b1e + 0.78, 0.4, 0, 0.4);
  blurIn("lens-foot", t.b1e + 0.4, 0.48, 20, 0.95);
  exitCam("cam-3", t.b2e - 0.26, 0.26, -24, 0.94);

  // Scene 4: Book Card + Memory Groove + 4 Pills
  showWindow("sc-4", t.b2e, t.b3e, t.duration);
  blurIn("mem-card", t.b2e + 0.05, 0.5, 28, 0.92);
  tl.fromTo("#mem-wave", { strokeDashoffset: 1000 }, { strokeDashoffset: 0, duration: 0.95, ease: "power2.out", immediateRender: false }, t.b2e + 0.3);
  var pSpan = Math.max(1.2, t.b3e - t.b2e - 0.8);
  for (var i = 1; i <= 4; i++) {
    blurIn("vp-" + i, t.b2e + 0.35 + (i - 1) * (pSpan / 4), 0.42, 22, 0.88);
  }
  exitCam("cam-4", t.b3e - 0.26, 0.26, 0, 0.94);

  // Scene 5: Horizontal Pan + Violet Loop
  showWindow("sc-5", t.b3e, t.s5End, t.duration);
  gsap.set("#v3-pan", { xPercent: -50, yPercent: -50, x: 290 });
  gsap.set("#v3-pfocus", { autoAlpha: 0 });
  blurIn("v3-plead", t.b3e + 0.05, 0.42, 18, 0.95);
  tl.fromTo("#v3-pan", { xPercent: -50, yPercent: -50, x: 290 }, { xPercent: -50, yPercent: -50, x: -255, duration: 0.64, ease: "expo.inOut", immediateRender: false }, t.s5PanAt);
  tl.to("#v3-plead", { color: "#9CA3AF", duration: 0.4 }, t.s5PanAt);
  blurIn("v3-pfocus", t.s5PanAt + 0.08, 0.46, 0, 0.94);
  tl.fromTo("#v3-oval", { strokeDashoffset: 1860 }, { strokeDashoffset: 0, duration: 0.72, ease: "power3.out", immediateRender: false }, t.s5PanAt + 0.22);
  exitCam("cam-5", t.s5End - 0.25, 0.25, 0, 0.95);

  // Scene 6: Sign-Off
  showWindow("sc-6", t.s5End, t.duration, t.duration);
  blurIn("v3-sign", t.s5End, 0.5, 20, 0.9);

  tl.set({}, {}, t.duration);
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>`;

  return {
    html,
    sfxMoments: [
      { t: 0.12, file: "SFX_01_02.wav", kind: "card-pop", role: "dossier-stamp" },
      { t: +(b1e + 0.55).toFixed(3), file: "SFX_01_04.wav", kind: "scene-whoosh", role: "neuro-circuit" },
      { t: +(b2e + 0.35).toFixed(3), file: "SFX_01_03.wav", kind: "card-pop", role: "bento-ui" },
      { t: +(s5PanAt + 0.18).toFixed(3), file: "14 Quick Swing.wav", kind: "scene-whoosh", role: "cinema-deep" },
    ],
  };
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });
  const lib = await loadProjectSfxLibrary();

  const onlySlug = process.env.BOOKREEL_ONLY_SLUG?.trim();
  const active = onlySlug ? TOPICS.filter((x) => x.slug === onlySlug) : TOPICS;

  try {
    for (const target of active) {
      const ep = await prisma.episode.findUnique({
        where: { id: target.episodeId },
        include: { book: true },
      });
      if (!ep || !ep.script) throw new Error(`Episode missing script: ${target.episodeId}`);

      const parsed = JSON.parse(ep.script) as ContentPackage | Beat[];
      const beats: Beat[] = Array.isArray(parsed) ? parsed : parsed.beats ?? [];

      console.log(`\n======================================================`);
      console.log(`Rendering Multi-Pattern Kinetic Video: ${target.slug}`);
      console.log(`Book: ${ep.book.title}`);
      console.log(`Topic: ${ep.title} (voice=${target.voiceId}, accent=${target.accent})`);
      console.log(`======================================================`);

      const projDir = path.join(os.tmpdir(), "bookreel-proj", target.slug);
      const workDir = path.join(os.tmpdir(), "bookreel-work", target.slug);
      await fs.rm(projDir, { recursive: true, force: true });
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(projDir, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });

      const voice = await synthesizeVoiceover(
        beats.map((b) => b.voiceover),
        workDir,
        target.voiceId,
      );
      const timing = await timeNarration(voice, workDir);
      const voiceDur = voice.totalDuration;
      const duration = +(AUDIO_OFFSET + voiceDur + OUTRO_TAIL).toFixed(3);

      const built =
        target.slug === "kinetic-1-doing-less-work"
          ? buildVideo1Html(target, timing.beats, timing.words, duration, voiceDur)
          : target.slug === "kinetic-2-pay-and-perks"
            ? buildVideo2Html(target, timing.beats, timing.words, duration, voiceDur)
            : buildVideo3Html(target, timing.beats, timing.words, duration, voiceDur);

      const musicPath = path.join(workDir, "music.wav");
      await generateCinematicScoreWav(duration, musicPath, {
        style: target.musicStyle,
        voicePath: voice.audioPath,
        voiceOffsetSec: AUDIO_OFFSET,
        targetMeanDb: -26,
      });

      const sfxPlan: SelectiveLibrarySfxPlanItem[] = built.sfxMoments.map((m, idx) => ({
        timeSec: m.t,
        kind: m.kind,
        role: m.role,
        modelId: target.slug,
        fileName: m.file,
        gainScale: 0.9,
        sceneIndex: idx,
      }));
      const sfxBuf = renderSelectiveLibrarySfxBuffer({
        durationSec: duration,
        plan: sfxPlan,
        library: lib,
        speechSpans: timing.words.map((w) => ({ start: w.start, end: w.end })),
        audioOffsetSec: AUDIO_OFFSET,
      });
      const sfxPath = path.join(workDir, "sfx.wav");
      await fs.writeFile(sfxPath, toWav(sfxBuf));

      await writeProject({
        dir: projDir,
        indexHtml: built.html,
        audioSource: voice.audioPath,
        musicSource: musicPath,
        sfxSource: sfxPath,
        assets: [],
      });

      const outMp4 = path.join(outDir, `${target.slug}.mp4`);
      const tmpMp4 = path.join(os.tmpdir(), `${target.slug}-${Date.now()}.mp4`);
      const t0 = Date.now();
      await renderProject(projDir, tmpMp4, "high", "local", 1);
      await fs.copyFile(tmpMp4, outMp4);
      await fs.rm(tmpMp4, { force: true }).catch(() => {});
      await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

      const st = await fs.stat(outMp4);
      console.log(
        `  [DONE] ${target.slug}.mp4 -> ${(st.size / (1024 * 1024)).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
