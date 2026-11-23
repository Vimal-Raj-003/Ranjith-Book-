/**
 * Ultra-Pro Creator Interactive Motion Models (`pro-stage.ts`).
 *
 * Builds rich, multi-layered, seek-safe visual metaphor & concrete-example rigs
 * (Apple VisionOS Bento telemetry widgets, Johnny Harris investigative evidence
 * boards & scale-disproportion rigs, and Kurzgesagt/Cleo Abram neuroscience
 * physics trajectory simulators).
 *
 * Supports dynamic episode-grounded labels (`ProModelMeta`) so ANY book episode
 * generated through the app populates these motion rigs with its own spoken ideas,
 * while preserving deterministic defaults when `meta` is omitted.
 */

export type ProModelKind =
  | "streak-shield"
  | "obstacle-radar"
  | "compound-blip"
  | "crowd-asymmetry"
  | "barcelona-timeline"
  | "lab-apparatus"
  | "hand-swerve-arc";

export interface ProModelMeta {
  kicker?: string;
  badge?: string;
  leftTitle?: string;
  rightTitle?: string;
  statBig?: string;
  calloutTag?: string;
  calloutText?: string;
  rows?: Array<{ pin: string; title: string; sub: string }>;
}

export interface ProModelAnimSpec {
  el: number;
  kind: "spring-card" | "whip-pan" | "wipe" | "draw";
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

  const drawPath = (d: string, cls: string, dash: number, delaySec: number, durSec = 0.82): string => {
    const el = nextEl++;
    anims.push({ el, kind: "draw", delaySec, durSec, val: dash });
    return `<path class="${cls}" data-el="${el}" d="${d}" stroke-dasharray="${dash}" stroke-dashoffset="${dash}" />`;
  };

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
        <div class="pro-card" data-el="${cardEl}">
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
        <div class="pro-card pro-route-card" data-el="${mapCard}">
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
        <div class="pro-card" data-el="${cardEl}">
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
        <div class="pro-card" data-el="${hdrEl}">
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
      { pin: "STAGE 2", title: " tipping Point", sub: "Momentum locks in and reshapes behavior" },
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
        <div class="pro-card" data-el="${cardEl}">
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
      <div class="pro-card" data-el="${cardEl}">
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
