"use client";

import { useEffect, useState } from "react";
import IdentityStatus from "./IdentityStatus";
import { Badge, Hint, StatRow } from "./ui";
import { useToast } from "./Toast";
import {
  CONNECT_PARAM,
  CONNECT_REASON_PARAM,
  connectCopy,
  identityCopy,
  isConnectResult,
  type ConnectionView,
} from "@/lib/publish/connect";
import type { PlatformState } from "@/lib/publish/view";

/**
 * The YouTube connection, and the one button that uploads.
 *
 * It is its own component rather than more of `PublishCenter` because what it
 * renders is about an OAUTH GRANT, which is a different subject from an
 * episode's metadata: it has its own fetch, its own lifecycle (connect,
 * revoke), and its own copy. `PublishCenter` hands it the platform state it
 * already has and a callback to accept whatever a publish returns.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 * 1. NO SECRET REACHES THIS FILE. The only thing it fetches about the
 *    connection is `ConnectionView`, which has no token field to read — see
 *    `lib/publish/connect.ts`. There is no client ID here, no redirect URI, and
 *    nothing to put in a header: Connect is a plain navigation to a server
 *    route, which does the redirecting.
 *
 * 2. NO SYNTHETIC PROGRESS. The bar's width comes from two byte counts the
 *    server read off YouTube's own `Range` headers. When either is missing
 *    there is NO BAR — a sentence instead. Nothing here interpolates, animates
 *    towards a guess, or starts at 10% to look busy.
 *
 * 3. NOTHING CLAIMS A POST THE PLATFORM DID NOT CONFIRM. The review block
 *    renders only when the job carries a `publishedAt` AND an `externalId`, and
 *    the only producer of those is a platform response. The Publish button says
 *    "as private", every time, because that is the only thing it does.
 */

/** Only an app path or an https URL may become an href. The same guard the panel uses. */
function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  if (href.startsWith("/")) return href;
  return /^https:\/\//i.test(href) ? href : null;
}

/**
 * The measured bar, or nothing.
 *
 * `width` is set from a style value computed here rather than from a CSS
 * variable chosen by a status, because the only honest width is the ratio of
 * two numbers the platform gave us.
 */
function Progress({ sent, total }: { sent: number | null; total: number | null }) {
  if (sent === null || total === null || total <= 0) {
    return <Hint>{connectCopy.progressUnknown}</Hint>;
  }
  const ratio = Math.max(0, Math.min(1, sent / total));
  return (
    <div className="flex flex-col gap-1">
      <div
        className="pub-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={sent}
        aria-valuetext={connectCopy.progressValue(sent, total)}
      >
        <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
      <span className="hint">
        {connectCopy.progressLabel}: {connectCopy.progressValue(sent, total)}
      </span>
    </div>
  );
}

