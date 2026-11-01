"use client";

import { useState } from "react";
import { Badge, Disclosure, Hint, StatRow } from "./ui";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import type { PlatformState } from "@/lib/publish/view";

/**
 * The OPTIONAL browser-window route to a platform, and the one button that starts
 * it. It sits BESIDE the official-API card and never replaces it: the API card is
 * still rendered above this one, the hand-off below it, and the copy here says
 * which of the three is the recommended way.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 * 1. IT SAYS WHAT IT IS. A real browser window opens on the computer running
 *    BookReel; the operator may have to sign in there; it drives a website that
 *    can change under it; the API is the recommended route. All of that is on the
 *    card before the button, not behind it. When the server is set to attach to
 *    the operator's OWN Chrome (`state.browser.attach`) the card says that
 *    instead -- BookReel opens nothing, manages nothing and closes nothing of
 *    theirs -- and lists the steps to start that Chrome, open if it cannot be reached.
 *    When it is set to open the INSTALLED Chrome (`state.browser.channel`) the card
 *    says that instead: a real Chrome on a dedicated BookReel profile, signed in to
 *    by hand, never the personal profile -- and that Google may still refuse a
 *    sign-in in an automated window.
 *
 * 2. NOTHING IS DECLARED OR CONFIRMED ON THE OPERATOR'S BEHALF. "Made for kids"
 *    has NO default -- the button stays inert until one is chosen -- and anything
 *    that goes live (every Instagram share, a public or scheduled YouTube post)
 *    takes a second press that sends `confirmPublic: true`. The server refuses
 *    without both, so this is the honest rendering of refusals that exist.
 *
 * 3. A STOP FOR A PERSON IS SHOWN AS ONE. `AWAITING_HUMAN` is not a failure and
 *    not a success: the card shows the reason verbatim, and offers Retry only
 *    behind a box the operator ticks to say they looked at the platform. Nothing
 *    here retries by itself, and the server refuses a retry without that box.
 *
 * 4. NO POSTED CLAIM OF ITS OWN. A scheduled or posted result is rendered from
 *    the job row, whose id and time came from the platform's own page. This card
 *    never writes "posted" because a request succeeded.
 *
 * 5. NO SECRET, PROFILE OR COOKIE CROSSES THIS FILE. The sign-in lives in a
 *    Chromium profile on the server's disk; the browser sees `BrowserModeView`,
 *    which has no field to put one in.
 *
 * 6. THE SIGN-IN BUTTON ONLY ASKS. In channel mode on YouTube the card offers
 *    "Sign in to YouTube": a POST that makes the SERVER open a plain Chrome on the
 *    dedicated profile, for the operator to sign in to by hand, once. It sends the
 *    platform name and nothing else, receives a sentence back, and never sees a
 *    password, a cookie or the profile. Google refuses sign-ins in automated
 *    browsers, so the card says to sign in there, close it, and then publish.
 */

/** Only an app path or an https URL may become an href. The same guard the panel uses. */
function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  if (href.startsWith("/")) return href;
  return /^https:\/\//i.test(href) ? href : null;
}

type Visibility = "private" | "unlisted" | "public";

/** The port in the configured address, for the example command. Chrome's usual one when it cannot be read. */
function portOf(endpoint: string): string {
  try {
    return new URL(endpoint).port || "9222";
  } catch {
    return "9222";
  }
}

