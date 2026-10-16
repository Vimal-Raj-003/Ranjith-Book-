"use client";

import { useEffect, useState } from "react";
import IdentityStatus from "./IdentityStatus";
import { Badge, Hint } from "./ui";
import { useToast } from "./Toast";
import {
  INSTAGRAM_CONNECT_PARAM,
  INSTAGRAM_CONNECT_REASON_PARAM,
  identityCopy,
  instagramCopy,
  isConnectResult,
  type ConnectionView,
} from "@/lib/publish/connect";
import type { PlatformState } from "@/lib/publish/view";

/**
 * The Instagram connection, and the one button that posts.
 *
 * It mirrors `YouTubePublish` and is written to the same rules, plus the ones
 * Instagram adds:
 *
 * 1. NO SECRET REACHES THIS FILE. The only thing it fetches about the connection
 *    is `ConnectionView`, which has no token field. Connect is a plain
 *    navigation to a server route, which does the redirecting.
 *
 * 2. THE ACCOUNT IS SHOWN AS INSTAGRAM REPORTED IT. The verified handle comes
 *    from `ConnectionView.verifiedHandle`, which the server fills only from an
 *    API answer. When it is not the expected one the card says so in an alert and
 *    offers NO publish control at all — the server refuses too, so this is the
 *    honest rendering of a refusal that exists, not the guard.
 *
 * 3. POSTING IS PUBLIC AND IMMEDIATE, and the card says so before it asks. The
 *    Content Publishing API has no draft and no private mode, so the first press
 *    only opens a confirmation, and only the second sends `confirmPublic: true`.
 *
 * 4. NO SYNTHETIC PROGRESS. This API reports no byte count, so there is no bar:
 *    while it works the card says which stage it is in, in words.
 *
 * 5. NOTHING CLAIMS A POST THE PLATFORM DID NOT CONFIRM. This card renders no
 *    "posted" claim of its own: the confirmed id, time and link are the platform
 *    card's generic block, which appears only when the job carries a
 *    `publishedAt` AND an `externalId` -- and the only producer of those is
 *    Instagram's own answer. This card merely stops offering a second post.
 *
 * The hand-off (download, copy, open Instagram) is rendered by `PlatformCard`
 * beneath this and is unchanged in every state, including all of the above.
 */