export default function YouTubePublish({
  episodeId,
  state,
  owned,
  onPublished,
}: {
  episodeId: string | null;
  state: PlatformState;
  /** False for an episode this account does not own — see `PublishView.owned`. */
  owned: boolean;
  /** Hand the server's answer back, so the panel repaints from one source. */
  onPublished: (view: Record<string, unknown>) => void;
}) {
  const toast = useToast();
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [busy, setBusy] = useState<"disconnect" | "publish" | null>(null);

  /**
   * Read the connection, once.
   *
   * Separate from the publish view because it is per-USER, not per-episode:
   * switching episodes must not re-ask anything about the grant. It needs no
   * refresh trigger either — a connect is a full navigation (so this remounts)
   * and a disconnect answers with the new state, which is taken directly.
   */
  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/publish/youtube", { cache: "no-store", signal: ac.signal });
        const body = (await res.json().catch(() => null)) as ConnectionView | null;
        if (!live || !res.ok || !body) return;
        setConnection(body);
      } catch {
        // An aborted or failed read leaves the card in its "unknown" state,
        // which renders as the unconfigured copy — never as "connected".
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, []);

  /**
   * What the OAuth callback redirected back with.
   *
   * Read once, reported, and then removed from the URL, so a refresh does not
   * re-announce a connection that happened ten minutes ago.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get(CONNECT_PARAM);
    if (!isConnectResult(result)) return;
    const reason = url.searchParams.get(CONNECT_REASON_PARAM);

    // A connection that went through but is not the expected channel comes back
    // as "connected" WITH a reason: that is a warning, not a success.
    if (result === "connected") toast.show(reason ?? connectCopy.resultConnected, reason ? "warn" : "ok");
    else if (result === "denied") toast.show(reason ?? connectCopy.resultDenied, "warn");
    else toast.show(reason ?? connectCopy.resultFailed, "error");

    url.searchParams.delete(CONNECT_PARAM);
    url.searchParams.delete(CONNECT_REASON_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // No refetch is asked for here on purpose: this runs on mount, and so does
    // the effect above, so the connection is already being read. Calling
    // `setReloads` here would be a setState in an effect body — a cascading
    // render React's own lint rightly refuses — for a request that is in flight
    // anyway.
    // Once, on mount: the URL cannot change without a navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const config = connection?.config ?? null;
  const configured = config?.configured ?? false;
  const connected = connection?.connected ?? false;
  const job = state.job;
  const inFlight = state.status === "PREPARING" || state.status === "UPLOADING";
  const published = Boolean(job?.publishedAt && job.externalId);
  /**
   * The browser-window route holds this episode: a post the platform is holding
   * for later, or an attempt that stopped for a person and may already be up.
   * Either way a second upload by this route could duplicate it, so no button.
   */
  const heldByBrowser = state.status === "SCHEDULED" || state.status === "AWAITING_HUMAN";
  /** The platform's own API named a different (or no) channel, and the server refuses an upload on it. */
  const identityBlocks = connection?.identityBlocksPublish ?? false;

  /**
   * Connect is an ORDINARY LINK, not a fetch and not a router push.
   *
   * The server answers it with a 303 to accounts.google.com, and only a real
   * navigation follows a cross-origin redirect. A `fetch` would read the Google
   * sign-in page into JavaScript — which is both useless and the beginning of
   * the one thing this integration must never do. A `router.push` cannot leave
   * the app at all.
   *
   * It also means no URL carrying the `state` is ever held by a script: the
   * browser goes straight from this href to Google.
   *
   * WHERE IT COMES BACK TO is decided by the server from the `Referer`, not
   * passed from here. Computing it in the browser would mean either reading
   * `window` during render (a hydration mismatch, because the server has no
   * location) or keeping it in state set from an effect (a cascading render).
   * The route validates whatever it derives through `safeReturnTo`, so an
   * app-relative path is the only thing that can come out either way.
   */
  const connectHref = "/api/publish/youtube/connect";

  async function disconnect() {
    setBusy("disconnect");
    try {
      const res = await fetch("/api/publish/youtube", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.show(typeof body.error === "string" ? body.error : connectCopy.resultFailed, "error");
        return;
      }
      if (body.revoked === false && typeof body.revokeProblem === "string") {
        // Half-done is reported as half-done.
        toast.show(connectCopy.revokeFailed(body.revokeProblem), "warn");
      } else {
        toast.show(connectCopy.disconnected, "ok");
      }
      setConnection(body as unknown as ConnectionView);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!episodeId) return;
    setBusy("publish");
    try {
      const res = await fetch(`/api/episodes/${episodeId}/publish/youtube`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.show(typeof body.error === "string" ? body.error : connectCopy.uploadFailed, "error");
        return;
      }
      onPublished(body);
      toast.show(connectCopy.uploadStarted, "ok");
    } finally {
      setBusy(null);
    }
  }

  const studioHref = safeHref(job?.reviewUrl);

  return (
    <div className="pub-connect">
      <div className="pub-platform-head">
        <p className="eyebrow">{connectCopy.heading}</p>
        <Badge tone={connected ? "done" : configured ? "live" : "soon"}>
          {connected ? connectCopy.grantedLabel : configured ? "Not connected" : "Not configured"}
        </Badge>
      </div>

      {/* The three states, each said plainly. Nothing is implied by an absent
          control: if a button is missing, the sentence above it says why. */}
      {!configured && (
        <>
          <p className="hint">{connectCopy.notConfigured}</p>
          {config && config.missing.length > 0 && (
            <div className="pub-rows">
              <p className="eyebrow">{connectCopy.missingLabel}</p>
              <ul className="pub-requires" role="list">
                {config.missing.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {config?.keyProblem && <Hint>{config.keyProblem}</Hint>}
        </>
      )}

      {configured && !connected && (
        <>
          <p className="hint">{connection?.problem ?? connectCopy.notConnected}</p>
          <div className="pub-actions">
            <a className="chip" data-state="on" href={connectHref}>
              <span className="truncate">
                {connection?.problem ? connectCopy.reconnect : connectCopy.connect}
              </span>
            </a>
          </div>
          <Hint>{connectCopy.consentNote}</Hint>
        </>
      )}

      {configured && connected && (
        <>
          <p className="hint">{connectCopy.connectedTo(connection?.channelTitle ?? null)}</p>
          {connection?.connectedAt && (
            <span className="hint">{connectCopy.since(new Date(connection.connectedAt).toLocaleString())}</span>
          )}
          {connection && connection.scopes.length > 0 && (
            <ul className="pub-requires" role="list">
              {connection.scopes.map((s) => (
                <li key={s}>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          )}

          {/* Which channel this is, as YouTube's own API reported it. A wrong
              or unconfirmed channel is a blocking alert; a connection that
              predates verification is a warning that says how to verify. */}
          {connection && <IdentityStatus platform="YouTube" connection={connection} />}

          {/* The upload. Offered only for an episode this account owns, only
              when the platform would accept it, and never while one is already
              in flight. A channel the API says is the wrong one gets a sentence
              instead of a button. */}
          {!owned ? (
            <Hint>{connectCopy.notOwned}</Hint>
          ) : published || heldByBrowser ? null : identityBlocks ? (
            <Hint>{identityCopy.publishBlocked}</Hint>
          ) : (
            <>
              <div className="pub-actions">
                <button
                  type="button"
                  className="chip"
                  data-state="on"
                  aria-disabled={busy !== null || inFlight || state.problems.length > 0 ? "true" : undefined}
                  onClick={() => busy === null && !inFlight && state.problems.length === 0 && void publish()}
                >
                  <span className="truncate">{busy === "publish" ? connectCopy.publishing : connectCopy.publish}</span>
                </button>
              </div>
              <Hint>{connectCopy.publishNote}</Hint>
            </>
          )}

          <div className="pub-actions">
            <button
              type="button"
              className="chip"
              aria-disabled={busy !== null ? "true" : undefined}
              onClick={() => busy === null && void disconnect()}
            >
              <span className="truncate">{busy === "disconnect" ? connectCopy.disconnecting : connectCopy.disconnect}</span>
            </button>
          </div>
          <Hint>{connectCopy.disconnectNote}</Hint>
        </>
      )}

      {/* Real progress, from the platform's own accounting. */}
      {inFlight && <Progress sent={job?.uploadedBytes ?? null} total={job?.totalBytes ?? null} />}

      {/* Confirmed, and only confirmed. `published` needs both a platform id
          and a platform timestamp; nothing local can produce either. */}
      {published && job && (
        <div className="pub-rows">
          <p className="eyebrow">{connectCopy.reviewHeading}</p>
          <StatRow label={connectCopy.videoIdLabel} value={job.externalId ?? ""} />
          <StatRow label={connectCopy.privacyLabel} value={job.privacyStatus ?? "—"} />
          <StatRow
            label={connectCopy.thumbnailLabel}
            value={
              job.thumbnailStatus === "APPLIED"
                ? connectCopy.thumbnailApplied
                : job.thumbnailStatus === "FAILED"
                  ? connectCopy.thumbnailFailed
                  : connectCopy.thumbnailSkipped
            }
          />
          {/* The reason a thumbnail did not land, verbatim. A video that
              succeeded is never reported as a failure because of this. */}
          {job.thumbnailStatus === "FAILED" && job.thumbnailError && <Hint>{job.thumbnailError}</Hint>}
          {studioHref && (
            <div className="pub-actions">
              <a className="chip" data-state="on" href={studioHref} target="_blank" rel="noopener noreferrer">
                <span className="truncate">{connectCopy.openStudio}</span>
              </a>
            </div>
          )}
          <Hint>{connectCopy.reviewNote}</Hint>
        </div>
      )}
    </div>
  );
}
