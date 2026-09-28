"""Build test PDFs for book analysis, with PyMuPDF.

  python make-book-pdf.py text <out.pdf> <chapters.json> [--toc] [--pages-per-chapter N]
  python make-book-pdf.py scan <in.pdf> <out.pdf> [--dpi N]

`text` typesets chapters into a real text-layer PDF: a front-matter page, a
contents page, then each chapter starting on a new page with a large heading,
a running head at the top of every body page and a page number at the bottom
-- exactly the furniture the analyser has to strip. `--toc` also writes a PDF
outline. chapters.json is [{"title": str, "paragraphs": [str, ...]}, ...].

`scan` rasterises every page of an existing PDF into an image-only PDF with no
text layer at all: what a flatbed scanner produces, and what OCR must handle.
"""

import json
import sys

import pymupdf as fitz

W, H = 432, 648  # 6x9in trade paperback, in points
MARGIN = 54
BODY = 11
LEADING = 1.45


def typeset(out_path, chapters, with_toc):
    doc = fitz.open()
    font = fitz.Font("tiro")  # Times-Roman
    bold = fitz.Font("tibo")

    def new_page(running_head, number):
        page = doc.new_page(width=W, height=H)
        if running_head:
            page.insert_text((MARGIN, 30), running_head.upper(), fontsize=8, fontname="tiro")
        if number is not None:
            page.insert_text((W / 2 - 6, H - 24), str(number), fontsize=9, fontname="tiro")
        return page

    # Front matter: a title page and a contents page, which the analyser must
    # recognise as not-content.
    p = new_page(None, None)
    p.insert_text((MARGIN, 200), "A Field Guide to Habits", fontsize=24, fontname="tibo")
    p = new_page(None, None)
    p.insert_text((MARGIN, 90), "Contents", fontsize=18, fontname="tibo")
    for i, ch in enumerate(chapters):
        p.insert_text((MARGIN, 130 + i * 18), "%d. %s" % (i + 1, ch["title"]), fontsize=10, fontname="tiro")

    toc = []
    number = 1
    width = W - 2 * MARGIN
    line_h = BODY * LEADING

    for c_index, ch in enumerate(chapters):
        page = new_page(None, number)
        number += 1
        toc.append([1, ch["title"], doc.page_count])
        page.insert_text((MARGIN, 120), "Chapter %d" % (c_index + 1), fontsize=12, fontname="tibo")
        page.insert_text((MARGIN, 146), ch["title"], fontsize=20, fontname="tibo")
        y = 190

        for para in ch["paragraphs"]:
            words = para.split()
            line = []
            first = True
            while words:
                word = words.pop(0)
                trial = " ".join(line + [word])
                if font.text_length(trial, fontsize=BODY) <= width - (14 if first else 0):
                    line.append(word)
                    continue
                # Break long words with a hyphen when the line is short, so a
                # real hyphenated line break exists in the fixture.
                if len(word) > 9 and font.text_length(" ".join(line), fontsize=BODY) < width * 0.8:
                    cut = len(word) // 2
                    line.append(word[:cut] + "-")
                    words.insert(0, word[cut:])
                else:
                    words.insert(0, word)
                page.insert_text((MARGIN + (14 if first else 0), y), " ".join(line), fontsize=BODY, fontname="tiro")
                first = False
                line = []
                y += line_h
                if y > H - 60:
                    page = new_page(ch["title"], number)
                    number += 1
                    y = 72
            if line:
                page.insert_text((MARGIN + (14 if first else 0), y), " ".join(line), fontsize=BODY, fontname="tiro")
                y += line_h
            y += line_h * 0.4
            if y > H - 60:
                page = new_page(ch["title"], number)
                number += 1
                y = 72

    if with_toc:
        doc.set_toc(toc)
    doc.save(out_path)


def scan(in_path, out_path, dpi):
    src = fitz.open(in_path)
    out = fitz.open()
    for page in src:
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        img = out.new_page(width=page.rect.width, height=page.rect.height)
        img.insert_image(img.rect, stream=pix.tobytes("png"))
    out.save(out_path, deflate=True)


def main():
    mode = sys.argv[1]
    if mode == "text":
        out_path, chapters_path = sys.argv[2], sys.argv[3]
        with open(chapters_path, encoding="utf-8") as fh:
            chapters = json.load(fh)
        typeset(out_path, chapters, "--toc" in sys.argv)
    elif mode == "scan":
        dpi = 200
        if "--dpi" in sys.argv:
            dpi = int(sys.argv[sys.argv.index("--dpi") + 1])
        scan(sys.argv[2], sys.argv[3], dpi)
    else:
        sys.exit("unknown mode " + mode)


if __name__ == "__main__":
    main()
