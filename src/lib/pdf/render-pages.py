"""Render chosen PDF pages to JPEG at a chosen resolution.

Separate from extract.py on purpose: extract.py walks the whole book and writes
word boxes, per-page JSON and a manifest. This renders a handful of named pages
and nothing else, for the composition's high-resolution page assets.

A page with no extractable text is SKIPPED: it is a scan, and upscaling a
photograph adds no detail, only bytes.

Usage: python render-pages.py <pdf> <out_dir> <long_edge> <index,index,...>

Writes <out_dir>/page-NNNN@2x.jpg per rendered page, then one JSON line:
  {"type": "done", "rendered": [8, 10], "skipped": [11]}
A failure is one line {"type": "error", "code": ..., "message": ...} and exit 2.
"""

import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    sys.exit(2)


def main():
    args = sys.argv[1:]
    if len(args) < 4:
        fail("usage", "usage: render-pages.py <pdf> <out_dir> <long_edge> <indices>")
    pdf_path, out_dir, long_edge, indices = args[0], args[1], int(args[2]), args[3]
    want = [int(i) for i in indices.split(",") if i.strip() != ""]

    try:
        import pymupdf as fitz
    except ImportError:
        fail("no_pymupdf", "PyMuPDF is not installed for this interpreter")

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        fail("open_failed", str(exc))

    rendered, skipped = [], []
    for index in want:
        if index < 0 or index >= doc.page_count:
            skipped.append(index)
            continue
        page = doc[index]
        # A scan has no text layer. Upscaling its photograph buys nothing.
        if len(page.get_text("text").strip()) == 0:
            skipped.append(index)
            continue
        rect = page.rect
        scale = long_edge / max(rect.width, rect.height)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        pix.save("%s/page-%04d@2x.jpg" % (out_dir, index), jpg_quality=88)
        rendered.append(index)

    doc.close()
    emit({"type": "done", "rendered": rendered, "skipped": skipped})


if __name__ == "__main__":
    main()
