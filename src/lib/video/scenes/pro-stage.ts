/**
 * Ultra-Pro Creator & Glassmorphism Interactive Motion Models (`pro-stage.ts`).
 *
 * Ships 21 distinct, seek-safe multi-layered visual metaphor & Kinetic-UI rigs
 * (Apple VisionOS Glassmorphism radial gauges, conversion funnels, precision scales,
 * multi-cell energy meters, sonar sweeps, domino cascades, dual progress telemetry,
 * vault shackle unlocks, neural synapse networks, twin-chamber timers, iceberg depth
 * cross-sections, orbital gravity wells, ascending momentum stairs, prism spectrums,
 * plus dossier & lab rigs).
 *
 * Every element receives at most ONE GSAP tween (`spring-card`, `whip-pan`, `wipe`,
 * `grow`, or `draw`), guaranteeing 100% deterministic seek-safety on every frame.
 */

export const ALL_PRO_MODEL_KINDS = [
  "streak-shield",
  "obstacle-radar",
  "compound-blip",
  "crowd-asymmetry",
  "barcelona-timeline",
  "lab-apparatus",
  "hand-swerve-arc",
  "glass-radial-gauge",
  "glass-funnel-filter",
  "glass-balance-scale",
  "glass-battery-drain",
  "glass-radar-sonar",
  "glass-domino-chain",
  "glass-split-bars",
  "glass-vault-unlock",
  "glass-neural-synapse",
  "glass-hourglass-flow",
  "glass-iceberg-depth",
  "glass-orbit-gravity",
  "glass-step-staircase",
  "glass-prism-spectrum",
] as const;

export type ProModelKind = (typeof ALL_PRO_MODEL_KINDS)[number];

export interface ProModelMeta {
  kicker?: string;
  badge?: string;
  leftTitle?: string;
  rightTitle?: string;
  statBig?: string;
  calloutTag?: string;
  calloutText?: string;
  rows?: Array<{ pin: string; title: string; sub: string }>;
  items?: string[];
}

export interface ProModelAnimSpec {
  el: number;
  kind: "spring-card" | "whip-pan" | "wipe" | "grow" | "draw";
  delaySec: number;
  durSec: number;
  val?: number;
}

