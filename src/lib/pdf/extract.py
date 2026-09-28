"""Dump a PDF's raw page data for BookReel's book analysis.

Deliberately dumb: this script only reads what PyMuPDF measures -- words with
their boxes, line font sizes, the outline, how much of each page is a picture --
and renders each page to a JPEG. Every *decision* (what is a running head, what
is a chapter, which pages need OCR) is made in TypeScript, where it is unit
tested. Keeping judgement out of here means the Python side never needs to
change when a heuristic does.

Usage: python extract.py <pdf> <out_dir> [--max-pages N] [--long-edge PX]

Writes <out_dir>/page-NNNN.jpg and <out_dir>/page-NNNN.json per page, then
<out_dir>/manifest.json. Progress goes to stdout as JSON lines:
  {"type": "start", "pageCount": N}
  {"type": "page", "index": i}
  {"type": "done"}
A failure is one line {"type": "error", "code": ..., "message": ...} and exit 2,
so the caller can show the operator a sentence instead of a traceback.
"""

import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    sys.exit(2)


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        fail("usage", "usage: extract.py <pdf> <out_dir> [--max-pages N] [--long-edge PX]")
    pdf_path, out_dir = args[0], args[1]
    max_pages = 200
    long_edge = 1600
    rest = args[2:]
    for i in range(0, len(rest) - 1, 2):
        if rest[i] == "--max-pages":
            max_pages = int(rest[i + 1])
        elif rest[i] == "--long-edge":
            long_edge = int(rest[i + 1])

    try:
        import pymupdf as fitz  # PyMuPDF >= 1.24 name
    except ImportError:
        try:
            import fitz  # older PyMuPDF
        except ImportError:
            fail("no_pymupdf", "PyMuPDF is not installed for this Python. Run: npm run setup:pdf")

    try:
        doc = fitz.open(pdf_path)
    except Exception as err:  # noqa: BLE001 -- any open failure is the same sentence to the operator
        fail("unreadable", "This file could not be opened as a PDF (%s)." % err)

    if doc.needs_pass:
        fail("encrypted", "This PDF is password-protected. Remove the password and upload it again.")
    if not doc.is_pdf:
        fail("not_pdf", "This file is not a PDF.")
    if doc.page_count == 0:
        fail("empty", "This PDF has no pages.")
    if doc.page_count > max_pages:
        fail(
            "too_many_pages",
            "This PDF has %d pages; at most %d can be analysed at once." % (doc.page_count, max_pages),
        )

    os.makedirs(out_dir, exist_ok=True)
    emit({"type": "start", "pageCount": doc.page_count})

    # Ligatures expanded (no TEXT_PRESERVE_LIGATURES), so "ﬁnd" reads as "find"
    # and matches what a narrator will say. Clipped to the page so text parked
    # off-canvas by a layout program is never read as body text.
    word_flags = fitz.TEXT_MEDIABOX_CLIP | fitz.TEXT_PRESERVE_WHITESPACE

    for index in range(doc.page_count):
        page = doc.load_page(index)
        rect = page.rect
        scale = long_edge / max(rect.width, rect.height)
        matrix = fitz.Matrix(scale, scale)

        pix = page.get_pixmap(matrix=matrix, alpha=False)
        stem = "page-%04d" % index
        image_path = os.path.join(out_dir, stem + ".jpg")
        pix.save(image_path, jpg_quality=88)

        words = []
        for w in page.get_text("words", flags=word_flags, sort=True):
            x0, y0, x1, y1, text, block, line, wno = w[:8]
            words.append([
                round(x0 * scale, 1), round(y0 * scale, 1),
                round(x1 * scale, 1), round(y1 * scale, 1),
                text, block, line, wno,
            ])

        # Line-level font facts, for heading detection. One entry per line: the
        # largest span size on it and whether any span is bold.
        lines = []
        try:
            data = page.get_text("dict", flags=word_flags, sort=True)
            for b_no, block in enumerate(data.get("blocks", [])):
                if block.get("type") != 0:
                    continue
                for l_no, line in enumerate(block.get("lines", [])):
                    spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
                    if not spans:
                        continue
                    text = "".join(s["text"] for s in spans).strip()
                    size = max(s.get("size", 0) for s in spans)
                    bold = any((s.get("flags", 0) & 16) or "bold" in s.get("font", "").lower() for s in spans)
                    x0, y0, x1, y1 = line["bbox"]
                    lines.append({
                        "text": text,
                        "size": round(size, 2),
                        "bold": bool(bold),
                        "chars": len(text),
                        "box": [round(x0 * scale, 1), round(y0 * scale, 1), round(x1 * scale, 1), round(y1 * scale, 1)],
                    })
        except Exception:  # noqa: BLE001 -- font facts are an optimisation, never required
            lines = []

        # How much of the page is covered by pictures: the signal (with an
        # empty text layer) that a page is a scan and needs OCR.
        image_area = 0.0
        image_count = 0
        try:
            for info in page.get_image_info():
                bx0, by0, bx1, by1 = info["bbox"]
                w_ = max(0.0, min(bx1, rect.x1) - max(bx0, rect.x0))
                h_ = max(0.0, min(by1, rect.y1) - max(by0, rect.y0))
                image_area += w_ * h_
                image_count += 1
        except Exception:  # noqa: BLE001
            pass
        page_area = max(1.0, rect.width * rect.height)

        label = ""
        try:
            label = page.get_label() or ""
        except Exception:  # noqa: BLE001
            label = ""

        with open(os.path.join(out_dir, stem + ".json"), "w", encoding="utf-8") as fh:
            json.dump({
                "index": index,
                "label": label,
                "image": stem + ".jpg",
                "width": pix.width,
                "height": pix.height,
                "words": words,
                "lines": lines,
                "imageCount": image_count,
                "imageCoverage": round(min(1.0, image_area / page_area), 3),
            }, fh, ensure_ascii=False)

        emit({"type": "page", "index": index})
        pix = None
        page = None

    toc = []
    try:
        for level, title, page_no in doc.get_toc(simple=True):
            toc.append({"level": level, "title": title, "page": page_no - 1})
    except Exception:  # noqa: BLE001
        toc = []

    meta = doc.metadata or {}
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "pageCount": doc.page_count,
            "toc": toc,
            "metadata": {"title": meta.get("title") or None, "author": meta.get("author") or None},
        }, fh, ensure_ascii=False)

    doc.close()
    emit({"type": "done"})


if __name__ == "__main__":
    main()
