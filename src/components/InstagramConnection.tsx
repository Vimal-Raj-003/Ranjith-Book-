"use client";

import { useEffect, useState } from "react";
import { Badge, Hint, Skeleton, StatRow, type BadgeTone } from "./ui";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import type { InstagramConnectionState, InstagramConnectionView } from "@/lib/publish/instagram-connection";

/**
 * The Instagram account connection, in the Publish panel.
 *
 * It is account-level (not per video), so it sits above the per-video flow and
 * fetches its own state: the Publish view every platform shares is untouched.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 * 1. THE PERSON SIGNS IN. "Connect Instagram" opens a normal Chrome window on
 *    BookReel's own Instagram profile (the existing `POST /api/publish/browser/signin`)
 *    and BookReel then waits. It never types a password, a code or a cookie, and it
 *    never tries to get past a security check.
 *
 * 2. A STATE IS EARNED, NOT ASSUMED. Not Connected until the right account was seen
 *    signed in; Eligible only after Instagram's own composer showed Schedule
 *    content. Until then Instagram publishing stays unavailable and the card says so.
 *
 * 3. NOTHING IS POSTED OR SWITCHED ON. The Schedule content check loads a blank
 *    placeholder clip and discards it, and is behind a confirmation. The two
 *    publishing flags are the operator's: the card only reports them.
 */

const c = strings.publishCenter.instagramConnect;

const TONE: Record<InstagramConnectionState, BadgeTone> = {
  not_connected: "cancelled",
  connected: "live",
  eligible: "done",
  not_eligible: "failed",
};

export type ConnectBusy = "connect" | "verify" | "schedule" | null;

function when(iso: string | null): string {
  if (!iso) return c.never;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? c.never : d.toLocaleString();
}

export function InstagramConnectionCard({
  view,
  loadError,
  busy,
  note,
  connectError = null,
  onConnect,
  onVerify,
  onCheckScheduling,
  onReload,
}: {
  view: InstagramConnectionView | null;
  loadError: string | null;
  busy: ConnectBusy;
  /** The sentence the sign-in route sent back after opening the window. */
  note: string | null;
  /** The sentence it sent back when it could NOT open one you can see. Kept on the card until the next try. */
  connectError?: string | null;
  onConnect: () => void;
  onVerify: () => void;
  onCheckScheduling: () => void;
  onReload: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  if (!view) {
    return (
      <div className="pub-connect" data-instagram-connection="loading">
        <div className="pub-platform-head">
          <p className="eyebrow">{c.heading}</p>
        </div>
        {loadError ? (
          <div className="flex flex-col gap-2" role="alert">
            <Hint>{loadError}</Hint>
            <div className="pub-actions">
              <button type="button" className="chip" onClick={onReload}>
                <span className="truncate">{c.retry}</span>
              </button>
            </div>
          </div>
        ) : (
          <Skeleton height={56} />
        )}
      </div>
    );
  }

  const { state, check, flags, browser } = view;
  const running = check.running || busy !== null;
  const known = state === "connected" || state === "eligible" || state === "not_eligible";
  const attach = browser.kind === "attach";
  const flagsOn = flags.publish && flags.nativeSchedule;
  const anyFlag = flags.publish || flags.nativeSchedule;

  return (
    <div className="pub-connect" data-instagram-connection="ready" data-state={state}>
      <div className="pub-platform-head">
        <p className="eyebrow">{c.heading}</p>
        <Badge tone={TONE[state]}>{c.stateLabel[state]}</Badge>
      </div>

      <Hint>{c.stateNote[state]}</Hint>
      {/* Before anything has ever been checked the state note above already says it; a reason is for what a check FOUND. */}
      {view.reason && view.checkedAt !== null && (
        <p className="text-[12px]" style={{ color: "var(--ink)" }} data-instagram-reason>
          {view.reason}
        </p>
      )}

      <div data-instagram-facts>
        <StatRow label={c.publishesTo} value={view.expected} />
        <StatRow label={c.signedInAs} value={view.handle ?? "—"} />
        {known && <StatRow label={c.accountType} value={c.accountKind[view.accountKind]} />}
        {known && <StatRow label={c.scheduleContent} value={c.composer[view.composer]} />}
        {known && <StatRow label={c.calendarLabel} value={view.calendar === "readable" ? c.calendar.readable(view.scheduledCount) : c.calendar[view.calendar]} />}
        <StatRow label={c.lastChecked} value={when(view.checkedAt)} />
      </div>
      {view.stale && <Hint>{c.stale}</Hint>}

      {state === "not_connected" && !attach && (
        <div className="flex flex-col gap-1">
          <p className="field-label">{c.stepsHeading}</p>
          <ol className="list-decimal pl-5 text-[12px]" style={{ color: "var(--ink)" }}>
            {c.steps(view.expected).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <Hint>{c.intro}</Hint>
        </div>
      )}

      {attach && <Hint>{c.attachNote}</Hint>}
      {browser.kind === "bundled" && <Hint>{c.bundledNote}</Hint>}
      {browser.headless && <Hint>{c.headlessNote}</Hint>}
      {!browser.ready && browser.reason && <Hint>{c.browserNotReady(browser.reason)}</Hint>}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {connectError && (
        <div className="flex flex-col gap-1" role="alert" data-instagram-connect-error>
          <p className="field-label">{c.connectErrorHeading}</p>
          <Hint>{connectError}</Hint>
        </div>
      )}

      {check.running && (
        <div className="flex flex-col gap-1" role="status" aria-live="polite" data-instagram-running>
          <p className="text-[12px]" style={{ color: "var(--ink)" }}>
            {c.running}
            {check.step ? ` ${check.step}` : ""}
          </p>
          <Hint>{c.runningNote}</Hint>
        </div>
      )}
      {check.error && !check.running && (
        <div className="flex flex-col gap-1" role="alert" data-instagram-error>
          <p className="field-label">{c.errorHeading}</p>
          <Hint>{check.error}</Hint>
        </div>
      )}

      <div className="pub-actions">
        {!attach && (
          <button
            type="button"
            className={state === "not_connected" ? "pub-primary" : "chip"}
            aria-disabled={running ? "true" : undefined}
            onClick={() => !running && onConnect()}
            data-instagram-connect
          >
            <span className="truncate">
              {busy === "connect" ? c.connecting : state === "not_connected" ? c.connect : c.connectAgain}
            </span>
          </button>
        )}
        <button
          type="button"
          className="chip"
          aria-disabled={running ? "true" : undefined}
          onClick={() => !running && onVerify()}
          data-instagram-verify
        >
          <span className="truncate">{busy === "verify" ? c.verifying : c.verify}</span>
        </button>
      </div>

      {known && (
        <div className="flex flex-col gap-1" data-instagram-schedule-check>
          <p className="field-label">{c.scheduleDisclosureHeading}</p>
          <Hint>{c.scheduleDisclosure}</Hint>
          <label className="flex items-start gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>{c.scheduleConfirm}</span>
          </label>
          <div className="pub-actions">
            <button
              type="button"
              className="chip"
              aria-disabled={running || !confirmed ? "true" : undefined}
              onClick={() => !running && confirmed && onCheckScheduling()}
              data-instagram-check-scheduling
            >
              <span className="truncate">
                {busy === "schedule" ? c.checkingScheduling : state === "connected" ? c.checkScheduling : c.recheckScheduling}
              </span>
            </button>
          </div>
        </div>
      )}
      {state === "not_eligible" && <Hint>{c.fixAccount}</Hint>}

      <div className="flex flex-col gap-1" data-instagram-flags>
        <p className="field-label">{c.flagsHeading}</p>
        {state === "eligible" ? (
          flagsOn ? (
            <Hint>{c.flagsOn}</Hint>
          ) : (
            <>
              <Hint>{c.flagsNext}</Hint>
              {c.flagsLines.map((line) => (
                <code key={line}>{line}</code>
              ))}
            </>
          )
        ) : anyFlag ? (
          <Hint>{c.flagsBlocked}</Hint>
        ) : (
          <Hint>{c.flagsOff}</Hint>
        )}
        {state === "eligible" && !flagsOn && anyFlag && <Hint>{c.flagsPartial}</Hint>}
      </div>
    </div>
  );
}

type Wire = { connection?: InstagramConnectionView; message?: string; error?: string };

async function call(url: string, body: unknown): Promise<{ ok: boolean; data: Wire }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Wire };
}