export interface ProModelOutput {
  markup: string;
  anims: ProModelAnimSpec[];
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clip(s: string | undefined, fallback: string, maxLen: number): string {
  const clean = (s ?? "").trim();
  const chosen = clean.length > 0 ? clean : fallback;
  return chosen.length <= maxLen ? chosen : `${chosen.slice(0, maxLen - 1).trimEnd()}…`;
}

export function buildProModel(kind: ProModelKind, baseEl: number, meta?: ProModelMeta): ProModelOutput {
  const anims: ProModelAnimSpec[] = [];
  let nextEl = baseEl;

  const spring = (delaySec: number, scaleFrom = 0.84, durSec = 0.46): number => {
    const el = nextEl++;
    anims.push({ el, kind: "spring-card", delaySec, durSec, val: scaleFrom });
    return el;
  };

  const whip = (delaySec: number, dx = -40, durSec = 0.46): number => {
    const el = nextEl++;
    anims.push({ el, kind: "whip-pan", delaySec, durSec, val: dx });
    return el;
  };

  const wipe = (delaySec: number, durSec = 0.72): number => {
    const el = nextEl++;
    anims.push({ el, kind: "wipe", delaySec, durSec });
    return el;
  };

  const grow = (delaySec: number, durSec = 0.68): number => {
    const el = nextEl++;
    anims.push({ el, kind: "grow", delaySec, durSec });
    return el;
  };

  const drawPath = (d: string, cls: string, dash: number, delaySec: number, durSec = 0.82): string => {
    const el = nextEl++;
    anims.push({ el, kind: "draw", delaySec, durSec, val: dash });
    return `<path class="${cls}" data-el="${el}" d="${d}" stroke-dasharray="${dash}" stroke-dashoffset="${dash}" />`;
  };

  // =========================================================================
  // 1. `glass-radial-gauge` — Frosted Speedometer / Precision Score Dial
  // =========================================================================
  if (kind === "glass-radial-gauge") {
    const cardEl = spring(0.06, 0.9);
    const trackArc = drawPath("M 204 224 A 156 156 0 0 1 516 224", "pro-svg-grid", 500, 0.14, 0.45);
    const valArc = drawPath("M 204 224 A 156 156 0 0 1 495 146", "pro-svg-hero-line", 420, 0.28, 0.95);
    const centerEl = spring(0.38, 0.62);
    const needleEl = spring(0.54, 0.5);
    const chipA = whip(0.62, -32);
    const chipB = whip(0.72, 32);

    const kicker = escHtml(clip(meta?.kicker, "DECISION VELOCITY DIAL", 28));
    const badge = escHtml(clip(meta?.badge, "PEAK CLARITY", 16));
    const statBig = escHtml(clip(meta?.statBig, "0.18s", 8));
    const leftLbl = escHtml(clip(meta?.leftTitle, "Hesitation Drag", 20));
    const rightLbl = escHtml(clip(meta?.rightTitle, "Instant Pull ✓", 20));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 256" width="720" height="256" fill="none" aria-hidden="true">
            ${trackArc}
            ${valArc}
            <g data-el="${needleEl}">
              <circle class="pro-node-goal" cx="495" cy="146" r="14" />
            </g>
            <g data-el="${centerEl}">
              <text class="pro-svg-big" x="360" y="192" text-anchor="middle">${statBig}</text>
              <text class="pro-svg-lbl" x="360" y="232" text-anchor="middle">MEASURED RESPONSE</text>
            </g>
          </svg>
          <div class="pro-bento-row">
            <div class="pro-mini-card" data-el="${chipA}">
              <span class="pro-mini-kicker">LOW SIGNAL</span>
              <span class="pro-mini-title">${leftLbl}</span>
            </div>
            <div class="pro-mini-card pro-mini-accent" data-el="${chipB}">
              <span class="pro-mini-kicker">STRONG SIGNAL</span>
              <span class="pro-mini-title">${rightLbl}</span>
            </div>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 2. `glass-funnel-filter` — 3-Tier Glassmorphism Conversion / Signal Funnel
  // =========================================================================
  if (kind === "glass-funnel-filter") {
    const cardEl = spring(0.06, 0.9);
    const tier1 = whip(0.16, -36);
    const tier2 = whip(0.34, 36);
    const tier3 = spring(0.56, 0.72);
    const railL = drawPath("M 110 66 L 246 218", "pro-svg-muted-dash", 220, 0.24, 0.65);
    const railR = drawPath("M 610 66 L 474 218", "pro-svg-muted-dash", 220, 0.28, 0.65);

    const kicker = escHtml(clip(meta?.kicker, "COGNITIVE FILTER FUNNEL", 28));
    const badge = escHtml(clip(meta?.badge, "DISTILLED", 16));
    const items = meta?.items && meta.items.length >= 3
      ? meta.items
      : ["Surface Noise & Excuses", "Competing Daily Options", clip(meta?.rightTitle, "One Decisive Action ✓", 26)];

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 278" width="720" height="278" fill="none" aria-hidden="true">
            ${railL}${railR}
            <g data-el="${tier1}">
              <rect class="pro-svg-panel" x="78" y="18" width="564" height="64" rx="16" />
              <text class="pro-svg-lbl" x="360" y="58" text-anchor="middle">${escHtml(clip(items[0], "All Inputs", 32))}</text>
            </g>
            <g data-el="${tier2}">
              <rect class="pro-svg-panel" x="156" y="106" width="408" height="64" rx="16" />
              <text class="pro-svg-lbl" x="360" y="146" text-anchor="middle">${escHtml(clip(items[1], "Filtered Signal", 28))}</text>
            </g>
            <g data-el="${tier3}">
              <rect class="pro-node-block" x="226" y="194" width="268" height="68" rx="18" />
              <text class="pro-svg-lbl-ok" x="360" y="236" text-anchor="middle">${escHtml(clip(items[2], "Core Choice ✓", 22))}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 3. `glass-balance-scale` — Precision Fulcrum & Tipping Motive Scale
  // =========================================================================
  if (kind === "glass-balance-scale") {
    const cardEl = spring(0.06, 0.9);
    const baseLine = drawPath("M 180 258 L 540 258", "pro-svg-grid", 380, 0.14, 0.4);
    const fulcrum = spring(0.22, 0.6);
    const beam = drawPath("M 136 174 L 584 108", "pro-svg-hero-line", 470, 0.3, 0.72);
    const panL = whip(0.42, -32);
    const panR = whip(0.54, 32);

    const kicker = escHtml(clip(meta?.kicker, "MOTIVE WEIGHT BALANCE", 28));
    const badge = escHtml(clip(meta?.badge, "TIPPING POINT", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "Internal Doubt", 18).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "True Motive ✓", 18).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 282" width="720" height="282" fill="none" aria-hidden="true">
            ${baseLine}
            ${beam}
            <g data-el="${fulcrum}">
              <polygon class="pro-svg-panel" points="360,142 322,258 398,258" />
              <circle class="pro-node-ok" cx="360" cy="142" r="12" />
            </g>
            <g data-el="${panL}">
              <rect class="pro-svg-panel" x="44" y="182" width="212" height="66" rx="16" />
              <text class="pro-svg-lbl" x="150" y="222" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${panR}">
              <rect class="pro-node-block" x="464" y="32" width="212" height="68" rx="16" />
              <text class="pro-svg-lbl-ok" x="570" y="74" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 4. `glass-battery-drain` — 5-Cell Glassmorphism Energy / Engagement Meter
  // =========================================================================
  if (kind === "glass-battery-drain") {
    const cardEl = spring(0.06, 0.9);
    const cells = [0, 1, 2, 3, 4].map((idx) => {
      const el = spring(0.18 + idx * 0.1, 0.65, 0.42);
      const active = idx < 3;
      const warn = idx === 2;
      const cls = warn ? "pro-day pro-day-warn" : active ? "pro-day pro-day-ok" : "pro-day";
      const pct = (idx + 1) * 20;
      return `<div class="${cls}" data-el="${el}">
        <span class="pro-day-lbl">${pct}%</span>
        <div class="pro-batt-bar ${active ? "pro-batt-on" : "pro-batt-dim"}"></div>
      </div>`;
    });
    const noteEl = whip(0.68, -32);

    const kicker = escHtml(clip(meta?.kicker, "ENGAGEMENT ENERGY RESERVE", 28));
    const badge = escHtml(clip(meta?.badge, "RECHARGE NOW", 16));
    const tag = escHtml(clip(meta?.calloutTag, "SIGNAL", 12));
    const callout = escHtml(clip(meta?.calloutText, "Routine monotony drains momentum before you quit", 48));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-warn">${badge}</span>
          </div>
          <div class="pro-batt-grid">${cells.join("")}</div>
          <div class="pro-callout-row" data-el="${noteEl}">
            <span class="pro-tag-warn">${tag}</span>
            <span class="pro-callout-txt">${callout}</span>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 5. `glass-radar-sonar` — Concentric Glass Sonar Sweep & Target Ping
  // =========================================================================
  if (kind === "glass-radar-sonar") {
    const cardEl = spring(0.06, 0.9);
    const rOuter = drawPath("M 360 30 a 112 112 0 1 0 0.1 0", "pro-svg-grid", 720, 0.12, 0.55);
    const rInner = drawPath("M 360 76 a 66 66 0 1 0 0.1 0", "pro-svg-grid", 430, 0.2, 0.5);
    const sweepRay = drawPath("M 360 142 L 446 68", "pro-svg-hero-line", 140, 0.34, 0.65);
    const pingA = spring(0.48, 0.35);
    const pingB = spring(0.68, 0.35);
    const noteEl = whip(0.76, 30);

    const kicker = escHtml(clip(meta?.kicker, "HIDDEN PATTERN SCANNER", 28));
    const badge = escHtml(clip(meta?.badge, "TRAP DETECTED", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "SURFACE REFLECTION", 18).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "HIDDEN TRAP !", 18).toUpperCase());
    const tag = escHtml(clip(meta?.calloutTag, "SCAN", 12));
    const callout = escHtml(clip(meta?.calloutText, "Rumination quietly wires hesitation into memory", 48));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-warn">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 276" width="720" height="276" fill="none" aria-hidden="true">
            <line class="pro-svg-grid" x1="220" y1="142" x2="500" y2="142" />
            <line class="pro-svg-grid" x1="360" y1="18" x2="360" y2="264" />
            ${rOuter}${rInner}${sweepRay}
            <circle class="pro-node-ok" cx="360" cy="142" r="9" />
            <g data-el="${pingA}">
              <circle class="pro-node-ok" cx="294" cy="176" r="10" />
              <text class="pro-svg-lbl" x="134" y="182" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${pingB}">
              <circle class="pro-node-goal" cx="446" cy="68" r="15" />
              <text class="pro-svg-lbl-ok" x="588" y="74" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
          <div class="pro-callout-row" data-el="${noteEl}">
            <span class="pro-tag-warn">${tag}</span>
            <span class="pro-callout-txt">${callout}</span>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 6. `glass-domino-chain` — 5-Slab Cascading Chain-Reaction Rig
  // =========================================================================
  if (kind === "glass-domino-chain") {
    const cardEl = spring(0.06, 0.9);
    const waveArc = drawPath("M 98 78 C 240 42, 440 58, 616 146", "pro-svg-hero-line", 580, 0.24, 0.88);
    const labels = meta?.items && meta.items.length >= 4
      ? meta.items.slice(0, 4)
      : ["Replay", "Repine", "Friction", "Freeze"];
    const angles = [6, 18, 32, 52];
    const xs = [110, 260, 412, 566];
    const slabs = xs.map((x, idx) => {
      const el = spring(0.18 + idx * 0.14, 0.68, 0.44);
      const isLast = idx === xs.length - 1;
      return `<g data-el="${el}">
        <g transform="translate(${x} 214) rotate(${angles[idx]})">
          <rect class="${isLast ? "pro-node-block" : "pro-svg-panel"}" x="-32" y="-128" width="64" height="128" rx="14" />
        </g>
        <text class="${isLast ? "pro-svg-lbl-ok" : "pro-svg-lbl"}" x="${x}" y="256" text-anchor="middle">${escHtml(clip(labels[idx], `S${idx + 1}`, 11).toUpperCase())}</text>
      </g>`;
    });

    const kicker = escHtml(clip(meta?.kicker, "CHAIN-REACTION CASCADE", 28));
    const badge = escHtml(clip(meta?.badge, "COMPOUND EFFECT", 16));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-warn">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 278" width="720" height="278" fill="none" aria-hidden="true">
            <line class="pro-svg-grid" x1="56" y1="218" x2="664" y2="218" />
            ${waveArc}
            ${slabs.join("")}
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 7. `glass-split-bars` — Dual Horizontal Glass Telemetry Meters
  // =========================================================================
  if (kind === "glass-split-bars") {
    const cardEl = spring(0.06, 0.9);
    const rowA = whip(0.16, -34);
    const barA = wipe(0.28, 0.65);
    const rowB = whip(0.36, -34);
    const barB = wipe(0.48, 0.85);
    const noteEl = spring(0.72, 0.86);

    const kicker = escHtml(clip(meta?.kicker, "EFFORT VS OUTCOME TELEMETRY", 28));
    const badge = escHtml(clip(meta?.badge, "LIVE METRICS", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "Passive Autopilot", 24));
    const rightLbl = escHtml(clip(meta?.rightTitle, "Active Variety & Effort", 24));
    const callout = escHtml(clip(meta?.calloutText, "Active engagement multiplies long-term retention", 48));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <div class="pro-bars-stack">
            <div class="pro-bar-group" data-el="${rowA}">
              <div class="pro-bar-meta"><span>${leftLbl}</span><span class="pro-bar-pct">24%</span></div>
              <div class="pro-meter-track"><div class="pro-meter-fill pro-meter-muted" data-el="${barA}" style="width:24%"></div></div>
            </div>
            <div class="pro-bar-group" data-el="${rowB}">
              <div class="pro-bar-meta"><span>${rightLbl}</span><span class="pro-bar-pct pro-bar-pct-hi">92%</span></div>
              <div class="pro-meter-track"><div class="pro-meter-fill" data-el="${barB}" style="width:92%"></div></div>
            </div>
          </div>
          <div class="pro-callout-row" data-el="${noteEl}">
            <span class="pro-tag-warn">KEY</span>
            <span class="pro-callout-txt">${callout}</span>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 8. `glass-vault-unlock` — Frosted Shackle Lock -> Mental Freedom Rig
  // =========================================================================
  if (kind === "glass-vault-unlock") {
    const cardEl = spring(0.06, 0.9);
    const shackle = drawPath("M 296 124 L 296 74 A 64 64 0 0 1 424 62", "pro-svg-hero-line", 280, 0.22, 0.78);
    const bodyEl = spring(0.32, 0.72);
    const pin1 = spring(0.48, 0.5);
    const pin2 = spring(0.6, 0.5);
    const pin3 = spring(0.72, 0.5);

    const kicker = escHtml(clip(meta?.kicker, "COGNITIVE LOCK RELEASE", 28));
    const badge = escHtml(clip(meta?.badge, "UNLOCKED ✓", 16));
    const statBig = escHtml(clip(meta?.statBig, "FREE", 8));
    const leftLbl = escHtml(clip(meta?.leftTitle, "DROP REGRET", 14).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "ACT CLEARLY", 14).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 276" width="720" height="276" fill="none" aria-hidden="true">
            ${shackle}
            <g data-el="${bodyEl}">
              <rect class="pro-node-block" x="252" y="122" width="216" height="134" rx="24" />
              <text class="pro-svg-big" x="360" y="206" text-anchor="middle">${statBig}</text>
            </g>
            <g data-el="${pin1}">
              <rect class="pro-svg-panel" x="42" y="148" width="176" height="68" rx="16" />
              <text class="pro-svg-lbl" x="130" y="190" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${pin2}">
              <circle class="pro-node-goal" cx="424" cy="62" r="11" />
            </g>
            <g data-el="${pin3}">
              <rect class="pro-svg-panel" x="502" y="148" width="176" height="68" rx="16" />
              <text class="pro-svg-lbl-ok" x="590" y="190" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 9. `glass-neural-synapse` — 3-Layer Neural Hub & Firing Pathways
  // =========================================================================
  if (kind === "glass-neural-synapse") {
    const cardEl = spring(0.06, 0.9);
    const s1 = drawPath("M 152 72 C 240 72, 260 142, 360 142", "pro-svg-muted-dash", 250, 0.18, 0.55);
    const s2 = drawPath("M 152 212 C 240 212, 260 142, 360 142", "pro-svg-muted-dash", 250, 0.24, 0.55);
    const s3 = drawPath("M 360 142 C 448 142, 476 86, 566 86", "pro-svg-hero-line", 250, 0.44, 0.68);
    const s4 = drawPath("M 360 142 C 448 142, 476 198, 566 198", "pro-svg-grid", 250, 0.48, 0.6);
    const inNodes = whip(0.16, -28);
    const coreHub = spring(0.36, 0.55);
    const outNodes = whip(0.62, 28);

    const kicker = escHtml(clip(meta?.kicker, "NEURAL DECISION PATHWAY", 28));
    const badge = escHtml(clip(meta?.badge, "SIGNAL ROUTED", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "MEMORY TRACE", 15).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "NEW RESPONSE ✓", 15).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 278" width="720" height="278" fill="none" aria-hidden="true">
            ${s1}${s2}${s3}${s4}
            <g data-el="${inNodes}">
              <circle class="pro-node-ok" cx="152" cy="72" r="18" />
              <circle class="pro-node-ok" cx="152" cy="212" r="18" />
              <text class="pro-svg-lbl" x="152" y="258" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${coreHub}">
              <circle class="pro-node-block" cx="360" cy="142" r="42" />
              <text class="pro-svg-lbl-ok" x="360" y="150" text-anchor="middle">HUB</text>
            </g>
            <g data-el="${outNodes}">
              <rect class="pro-node-block" x="504" y="52" width="174" height="64" rx="16" />
              <text class="pro-svg-lbl-ok" x="591" y="92" text-anchor="middle">${rightLbl}</text>
              <rect class="pro-svg-panel" x="504" y="168" width="174" height="58" rx="14" />
              <text class="pro-svg-lbl" x="591" y="204" text-anchor="middle">OLD STALL</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 10. `glass-hourglass-flow` — Twin-Chamber Glass Time Allocation Rig
  // =========================================================================
  if (kind === "glass-hourglass-flow") {
    const cardEl = spring(0.06, 0.9);
    const topChamber = spring(0.18, 0.78);
    const stream = drawPath("M 360 116 L 360 178", "pro-svg-hero-line", 80, 0.34, 0.55);
    const botChamber = spring(0.48, 0.78);
    const sideNote = whip(0.64, 34);

    const kicker = escHtml(clip(meta?.kicker, "TIME WINDOW ALLOCATION", 28));
    const badge = escHtml(clip(meta?.badge, "MEASURED", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "DELAYED DOUBT", 18).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "DECISIVE ACT ✓", 18).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 278" width="720" height="278" fill="none" aria-hidden="true">
            ${stream}
            <g data-el="${topChamber}">
              <polygon class="pro-svg-panel" points="230,26 490,26 392,116 328,116" />
              <text class="pro-svg-lbl" x="360" y="68" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${botChamber}">
              <polygon class="pro-node-block" points="328,178 392,178 504,262 216,262" />
              <text class="pro-svg-lbl-ok" x="360" y="236" text-anchor="middle">${rightLbl}</text>
            </g>
            <g data-el="${sideNote}">
              <circle class="pro-node-goal" cx="360" cy="147" r="11" />
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 11. `glass-iceberg-depth` — Surface Story vs Submerged Motive Rig
  // =========================================================================
  if (kind === "glass-iceberg-depth") {
    const cardEl = spring(0.06, 0.9);
    const waterLine = drawPath("M 56 112 L 664 112", "pro-svg-hero-line", 620, 0.18, 0.65);
    const tipEl = spring(0.28, 0.72);
    const deepEl = spring(0.48, 0.78);

    const kicker = escHtml(clip(meta?.kicker, "SURFACE STORY VS DEEP MOTIVE", 28));
    const badge = escHtml(clip(meta?.badge, "90% HIDDEN", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "10% CONSCIOUS STORY", 22).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "90% ACTUAL PREFERENCE ✓", 24).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 282" width="720" height="282" fill="none" aria-hidden="true">
            <g data-el="${tipEl}">
              <polygon class="pro-svg-panel" points="360,20 272,108 448,108" />
              <text class="pro-svg-lbl" x="556" y="74" text-anchor="middle">${leftLbl}</text>
            </g>
            ${waterLine}
            <g data-el="${deepEl}">
              <polygon class="pro-node-block" points="256,118 464,118 536,262 184,262" />
              <text class="pro-svg-lbl-ok" x="360" y="206" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 12. `glass-orbit-gravity` — Core Goal Gravity & Orbiting Habit Satellites
  // =========================================================================
  if (kind === "glass-orbit-gravity") {
    const cardEl = spring(0.06, 0.9);
    const orbit1 = drawPath("M 136 144 A 224 84 0 1 0 584 144 A 224 84 0 1 0 136 144", "pro-svg-grid", 1040, 0.14, 0.72);
    const orbit2 = drawPath("M 212 144 A 148 52 0 1 1 508 144 A 148 52 0 1 1 212 144", "pro-svg-hero-line", 690, 0.26, 0.82);
    const coreEl = spring(0.32, 0.55);
    const satA = whip(0.48, -32);
    const satB = whip(0.62, 32);

    const kicker = escHtml(clip(meta?.kicker, "VARIETY ECOSYSTEM ORBIT", 28));
    const badge = escHtml(clip(meta?.badge, "ENGAGED", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "NEW ACTIVITIES", 16).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "WORKOUT BUDDY", 16).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 284" width="720" height="284" fill="none" aria-hidden="true">
            ${orbit1}${orbit2}
            <g data-el="${coreEl}">
              <circle class="pro-node-block" cx="360" cy="144" r="46" />
              <text class="pro-svg-lbl-ok" x="360" y="151" text-anchor="middle">GOAL</text>
            </g>
            <g data-el="${satA}">
              <rect class="pro-svg-panel" x="36" y="34" width="214" height="58" rx="16" />
              <text class="pro-svg-lbl" x="143" y="70" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${satB}">
              <rect class="pro-node-block" x="470" y="198" width="214" height="58" rx="16" />
              <text class="pro-svg-lbl-ok" x="577" y="234" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 13. `glass-step-staircase` — 4-Step Ascending Glassmorphism Momentum Bars
  // =========================================================================
  if (kind === "glass-step-staircase") {
    const cardEl = spring(0.06, 0.9);
    const arrow = drawPath("M 104 188 L 612 48", "pro-svg-hero-line", 540, 0.22, 0.85);
    const stepLabels = meta?.items && meta.items.length >= 4
      ? meta.items.slice(0, 4)
      : ["Foods", "Recipes", "Rewards", "Fresh ✓"];
    const heights = [68, 108, 148, 192];
    const xs = [64, 224, 384, 544];
    const cols = xs.map((x, idx) => {
      const el = grow(0.18 + idx * 0.12, 0.56);
      const lblEl = spring(0.28 + idx * 0.12, 0.72, 0.38);
      const h = heights[idx];
      const y = 230 - h;
      const isTop = idx === 3;
      return `<g>
        <rect class="${isTop ? "pro-node-block" : "pro-svg-panel"} pro-step-pillar" data-el="${el}" x="${x}" y="${y}" width="112" height="${h}" rx="14" />
        <text class="${isTop ? "pro-svg-lbl-ok" : "pro-svg-lbl"}" data-el="${lblEl}" x="${x + 56}" y="264" text-anchor="middle">${escHtml(clip(stepLabels[idx], `S${idx + 1}`, 9).toUpperCase())}</text>
      </g>`;
    });

    const kicker = escHtml(clip(meta?.kicker, "MOMENTUM PROGRESSION STEPS", 28));
    const badge = escHtml(clip(meta?.badge, "LEVEL UP", 16));

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 284" width="720" height="284" fill="none" aria-hidden="true">
            ${arrow}
            ${cols.join("")}
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // 14. `glass-prism-spectrum` — Input Beam -> Glass Prism -> 3 Split Rays
  // =========================================================================
  if (kind === "glass-prism-spectrum") {
    const cardEl = spring(0.06, 0.9);
    const inBeam = drawPath("M 54 156 L 292 156", "pro-svg-muted-dash", 250, 0.16, 0.48);
    const prismEl = spring(0.28, 0.62);
    const out1 = drawPath("M 402 122 L 520 68", "pro-svg-hero-line", 160, 0.42, 0.55);
    const out2 = drawPath("M 414 156 L 520 156", "pro-svg-grid", 140, 0.48, 0.55);
    const out3 = drawPath("M 402 190 L 520 238", "pro-svg-grid", 160, 0.54, 0.55);
    const tagsEl = whip(0.62, 32);

    const kicker = escHtml(clip(meta?.kicker, "DECISION SPECTRUM PRISM", 28));
    const badge = escHtml(clip(meta?.badge, "SWIFT SNAP", 16));
    const topOut = escHtml(clip(meta?.rightTitle, "PREFERRED ✓", 14).toUpperCase());
    const botOut = escHtml(clip(meta?.leftTitle, "REJECTED", 14).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-glass-rig">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 282" width="720" height="282" fill="none" aria-hidden="true">
            ${inBeam}${out1}${out2}${out3}
            <g data-el="${prismEl}">
              <polygon class="pro-node-block" points="350,52 264,234 436,234" />
              <text class="pro-svg-lbl-ok" x="350" y="196" text-anchor="middle">MIND</text>
            </g>
            <g data-el="${tagsEl}">
              <rect class="pro-node-block" x="522" y="38" width="166" height="56" rx="14" />
              <text class="pro-svg-lbl-ok" x="605" y="73" text-anchor="middle">${topOut}</text>
              <rect class="pro-svg-panel" x="522" y="208" width="166" height="52" rx="14" />
              <text class="pro-svg-lbl" x="605" y="241" text-anchor="middle">${botOut}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // =========================================================================
  // EXISTING 7 ULTRA-PRO RIGS (preserved intact for backward compatibility)
  // =========================================================================
  if (kind === "streak-shield") {
    const cardEl = spring(0.06, 0.9);
    const badgeEl = spring(0.22, 0.75);
    const kicker = escHtml(clip(meta?.kicker, "WEEKLY HABIT TELEMETRY", 28));
    const badge = escHtml(clip(meta?.badge, "86% CONSISTENT", 18));
    const tag = escHtml(clip(meta?.calloutTag, "1 SLIP", 12));
    const callout = escHtml(clip(meta?.calloutText, "1 Minor Misstep ≠ Routine Failed", 46));
    const days = [
      { d: "MON", ok: true },
      { d: "TUE", ok: true },
      { d: "WED", ok: false },
      { d: "THU", ok: true },
      { d: "FRI", ok: true },
      { d: "SAT", ok: true },
      { d: "SUN", ok: true },
    ];
    const dayCells = days
      .map((item, idx) => {
        const el = spring(0.16 + idx * 0.07, 0.68, 0.38);
        const sym = item.ok
          ? `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`
          : `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.8" fill="currentColor"/></svg>`;
        return `<div class="pro-day ${item.ok ? "pro-day-ok" : "pro-day-warn"}" data-el="${el}">
          <span class="pro-day-lbl">${item.d}</span>
          <div class="pro-day-ico">${sym}</div>
        </div>`;
      })
      .join("");
    const barEl = wipe(0.58, 0.85);
    const noteEl = whip(0.68, -32, 0.46);

    return {
      markup: `<div class="pro-stage pro-streak">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok" data-el="${badgeEl}">${badge}</span>
          </div>
          <div class="pro-day-grid">${dayCells}</div>
          <div class="pro-meter-track"><div class="pro-meter-fill" data-el="${barEl}" style="width:86%"></div></div>
          <div class="pro-callout-row" data-el="${noteEl}">
            <span class="pro-tag-warn">${tag}</span>
            <span class="pro-callout-txt">${callout}</span>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  if (kind === "obstacle-radar") {
    const topA = whip(0.08, -38);
    const topB = whip(0.2, 38);
    const mapCard = spring(0.28, 0.9);
    const deadLine = drawPath("M 92 150 L 320 150", "pro-svg-muted-dash", 240, 0.34, 0.45);
    const rerouteArc = drawPath(
      "M 92 150 C 185 150, 215 48, 350 48 C 485 48, 515 150, 628 150",
      "pro-svg-hero-line",
      660,
      0.48,
      0.92,
    );
    const startNode = spring(0.32, 0.5);
    const snagNode = spring(0.44, 0.5);
    const goalNode = spring(0.86, 0.5);
    const leftTitle = escHtml(clip(meta?.leftTitle, "Bad Weather", 22));
    const rightTitle = escHtml(clip(meta?.rightTitle, "Unusual Snags", 22));
    const kicker = escHtml(clip(meta?.kicker, "ADAPTIVE DETOUR ENGINE", 28));
    const badge = escHtml(clip(meta?.badge, "GOAL LOCKED", 16));

    return {
      markup: `<div class="pro-stage pro-radar">
        <div class="pro-bento-row">
          <div class="pro-mini-card" data-el="${topA}">
            <span class="pro-mini-kicker">FACTOR 01</span>
            <span class="pro-mini-title">${leftTitle}</span>
          </div>
          <div class="pro-mini-card pro-mini-accent" data-el="${topB}">
            <span class="pro-mini-kicker">FACTOR 02</span>
            <span class="pro-mini-title">${rightTitle}</span>
          </div>
        </div>
        <div class="pro-card pro-glass-card pro-route-card" data-el="${mapCard}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 220" width="720" height="220" fill="none" aria-hidden="true">
            ${deadLine}
            ${rerouteArc}
            <g data-el="${startNode}">
              <circle class="pro-node-ok" cx="92" cy="150" r="16" />
              <text class="pro-svg-lbl" x="92" y="196" text-anchor="middle">START</text>
            </g>
            <g data-el="${snagNode}">
              <rect class="pro-node-block" x="306" y="116" width="88" height="68" rx="14" />
              <text class="pro-svg-lbl-warn" x="350" y="157" text-anchor="middle">SNAG</text>
            </g>
            <g data-el="${goalNode}">
              <circle class="pro-node-goal" cx="628" cy="150" r="20" />
              <text class="pro-svg-lbl-ok" x="628" y="196" text-anchor="middle">TARGET</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  if (kind === "compound-blip") {
    const cardEl = spring(0.08, 0.9);
    const gridA = drawPath("M 70 230 L 660 230", "pro-svg-grid", 600, 0.14, 0.4);
    const gridB = drawPath("M 70 150 L 660 150", "pro-svg-grid", 600, 0.18, 0.4);
    const gridC = drawPath("M 70 70 L 660 70", "pro-svg-grid", 600, 0.22, 0.4);
    const curve = drawPath(
      "M 76 222 L 185 206 L 232 226 L 278 192 C 390 164, 510 112, 646 42",
      "pro-svg-hero-line",
      740,
      0.28,
      1.05,
    );
    const blipEl = spring(0.56, 0.45);
    const winEl = spring(0.92, 0.45);
    const kicker = escHtml(clip(meta?.kicker, "LONG-TERM COMPOUND HORIZON", 28));
    const badge = escHtml(clip(meta?.badge, "COMPOUNDING", 18));
    const leftTag = escHtml(clip(meta?.leftTitle, "SHORT DIP", 18).toUpperCase());
    const rightTag = escHtml(clip(meta?.rightTitle, "LONG-TERM GAIN", 18).toUpperCase());

    return {
      markup: `<div class="pro-stage">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 268" width="720" height="268" fill="none" aria-hidden="true">
            ${gridA}${gridB}${gridC}
            ${curve}
            <g data-el="${blipEl}">
              <circle class="pro-node-warn" cx="232" cy="226" r="13" />
              <rect class="pro-svg-tag-warn" x="114" y="238" width="236" height="28" rx="8" />
              <text class="pro-svg-tag-txt" x="232" y="257" text-anchor="middle">${leftTag}</text>
            </g>
            <g data-el="${winEl}">
              <circle class="pro-node-goal" cx="646" cy="42" r="16" />
              <rect class="pro-svg-tag-ok" x="414" y="18" width="212" height="32" rx="9" />
              <text class="pro-svg-tag-txt" x="520" y="39" text-anchor="middle">${rightTag}</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  if (kind === "crowd-asymmetry") {
    const hdrEl = spring(0.06, 0.88);
    const leftEl = whip(0.18, -42);
    const rightEl = whip(0.32, 42);
    const ray1 = drawPath("M 238 148 L 412 76", "pro-svg-hero-line", 220, 0.42, 0.55);
    const ray2 = drawPath("M 238 148 L 412 148", "pro-svg-hero-line", 200, 0.48, 0.55);
    const ray3 = drawPath("M 238 148 L 412 220", "pro-svg-hero-line", 220, 0.54, 0.55);
    const stampEl = spring(0.76, 0.65);

    const dots: string[] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 8; c++) {
        dots.push(`<circle class="pro-crowd-dot" cx="${452 + c * 28}" cy="${74 + r * 34}" r="6.5" />`);
      }
    }
    const kicker = escHtml(clip(meta?.kicker, "CASE FILE · ASYMMETRIC LEVERAGE", 30));
    const badge = escHtml(clip(meta?.badge, "HIGH LEVERAGE", 16));
    const statBig = escHtml(clip(meta?.statBig, "1%", 6));
    const leftLbl = escHtml(clip(meta?.leftTitle, "CORE TRIGGER", 14).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "SYSTEM IMPACT", 16).toUpperCase());
    const tag = escHtml(clip(meta?.calloutTag, "EVIDENCE", 14));
    const callout = escHtml(clip(meta?.calloutText, "Small concentrated force shifts the entire field", 48));

    return {
      markup: `<div class="pro-stage pro-dossier">
        <div class="pro-card pro-glass-card" data-el="${hdrEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-warn">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 286" width="720" height="286" fill="none" aria-hidden="true">
            ${ray1}${ray2}${ray3}
            <g data-el="${leftEl}">
              <rect class="pro-node-block" x="34" y="82" width="204" height="132" rx="18" />
              <text class="pro-svg-big" x="136" y="152" text-anchor="middle">${statBig}</text>
              <text class="pro-svg-lbl-warn" x="136" y="190" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${rightEl}">
              <rect class="pro-svg-panel" x="412" y="42" width="276" height="212" rx="18" />
              ${dots.join("")}
              <text class="pro-svg-lbl" x="550" y="238" text-anchor="middle">${rightLbl}</text>
            </g>
          </svg>
          <div class="pro-callout-row" data-el="${stampEl}">
            <span class="pro-tag-warn">${tag}</span>
            <span class="pro-callout-txt">${callout}</span>
          </div>
        </div>
      </div>`,
      anims,
    };
  }

  if (kind === "barcelona-timeline") {
    const thread = drawPath("M 118 82 L 118 426", "pro-svg-hero-line", 360, 0.16, 0.9);
    const c1 = whip(0.14, 38);
    const c2 = whip(0.4, 38);
    const c3 = whip(0.66, 38);

    const defaultRows = [
      { pin: "STAGE 1", title: "Initial Trigger", sub: "Hidden pressure builds beneath the surface" },
      { pin: "STAGE 2", title: "Tipping Point", sub: "Momentum locks in and reshapes behavior" },
      { pin: "STAGE 3", title: "Lasting Outcome", sub: "The new pattern becomes the default reality" },
    ];
    const srcRows = meta?.rows && meta.rows.length >= 3 ? meta.rows.slice(0, 3) : defaultRows;

    const row = (el: number, r: { pin: string; title: string; sub: string }) =>
      `<div class="pro-ev-card" data-el="${el}">
        <div class="pro-ev-pin">${escHtml(clip(r.pin, "STEP", 9))}</div>
        <div class="pro-ev-body">
          <div class="pro-ev-title">${escHtml(clip(r.title, "Key Shift", 32))}</div>
          <div class="pro-ev-sub">${escHtml(clip(r.sub, "", 54))}</div>
        </div>
      </div>`;

    return {
      markup: `<div class="pro-stage pro-dossier-tl">
        <svg class="pro-tl-thread" viewBox="0 0 240 500" width="240" height="500" fill="none" aria-hidden="true">${thread}</svg>
        <div class="pro-ev-stack">
          ${row(c1, srcRows[0])}
          ${row(c2, srcRows[1])}
          ${row(c3, srcRows[2])}
        </div>
      </div>`,
      anims,
    };
  }

  if (kind === "lab-apparatus") {
    const cardEl = spring(0.06, 0.9);
    const ring1 = drawPath("M 180 250 A 180 180 0 0 1 540 250", "pro-svg-grid", 580, 0.16, 0.55);
    const ring2 = drawPath("M 250 250 A 110 110 0 0 1 470 250", "pro-svg-grid", 360, 0.22, 0.5);
    const rayL = drawPath("M 360 254 L 166 86", "pro-svg-muted-dash", 270, 0.34, 0.55);
    const rayR = drawPath("M 360 254 L 554 86", "pro-svg-muted-dash", 270, 0.42, 0.55);
    const objL = spring(0.28, 0.55);
    const objR = spring(0.38, 0.55);
    const handEl = spring(0.54, 0.6);
    const kicker = escHtml(clip(meta?.kicker, "COGNITIVE DECISION LAB RIG", 28));
    const badge = escHtml(clip(meta?.badge, "SENSORS ARMED", 16));
    const leftLbl = escHtml(clip(meta?.leftTitle, "PATH A (IMPULSE)", 16).toUpperCase());
    const rightLbl = escHtml(clip(meta?.rightTitle, "PATH B (VALUE)", 16).toUpperCase());

    return {
      markup: `<div class="pro-stage pro-neuro">
        <div class="pro-card pro-glass-card" data-el="${cardEl}">
          <div class="pro-card-hdr">
            <span class="pro-kicker">${kicker}</span>
            <span class="pro-pill pro-pill-ok">${badge}</span>
          </div>
          <svg class="pro-route-svg" viewBox="0 0 720 296" width="720" height="296" fill="none" aria-hidden="true">
            ${ring1}${ring2}${rayL}${rayR}
            <g data-el="${objL}">
              <rect class="pro-svg-panel" x="52" y="34" width="228" height="76" rx="16" />
              <text class="pro-svg-lbl" x="166" y="80" text-anchor="middle">${leftLbl}</text>
            </g>
            <g data-el="${objR}">
              <rect class="pro-node-block" x="440" y="34" width="228" height="76" rx="16" />
              <text class="pro-svg-lbl-warn" x="554" y="80" text-anchor="middle">${rightLbl}</text>
            </g>
            <g data-el="${handEl}">
              <circle class="pro-node-goal" cx="360" cy="250" r="22" />
              <text class="pro-svg-lbl-ok" x="360" y="290" text-anchor="middle">DECISION CORE</text>
            </g>
          </svg>
        </div>
      </div>`,
      anims,
    };
  }

  // Default: "hand-swerve-arc" — Mid-flight Bezier trajectory override
  const cardEl = spring(0.06, 0.9);
  const impulseVec = drawPath("M 360 264 L 164 78", "pro-svg-muted-dash", 280, 0.16, 0.48);
  const swerveCurve = drawPath(
    "M 360 264 C 280 190, 212 146, 256 122 C 312 92, 446 98, 554 78",
    "pro-svg-hero-line",
    590,
    0.38,
    0.96,
  );
  const leftTarget = spring(0.2, 0.6);
  const pivotNode = spring(0.56, 0.45);
  const rightTarget = spring(0.88, 0.55);
  const noteEl = whip(0.74, -30);
  const kicker = escHtml(clip(meta?.kicker, "LIVE TRAJECTORY OVERRIDE", 28));
  const badge = escHtml(clip(meta?.badge, "COURSE SHIFT", 16));
  const leftLbl = escHtml(clip(meta?.leftTitle, "1ST IMPULSE", 15).toUpperCase());
  const rightLbl = escHtml(clip(meta?.rightTitle, "TRUE VALUE ✓", 15).toUpperCase());
  const tag = escHtml(clip(meta?.calloutTag, "OVERRIDE", 12));
  const callout = escHtml(clip(meta?.calloutText, "Deeper motive redirects action mid-flight", 46));

  return {
    markup: `<div class="pro-stage pro-neuro">
      <div class="pro-card pro-glass-card" data-el="${cardEl}">
        <div class="pro-card-hdr">
          <span class="pro-kicker">${kicker}</span>
          <span class="pro-pill pro-pill-warn">${badge}</span>
        </div>
        <svg class="pro-route-svg" viewBox="0 0 720 296" width="720" height="296" fill="none" aria-hidden="true">
          ${impulseVec}
          ${swerveCurve}
          <g data-el="${leftTarget}">
            <rect class="pro-svg-panel" x="52" y="30" width="224" height="72" rx="16" />
            <text class="pro-svg-lbl" x="164" y="74" text-anchor="middle">${leftLbl}</text>
          </g>
          <g data-el="${pivotNode}">
            <circle class="pro-node-warn" cx="256" cy="122" r="12" />
            <text class="pro-svg-lbl-warn" x="256" y="162" text-anchor="middle">PIVOT</text>
          </g>
          <g data-el="${rightTarget}">
            <rect class="pro-node-block" x="444" y="30" width="224" height="72" rx="16" />
            <text class="pro-svg-lbl-ok" x="556" y="74" text-anchor="middle">${rightLbl}</text>
          </g>
          <circle class="pro-node-ok" cx="360" cy="264" r="15" />
        </svg>
        <div class="pro-callout-row" data-el="${noteEl}">
          <span class="pro-tag-warn">${tag}</span>
          <span class="pro-callout-txt">${callout}</span>
        </div>
      </div>
    </div>`,
    anims,
  };
}
