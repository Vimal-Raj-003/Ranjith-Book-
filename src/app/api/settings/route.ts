import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import {
  SETTING_FALLBACKS,
  SETTING_KEYS,
  isSettingKey,
  validateSetting,
  type SettingKey,
} from "@/lib/settings/keys";

/**
 * Operator settings that apply to the NEXT run.
 *
 * The theme is deliberately not retroactive: it is stamped onto each episode
 * when the episode is created, so changing it here never re-skins something
 * already rendered. An episode's look and the file on disk must always agree.
 *
 * Which keys exist, and what each may hold, is `settings/keys.ts` — an
 * allow-list, so this route can never become a way to write an API key.
 */
export async function GET() {
  try {
    await requireUser();
    const entries = await Promise.all(
      SETTING_KEYS.map(async (key) => {
        const stored = await getSetting(key);
        // Re-validated on the way out: a row written by an older build (a theme
        // since removed, a mood renamed) must degrade to the fallback here
        // rather than hand the UI a selection that PUT would now refuse.
        const effective = stored === null ? null : validateSetting(key, stored);
        return [key, effective ?? SETTING_FALLBACKS[key]] as const;
      }),
    );
    return NextResponse.json(Object.fromEntries(entries));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

function bad(error: string, code: string, key?: string) {
  return NextResponse.json(key ? { error, code, key } : { error, code }, { status: 400 });
}

export async function PUT(req: Request) {
  try {
    await requireUser();
    const body: unknown = await req.json().catch(() => null);

    // An array is an object to `typeof`, and `Object.keys` of one yields its
    // indices — it would fall through to "unknown key 0" instead of saying what
    // is actually wrong with the request.
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("Send a JSON object of settings.", "bad_body");
    }
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) {
      // A request that changes nothing and says "ok" hides a client that is
      // sending the wrong shape.
      return bad("No setting was given.", "bad_body");
    }

    // Validate every key before writing any. A body with one good value and one
    // bad one must not half-apply: the caller would be told 400 and the good
    // value would be stored anyway.
    const accepted: Array<[SettingKey, string]> = [];
    for (const [key, value] of entries) {
      if (!isSettingKey(key)) {
        return bad(`"${key}" is not a setting that can be changed here.`, "bad_key", key);
      }
      const validated = validateSetting(key, value);
      if (validated === null) {
        // `theme` keeps the code this route has always answered with, so
        // anything that already handles it keeps working. An unknown string
        // written here would be resolved back to deriving the theme anyway, so
        // accepting it would show the operator a selection that silently does
        // nothing — worse than refusing it.
        if (key === "theme") return bad("That is not a theme this build has.", "bad_theme");
        return bad(`That is not a value this build accepts for "${key}".`, "bad_value", key);
      }
      accepted.push([key, validated]);
    }

    for (const [key, validated] of accepted) await setSetting(key, validated);
    // Echo what was stored (the normalised form, not the raw input), so a
    // caller sees "-22" even if it sent -22. A theme-only PUT still answers
    // `{ theme }`, as it always did.
    return NextResponse.json(Object.fromEntries(accepted));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