export default function InstagramPublish({
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
  /** The first press only asks; this is "asked, waiting for the second". */
  const [confirming, setConfirming] = useState(false);

  /** Read the connection once: it is per-USER, not per-episode. */
  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/publish/instagram", { cache: "no-store", signal: ac.signal });
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

  /** What the OAuth callback redirected back with: read once, reported, then removed from the URL. */
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get(INSTAGRAM_CONNECT_PARAM);
    if (!isConnectResult(result)) return;
    const reason = url.searchParams.get(INSTAGRAM_CONNECT_REASON_PARAM);

    // A connection that went through but is not the expected account comes back
    // as "connected" WITH a reason: that is a warning, not a success.
    if (result === "connected") toast.show(reason ?? instagramCopy.resultConnected, reason ? "warn" : "ok");
    else if (result === "denied") toast.show(reason ?? instagramCopy.resultDenied, "warn");
    else toast.show(reason ?? instagramCopy.resultFailed, "error");

    url.searchParams.delete(INSTAGRAM_CONNECT_PARAM);
    url.searchParams.delete(INSTAGRAM_CONNECT_REASON_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // Once, on mount: the URL cannot change without a navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const config = connection?.config ?? null;
  const configured = config?.configured ?? false;
  const connected = connection?.connected ?? false;
  const identityOk = connection?.identity === "match" && !connection.identityBlocksPublish;
  const job = state.job;
  const inFlight = state.status === "PREPARING" || state.status === "UPLOADING";
  const published = Boolean(job?.publishedAt && job.externalId);
  /** The browser-window route holds this episode (stopped for a person, and it may already be up): no second post from here. */
  const heldByBrowser = state.status === "AWAITING_HUMAN";

  /**
   * Connect is an ORDINARY LINK, not a fetch and not a router push: the server
   * answers it with a 303 to facebook.com, and only a real navigation follows a
   * cross-origin redirect. A `fetch` would read Facebook's sign-in page into
   * JavaScript, which is both useless and the beginning of the one thing this
   * integration must never do.
   */
  const connectHref = "/api/publish/instagram/connect";

  async function disconnect() {
    setBusy("disconnect");
    try {
      const res = await fetch("/api/publish/instagram", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.show(typeof body.error === "string" ? body.error : instagramCopy.resultFailed, "error");
        return;
      }
      if (body.revoked === false && typeof body.revokeProblem === "string") {
        // Half-done is reported as half-done.
        toast.show(instagramCopy.revokeFailed(body.revokeProblem), "warn");
      } else {
        toast.show(instagramCopy.disconnected, "ok");
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
      const res = await fetch(`/api/episodes/${episodeId}/publish/instagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sent only from the second press. The server refuses without it.
        body: JSON.stringify({ confirmPublic: true }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.show(typeof body.error === "string" ? body.error : instagramCopy.publishFailed, "error");
        return;
      }
      onPublished(body);
      toast.show(instagramCopy.publishStarted, "ok");
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  const canAsk = busy === null && !inFlight && state.problems.length === 0;

  return (
    <div className="pub-connect">
      <div className="pub-platform-head">
        <p className="eyebrow">Instagram API</p>
        <Badge tone={connected ? "done" : configured ? "live" : "soon"}>
          {connected ? instagramCopy.grantedLabel : configured ? "Not connected" : "Not configured"}
        </Badge>
      </div>

      {/* The three states, each said plainly. Nothing is implied by an absent
          control: if a button is missing, the sentence above it says why. */}
      {!configured && (
        <>
          <p className="hint">{instagramCopy.notConfigured}</p>
          {config && config.missing.length > 0 && (
            <div className="pub-rows">
              <p className="eyebrow">{instagramCopy.missingLabel}</p>
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
          <p className="hint">{connection?.problem ?? instagramCopy.notConnected}</p>
          <div className="pub-actions">
            <a className="chip" data-state="on" href={connectHref}>
              <span className="truncate">{connection?.problem ? instagramCopy.reconnect : instagramCopy.connect}</span>
            </a>
          </div>
          <Hint>{instagramCopy.consentNote}</Hint>
        </>
      )}

      {configured && connected && connection && (
        <>
          <p className="hint">{instagramCopy.connectedTo(connection.verifiedHandle)}</p>
          {connection.connectedAt && (
            <span className="hint">{instagramCopy.since(new Date(connection.connectedAt).toLocaleString())}</span>
          )}

          {/* Which account this is, as INSTAGRAM reported it, beside the one
              this install means to post to. A wrong or unconfirmed account is a
              blocking alert. */}
          <IdentityStatus platform="Instagram" connection={connection} />

          {connection.scopes.length > 0 && (
            <ul className="pub-requires" role="list">
              {connection.scopes.map((s) => (
                <li key={s}>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          )}

          {/* The post. Offered only for an episode this account owns, only for
              the verified account, and never while one is already in flight. */}
          {!owned ? (
            <Hint>{instagramCopy.notOwned}</Hint>
          ) : published || heldByBrowser ? null : !identityOk ? (
            <Hint>{identityCopy.publishBlocked}</Hint>
          ) : !confirming ? (
            <>
              <div className="pub-actions">
                <button
                  type="button"
                  className="chip"
                  data-state="on"
                  aria-disabled={canAsk ? undefined : "true"}
                  onClick={() => canAsk && setConfirming(true)}
                >
                  <span className="truncate">{instagramCopy.publish}</span>
                </button>
              </div>
              <Hint>{instagramCopy.publishNote}</Hint>
            </>
          ) : (
            <div className="pub-problems" role="alertdialog" aria-label={instagramCopy.confirmYes}>
              <p className="text-[12px]" style={{ color: "var(--ink)" }}>
                {instagramCopy.confirmPrompt}
              </p>
              <div className="pub-actions">
                <button
                  type="button"
                  className="chip"
                  data-state="on"
                  aria-disabled={busy !== null ? "true" : undefined}
                  onClick={() => busy === null && void publish()}
                >
                  <span className="truncate">{busy === "publish" ? instagramCopy.publishing : instagramCopy.confirmYes}</span>
                </button>
                <button
                  type="button"
                  className="chip"
                  aria-disabled={busy !== null ? "true" : undefined}
                  onClick={() => busy === null && setConfirming(false)}
                >
                  <span className="truncate">{instagramCopy.confirmNo}</span>
                </button>
              </div>
            </div>
          )}

          <div className="pub-actions">
            <button
              type="button"
              className="chip"
              aria-disabled={busy !== null ? "true" : undefined}
              onClick={() => busy === null && void disconnect()}
            >
              <span className="truncate">{busy === "disconnect" ? instagramCopy.disconnecting : instagramCopy.disconnect}</span>
            </button>
          </div>
          <Hint>{instagramCopy.disconnectNote}</Hint>
        </>
      )}

      {/* While it works: which stage, in words. No byte count exists on this
          API, so there is deliberately no bar. */}
      {inFlight && (
        <p className="hint" role="status">
          {state.status === "PREPARING" ? instagramCopy.preparing : instagramCopy.processing}
        </p>
      )}
    </div>
  );
}
