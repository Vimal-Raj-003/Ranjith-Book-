import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { previewVoice, type PreviewFailure } from "@/lib/media/voice-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Typed over the failure codes, so a new code cannot ship without deciding what
 * it answers with. The UI keys off the code, not the status: 400 is a request
 * that will never work, 503 is one that may work in a moment.
 */
const STATUS: Record<PreviewFailure["code"], number> = {
  bad_voice: 400,
  voice_unavailable: 503,
};

/**
 * Let the operator hear a voice before committing a render to it.
 *
 * Auth, then `previewVoice`, then a response — and nothing else. The work lives
 * in `lib/media/voice-preview.ts` because this handler cannot be called from a
 * test (`requireUser` reads `cookies()`). It has no episode, writes no row and
 * does not touch the pipeline: acceptance criterion 14.
 */
export async function POST(req: Request) {
  try {
    await requireUser();
    const body: unknown = await req.json().catch(() => null);
    const voiceId = body && typeof body === "object" ? (body as { voiceId?: unknown }).voiceId : undefined;

    const result = await previewVoice(voiceId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: STATUS[result.code] });
    }

    // A few seconds of speech, so read whole rather than streamed.
    let audio: Buffer;
    try {
      audio = await fs.readFile(result.path);
    } catch {
      // Gone between being made and being read: cannot be heard right now, which
      // is a 503, not the empty 500 the UI cannot tell from a dropped connection.
      return NextResponse.json(
        { error: "The preview could not be read back. Try again.", code: "voice_unavailable" },
        { status: STATUS.voice_unavailable },
      );
    }
    return new Response(new Uint8Array(audio), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