export default function BrowserPublish({
  episodeId,
  state,
  owned,
  onPublished,
}: {
  episodeId: string | null;
  state: PlatformState;
  /** False for an episode this account does not own -- see `PublishView.owned`. */
  owned: boolean;
  /** Hand the server's answer back, so the panel repaints from one source. */
  onPublished: (view: Record<string, unknown>) => void;
}) {
  const c = strings.publishCenter.browser;
  const toast = useToast();
  const browser = state.browser;
  const job = state.job;
  const isYouTube = state.platform === "youtube";
  /** Set when the route attaches to the operator's own Chrome instead of opening one. */
  const attach = browser?.attach ?? null;
  /** Set when the route opens the INSTALLED Chrome/Edge on a dedicated profile (never when attaching: that outranks it). */
  const channel = !attach ? (browser?.channel ?? null) : null;

  const [visibility, setVisibility] = useState<Visibility>("private");
  const [schedule, setSchedule] = useState("");
  /** No default, on purpose: it is a declaration the operator makes. */
  const [kids, setKids] = useState<"yes" | "no" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [looked, setLooked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  /** The server's instruction after the sign-in window opened, kept on the card (a toast is gone in seconds). */
  const [signInNote, setSignInNote] = useState<string | null>(null);

  if (!browser) return null;

  const inFlight = state.status === "PREPARING" || state.status === "UPLOADING";
  const awaiting = state.status === "AWAITING_HUMAN";
  const scheduled = state.status === "SCHEDULED";
  const posted = Boolean(job?.publishedAt && job.externalId);
  const settled = scheduled || posted;

  /** A schedule is public-at-a-time, so it takes the same confirmation as "public". */
  const goesPublic = !isYouTube || visibility === "public" || schedule !== "";
  const needsAnswer = isYouTube && kids === null;
  const blocked =
    busy || inFlight || state.problems.length > 0 || needsAnswer || (awaiting && !looked) || !browser.available;

  async function start() {
    if (!episodeId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/publish/browser`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: state.platform,
          // Sent as true only from the second press, for anything that goes live.
          confirmPublic: goesPublic,
          acknowledgeRetry: awaiting && looked,
          ...(isYouTube
            ? {
                visibility,
                madeForKids: kids === "yes",
                scheduledAt: schedule ? new Date(schedule).toISOString() : null,
              }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.show(typeof body.error === "string" ? body.error : c.failed, "error");
        return;
      }
      onPublished(body);
      setLooked(false);
      toast.show(c.started, "ok");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  /** Open the one-time sign-in window (a plain Chrome on the dedicated profile). It carries no secret either way. */
  async function signIn() {
    if (signingIn) return;
    setSigningIn(true);
    try {
      const res = await fetch("/api/publish/browser/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: state.platform }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setSignInNote(null);
        toast.show(typeof body.error === "string" ? body.error : c.signIn.failed, "error");
        return;
      }
      setSignInNote(typeof body.message === "string" ? body.message : c.signIn.opened);
      toast.show(c.signIn.opened, "ok");
    } finally {
      setSigningIn(false);
    }
  }

  const reviewHref = safeHref(job?.reviewUrl);

  return (
    <div className="pub-connect">
      <div className="pub-platform-head">
        <p className="eyebrow">{c.eyebrow}</p>
        <Badge tone="plain">{c.optional}</Badge>
      </div>

      <p className="hint">
        {attach
          ? c.attachIntro(state.label, attach.endpoint)
          : channel
            ? c.channelIntro(state.label, c.channelName[channel] ?? channel)
            : c.intro(state.label)}
      </p>
      <Hint>{c.recommend}</Hint>
      {channel && isYouTube && !settled && !inFlight && (
        <>
          <Hint>{c.channelYouTube}</Hint>
          <Hint>{c.channelNote}</Hint>
        </>
      )}

      {/* Open when Chrome could not be reached; a folded reminder otherwise. */}
      {attach && !settled && !inFlight && (
        <Disclosure summary={c.attachStepsHeading} defaultOpen={!browser.available} quiet>
          <ol className="pub-requires">
            {c.attachSteps(state.label, portOf(attach.endpoint)).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <Hint>{c.attachNote}</Hint>
        </Disclosure>
      )}

      {!browser.available ? (
        <Hint>{browser.reason ?? c.unavailable}</Hint>
      ) : !owned ? (
        <Hint>{c.notOwned}</Hint>
      ) : settled ? (
        <div className="pub-rows">
          {scheduled && job?.scheduledFor && <Hint>{c.scheduledFor(new Date(job.scheduledFor).toLocaleString())}</Hint>}
          {job?.externalId && <StatRow label={c.scheduledId} value={job.externalId} />}
          {job?.mode === "browser" && <Hint>{c.viaBrowser}</Hint>}
          {scheduled && reviewHref && (
            <div className="pub-actions">
              <a className="chip" data-state="on" href={reviewHref} target="_blank" rel="noopener noreferrer">
                <span className="truncate">{strings.publishCenter.openOn(state.label)}</span>
              </a>
            </div>
          )}
        </div>
      ) : inFlight ? (
        <p className="hint" role="status">
          {c.working}
        </p>
      ) : (
        <>
          {browser.headless && <Hint>{c.headless}</Hint>}

          {/* A stop for a person: the reason, verbatim, and no Retry without the box. */}
          {awaiting && (
            <div className="pub-problems" role="alert">
              <p className="eyebrow">{c.stoppedHeading}</p>
              <p className="text-[12px]" style={{ color: "var(--ink)" }}>
                {job?.lastError ?? c.stoppedNote}
              </p>
              <Hint>{c.stoppedNote}</Hint>
              {job?.externalId ? (
                <Hint>{c.alreadySeen}</Hint>
              ) : (
                <label className="flex items-start gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
                  <input type="checkbox" checked={looked} onChange={(e) => setLooked(e.target.checked)} />
                  <span>{c.ackLabel}</span>
                </label>
              )}
            </div>
          )}

          {/* Channel mode, YouTube: sign in once in a PLAIN Chrome on the dedicated profile; the publish reuses it. */}
          {channel && isYouTube && !(awaiting && job?.externalId) && (
            <div className="flex flex-col gap-1">
              <p className="field-label">{c.signIn.heading}</p>
              <Hint>{c.signIn.intro(c.channelName[channel] ?? channel)}</Hint>
              <div className="pub-actions">
                <button
                  type="button"
                  className="chip"
                  aria-disabled={signingIn ? "true" : undefined}
                  onClick={() => void signIn()}
                >
                  <span className="truncate">{signingIn ? c.signIn.opening : c.signIn.button}</span>
                </button>
              </div>
              {signInNote && (
                <p className="hint" role="status">
                  {signInNote}
                </p>
              )}
              <Hint>{c.signIn.closeFirst}</Hint>
            </div>
          )}

          {isYouTube && !(awaiting && job?.externalId) && (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="field-label">{c.kidsLegend}</legend>
                <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
                  <input type="radio" name={`kids-${state.platform}`} checked={kids === "no"} onChange={() => setKids("no")} />
                  <span>{c.kidsNo}</span>
                </label>
                <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
                  <input type="radio" name={`kids-${state.platform}`} checked={kids === "yes"} onChange={() => setKids("yes")} />
                  <span>{c.kidsYes}</span>
                </label>
                <Hint>{c.kidsNote}</Hint>
              </fieldset>

              <label className="field-label" htmlFor={`bv-${state.platform}`}>
                {c.visibilityLabel}
              </label>
              <select
                id={`bv-${state.platform}`}
                className="control"
                value={schedule ? "public" : visibility}
                disabled={schedule !== ""}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
              >
                <option value="private">{c.visibilityPrivate}</option>
                <option value="unlisted">{c.visibilityUnlisted}</option>
                <option value="public">{c.visibilityPublic}</option>
              </select>

              {browser.canSchedule && (
                <>
                  <label className="field-label" htmlFor={`bs-${state.platform}`}>
                    {c.scheduleLabel}
                  </label>
                  <input
                    id={`bs-${state.platform}`}
                    className="control"
                    type="datetime-local"
                    value={schedule}
                    onChange={(e) => {
                      setSchedule(e.target.value);
                      setConfirming(false);
                    }}
                  />
                  <Hint>{c.scheduleNote}</Hint>
                </>
              )}
            </>
          )}

          {!isYouTube && <Hint>{c.igPublicNote}</Hint>}

          {awaiting && job?.externalId ? null : !confirming || !goesPublic ? (
            <div className="pub-actions">
              <button
                type="button"
                className="chip"
                data-state="on"
                aria-disabled={blocked ? "true" : undefined}
                onClick={() => {
                  if (blocked) return;
                  if (goesPublic) setConfirming(true);
                  else void start();
                }}
              >
                <span className="truncate">{busy ? c.publishing : awaiting ? c.retry : c.publish}</span>
              </button>
            </div>
          ) : (
            <div className="pub-problems" role="alertdialog" aria-label={c.confirmYes}>
              <p className="text-[12px]" style={{ color: "var(--ink)" }}>
                {c.confirmPublic}
              </p>
              <div className="pub-actions">
                <button
                  type="button"
                  className="chip"
                  data-state="on"
                  aria-disabled={busy ? "true" : undefined}
                  onClick={() => !busy && void start()}
                >
                  <span className="truncate">{busy ? c.publishing : c.confirmYes}</span>
                </button>
                <button
                  type="button"
                  className="chip"
                  aria-disabled={busy ? "true" : undefined}
                  onClick={() => !busy && setConfirming(false)}
                >
                  <span className="truncate">{c.confirmNo}</span>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