export default function InstagramConnection() {
  const toast = useToast();
  const [view, setView] = useState<InstagramConnectionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConnectBusy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** Bumped to read the server again: the retry button, and each tick while a check runs. */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/publish/browser/instagram", { cache: "no-store", signal: ac.signal });
        const data = (await res.json().catch(() => ({}))) as Wire;
        if (!live) return;
        if (!res.ok || !data.connection) {
          setLoadError(data.error ?? c.loadFailed);
          return;
        }
        setView(data.connection);
        setLoadError(null);
      } catch {
        // An aborted read is this component moving on, not a failure.
        if (live) setLoadError(c.loadFailed);
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [reloads]);

  // While a check runs the server is the clock: ask it, and stop the moment it says it is done.
  const running = view?.check.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setReloads((n) => n + 1), 2_000);
    return () => clearInterval(timer);
  }, [running]);

  async function connect() {
    setBusy("connect");
    setConnectError(null);
    try {
      const { ok, data } = await call("/api/publish/browser/signin", { platform: "instagram" });
      if (!ok) {
        // On the card, not only in a toast that fades: this is the one place the person looks for why no window opened.
        const why = data.error ?? strings.publishCenter.browser.signIn.failed;
        setNote(null);
        setConnectError(why);
        toast.show(why, "error");
        return;
      }
      setNote(data.message ?? c.afterConnect);
      toast.show(strings.publishCenter.browser.signIn.opened, "ok");
    } catch {
      setNote(null);
      setConnectError(strings.publishCenter.browser.signIn.failed);
      toast.show(strings.publishCenter.browser.signIn.failed, "error");
    } finally {
      setBusy(null);
    }
  }

  async function check(body: { action: "verify" } | { action: "check_scheduling"; confirm: true }, as: "verify" | "schedule") {
    setBusy(as);
    setNote(null);
    setConnectError(null);
    try {
      const { ok, data } = await call("/api/publish/browser/instagram", body);
      if (!ok || !data.connection) {
        toast.show(data.error ?? c.loadFailed, "error");
        return;
      }
      setView(data.connection);
    } catch {
      toast.show(c.loadFailed, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <InstagramConnectionCard
      view={view}
      loadError={loadError}
      busy={busy}
      note={note}
      connectError={connectError}
      onConnect={() => void connect()}
      onVerify={() => void check({ action: "verify" }, "verify")}
      onCheckScheduling={() => void check({ action: "check_scheduling", confirm: true }, "schedule")}
      onReload={() => setReloads((n) => n + 1)}
    />
  );
}
