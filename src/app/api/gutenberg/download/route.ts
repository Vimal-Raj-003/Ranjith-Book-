import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { downloadBook } from "@/lib/gutenberg/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy one Project Gutenberg file so the browser gets it from this origin.
 *
 * The whole security argument lives in `downloadBook`, and the shape of this
 * route is what makes that argument possible: it takes an `id` and a `format`,
 * and there is deliberately no parameter that carries a URL. A route that
 * accepted `?url=` would be a server-side request forgery hole no amount of
 * validation downstream could close, because the caller would be choosing the
 * destination. Here the caller chooses a row in someone else's catalogue, and
 * this app chooses the URL.
 *
 * Any extra query parameter a caller invents is simply never read.
 */
export async function GET(req: Request) {
  try {
    await requireUser();

    const params = new URL(req.url).searchParams;
    const result = await downloadBook(params.get("id"), params.get("format"));

    if (!result.ok) {
      // `bad_request` is the caller's fault; everything else is upstream's.
      // 502 rather than 500 so a Gutenberg outage is not logged as a bug here.
      const status = result.code === "bad_request" ? 400 : result.code === "not_found" ? 404 : 502;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    const { bytes, filename, contentType } = result.value;

    // RFC 5987: the ASCII `filename` is the fallback, `filename*` carries the
    // real one. Both are quoted/encoded, and `safeFilename` has already
    // stripped the control characters that could otherwise split this header.
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
    const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": disposition,
        // Never let a browser sniff its way to text/html on this origin.
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
