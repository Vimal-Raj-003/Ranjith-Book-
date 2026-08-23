/**
 * The sheet, the type, and the one function that both lays a page out and
 * measures it.
 *
 * The measuring is the point. On the photographed path nobody controls where
 * the words landed, so the app runs a vision model for the text, OCR for the
 * geometry, and an LCS alignment to reconcile the two — with a confidence
 * floor below which a page gives up on word-level highlighting altogether.
 * Here the layout engine that PUT each word on the page is asked where it
 * put it, so the boxes are not an estimate of the render: they are the
 * render. There is nothing for an alignment to reconcile and nothing for a
 * confidence floor to catch.
 *
 * The rule this file exists to keep is that the boxes and the screenshot come
 * from the SAME DOM, in the same state, in the same pixel space. Nothing may
 * relayout between the measurement and the screenshot.
 */

import type { TypesetWord } from "./text";

/**
 * The sheet, in pixels.
 *
 * 1600 on the long edge because that is exactly what `deriveForComposition`
 * produces for a photograph, and every stage downstream is calibrated to that
 * space: OCR boxes, line runs, sweep steps and camera keys are all measured in
 * it, `columnScale()` maps it onto the card, and `cardViewportHeight()` turns
 * the card's height back into it. A page that arrived at any other scale would
 * put the marker in the right place on the wrong-sized image.
 *
 * 1100 on the short edge for the same reason at one remove: `build.ts` cites
 * "about 1283 [column pixels] for a typical 1600-long-edge portrait page" as
 * the card viewport height, which is `CARD_H / (CARD_W / width)` — i.e. a
 * width of 1100. Choosing the width the camera maths was calibrated against
 * keeps this path inside the geometry the photographed path already proved,
 * and 1100x1600 is a 1:1.45 sheet, between a trade paperback (1:1.5) and a
 * hardback octavo — it reads as a book, not as a screen.
 */
export const PAGE = { width: 1100, height: 1600 } as const;

/**
 * The type block. Everything else on the sheet is positioned from these.
 *
 * The measure is the load-bearing number: 908px of text at a 29px serif is
 * about 63 characters a line, inside the 60-75 that centuries of book design
 * settled on and this app's spec asks for. Leading of 1.72 is generous for
 * print and necessary here — the marker is a band drawn over a word's box, and
 * tight leading makes consecutive bands touch, which reads as a smear rather
 * than as a highlight.
 */
export const TYPE = {
  size: 29,
  leading: 1.72,
  /** Left edge of the type block. */
  left: 96,
  /** Width of the type block — the measure. */
  width: 908,
  /** Top edge of the type block. */
  top: 176,
  /** Height of the type block. About 25 lines, so ~270 words a page. */
  height: 1248,
} as const;

/**
 * Serif faces in the order they are wanted, ending in the generic `serif` so
 * the page still typesets somewhere none of them exist. This mirrors the
 * stack style already used by the thumbnail renderer: real system faces
 * first, the Liberation/DejaVu pair for a Linux render host, then the
 * generic.
 *
 * Determinism is per-machine, not cross-machine: the same box renders the same
 * bytes every time, but a host with different fonts installed will break lines
 * differently — and, because the boxes are measured from that host's own
 * layout, still correctly. The images and their boxes always agree.
 */
const SERIF = `"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman","Liberation Serif","DejaVu Serif",serif`;

/**
 * The sheet's HTML. Set once per run; `renderAndMeasure` fills it repeatedly.
 *
 * The paper is a warm off-white with a soft vignette and a gutter shadow down
 * the inner edge, because a flat `#fff` rectangle of type is the exact failure
 * this feature has to avoid: it looks like a text file. The grade is kept
 * light enough that the ink stays near-black against it — this image is going
 * to be scaled to 87% inside a 1080-wide frame and then watched on a phone.
 */
export function pageShell(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#e7dccb; }
  #page {
    position:relative; width:${PAGE.width}px; height:${PAGE.height}px; overflow:hidden;
    background-color:#f6f0e4;
    background-image:
      radial-gradient(115% 85% at 50% 42%, rgba(255,252,245,0.85) 0%, rgba(246,240,228,0) 62%),
      linear-gradient(90deg, rgba(94,68,38,0.16) 0px, rgba(94,68,38,0.03) 58px, rgba(94,68,38,0) 132px),
      radial-gradient(125% 95% at 50% 50%, rgba(0,0,0,0) 58%, rgba(86,60,30,0.13) 100%);
    color:#221d17;
    font-family:${SERIF};
    -webkit-font-smoothing:antialiased;
  }
  #head {
    position:absolute; left:${TYPE.left}px; top:78px; width:${TYPE.width}px; height:34px;
    font-size:17px; line-height:34px; letter-spacing:0.19em; text-transform:uppercase;
    text-align:center; color:#6b5a45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  #rule {
    position:absolute; left:${TYPE.left + 150}px; top:124px; width:${TYPE.width - 300}px; height:1px;
    background:rgba(107,90,69,0.42);
  }
  #body {
    position:absolute; left:${TYPE.left}px; top:${TYPE.top}px;
    width:${TYPE.width}px; height:${TYPE.height}px; overflow:hidden;
    font-size:${TYPE.size}px; line-height:${TYPE.leading};
    text-align:justify; text-justify:inter-word;
    /* No auto-hyphenation: Chromium only hyphenates where a dictionary
       happens to be installed, so hyphens:auto would silently re-break
       every line on one host and not on another. */
    hyphens:manual;
    /* A single word longer than the measure breaks rather than bleeding
       into the margin — see the box-per-fragment note in renderAndMeasure. */
    overflow-wrap:break-word;
  }
  #body p { margin:0; text-indent:2em; }
  /* A paragraph carried over from the previous page resumes flush left; only
     a paragraph that actually begins here is indented. */
  #body p.cont { text-indent:0; }
  /* The page's last line, when the paragraph runs on to the next page. It is
     the last line of this BLOCK but not of the paragraph, and justification
     leaves a block's last line ragged — so without this the bottom line of
     every mid-paragraph page break stops short of the right margin, which no
     printed book does. */
  #body p.spill { text-align-last:justify; }
  .em { font-style:italic; }
  #folio {
    position:absolute; left:${TYPE.left}px; top:1476px; width:${TYPE.width}px;
    text-align:center; font-size:24px; color:#6b5a45; font-variant-numeric:oldstyle-nums;
  }
