import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { setSetting } from "@/lib/db";
import { errorBody, errorStatus } from "@/lib/errors";
import {
  checkAndDispatchScheduleReminders,
  clearScheduleReminderDismissal,
  dismissScheduleReminderForToday,
  evaluateScheduleReminder,
} from "@/lib/schedule/reminder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const status = await evaluateScheduleReminder(user.id);
    if (status.due && !process.env.BOOKREEL_TEST_DB_PID) {
      await checkAndDispatchScheduleReminders();
    }
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Send a JSON object.", code: "bad_body" },
        { status: 400 },
      );
    }

    const payload = body as { enabled?: unknown; dismissForDate?: unknown };
    if (payload.enabled !== undefined) {
      if (typeof payload.enabled !== "boolean") {
        return NextResponse.json(
          { error: "`enabled` must be a boolean.", code: "bad_value" },
          { status: 400 },
        );
      }
      await setSetting("scheduleReminder", payload.enabled ? "on" : "off");
      if (payload.enabled) {
        await clearScheduleReminderDismissal(user.id);
      }
    }

    if (payload.dismissForDate !== undefined) {
      if (typeof payload.dismissForDate !== "string") {
        return NextResponse.json(
          { error: "`dismissForDate` must be a YYYY-MM-DD date string.", code: "bad_value" },
          { status: 400 },
        );
      }
      await dismissScheduleReminderForToday(user.id, payload.dismissForDate);
    }

    const status = await evaluateScheduleReminder(user.id);
    if (status.due && !process.env.BOOKREEL_TEST_DB_PID) {
      await checkAndDispatchScheduleReminders();
    }
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
