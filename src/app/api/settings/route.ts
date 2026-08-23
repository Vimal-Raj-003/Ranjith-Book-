import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { isBookThemeId, DEFAULT_BOOK_THEME_ID } from "@/lib/video/composition/themes";

/**
 * Operator settings that apply to the NEXT run.
 *
 * The theme is deliberately not retroactive: it is stamped onto each episode
 * when the episode is created, so changing it here never re-skins something
 * already rendered. An episode's look and the file on disk must always agree.
 */
export async function GET() {
  try {
    await requireUser();
    const theme = await getSetting("theme");
    return NextResponse.json({
      theme: isBookThemeId(theme) ? theme : DEFAULT_BOOK_THEME_ID,
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function PUT(req: Request) {
  try {
    await requireUser();
    const body: unknown = await req.json().catch(() => null);
    const theme = body && typeof body === "object" ? (body as { theme?: unknown }).theme : undefined;

    // Only an id this build actually implements is storable. An unknown string
    // written here would be resolved back to the default at render time
    // anyway, so accepting it would show the operator a selection that silently
    // does nothing — worse than refusing it.
    if (!isBookThemeId(theme)) {
      return NextResponse.json(
        { error: "That is not a theme this build has.", code: "bad_theme" },
        { status: 400 },
      );
    }

    await setSetting("theme", theme);
    return NextResponse.json({ theme });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