</style></head>
<body>
  <div id="page">
    <div id="head"></div>
    <div id="rule"></div>
    <div id="body"></div>
    <div id="folio"></div>
  </div>
</body></html>`;
}

/** What one page's laid-out words are worth measuring for. */
export interface PageRequest {
  words: TypesetWord[];
  /** Running head. Empty hides the head and its rule. */
  head: string;
  /** Printed page number. Empty hides the folio. */
  folio: string;
  /** True when `words[0]` continues the paragraph the previous page ended in. */
  continues: boolean;
  /** True when the last word runs on into the next page's first paragraph. */
  spills: boolean;
}

/** A word rectangle in sheet pixels, before rounding. */
export interface RawRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Measurement {
  /** The bottom of the type block, in sheet pixels. A word below it overflowed. */
  bodyBottom: number;
  /** One rect per requested word, in the same order. */
  rects: RawRect[];
}

/**
 * Lay `req.words` out on the sheet and report where every one of them landed.
 *
 * Runs INSIDE the browser (it is handed to `page.evaluate`), so it must stay
 * self-contained: no imports, no closure over anything in this module, no
 * TypeScript that needs a runtime helper. The argument carries everything.
 *
 * Two calls per page is the whole pagination algorithm. The first lays out
 * far more words than can fit and reports which ones fell past the bottom of
 * the type block; the second lays out only the ones that fit, and THAT layout
 * is what gets screenshotted and what the returned boxes describe. The second
 * pass is not a formality: truncating the flow turns the last surviving line
 * into a paragraph's last line, which justification leaves ragged rather than
 * flush — so every word on that line moves. Measuring before the truncation
 * and screenshotting after it would put the marker in the wrong place on
 * exactly one line of every page, which is the kind of bug that looks like a
 * timing problem for a week.
 *
 * A word broken across two lines (only possible for a word longer than the
 * measure) has two client rects; the wider one wins. A marker on the larger
 * half of a broken word is the best single box that exists for it — a hull of
 * both fragments would span the full measure and two lines, painting over
 * words that are not in the beat.
 */
export function renderAndMeasure(req: PageRequest): Measurement {
  const page = document.getElementById("page") as HTMLElement;
  const body = document.getElementById("body") as HTMLElement;
  const head = document.getElementById("head") as HTMLElement;
  const rule = document.getElementById("rule") as HTMLElement;
  const folio = document.getElementById("folio") as HTMLElement;

  head.textContent = req.head;
  rule.style.display = req.head ? "block" : "none";
  folio.textContent = req.folio;

  while (body.firstChild) body.removeChild(body.firstChild);

  const spans: HTMLElement[] = [];
  let para: HTMLElement | null = null;
  let openParagraph = -1;

  for (let i = 0; i < req.words.length; i++) {
    const w = req.words[i];
    if (para === null || w.paragraph !== openParagraph) {
      para = document.createElement("p");
      if (i === 0 && req.continues) para.className = "cont";
      body.appendChild(para);
      openParagraph = w.paragraph;
    } else {
      // A real text node, not a CSS gap: justification stretches the spaces
      // between words, and the words' own boxes have to move with it.
      para.appendChild(document.createTextNode(" "));
    }
    const span = document.createElement("span");
    if (w.italic) span.className = "em";
    span.textContent = w.word;
    para.appendChild(span);
    spans.push(span);
  }

  // Plain concatenation and no `??` anywhere below: this function's SOURCE is
  // what runs in the browser, and it must survive whatever transpiler the app
  // is bundled with without picking up a reference to a runtime helper that
  // does not exist over there.
  if (req.spills && para) para.className = para.className ? para.className + " spill" : "spill";

  const origin = page.getBoundingClientRect();
  const block = body.getBoundingClientRect();

  const rects: RawRect[] = spans.map((span) => {
    const list = span.getClientRects();
    let best: DOMRect | null = null;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!best || r.width > best.width) best = r;
    }
    const r = best ? best : span.getBoundingClientRect();
    return {
      x0: r.left - origin.left,
      y0: r.top - origin.top,
      x1: r.right - origin.left,
      y1: r.bottom - origin.top,
    };
  });

  return { bodyBottom: block.bottom - origin.top, rects };
}
