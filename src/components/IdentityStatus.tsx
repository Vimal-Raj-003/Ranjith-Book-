"use client";

import { StatRow } from "./ui";
import { identityCopy, type ConnectionView } from "@/lib/publish/connect";

/**
 * Which account is this connection, according to the platform's own API, next to
 * the account this install means to publish to.
 *
 * It renders the VERDICT the server computed and nothing else. The handle shown
 * as "verified" is `ConnectionView.verifiedHandle`, which the server only ever
 * fills from an API answer; this component has no input an operator could type a
 * handle into, and no label it reads a handle from. A blocked state is a
 * `role="alert"` block in the same visual language as the platform card's other
 * refusals, so a wrong account cannot be missed.
 *
 * A connection that merely predates verification (YouTube only) is shown as a
 * plain warning rather than a block: it can still upload, and says how to verify.
 */
export default function IdentityStatus({
  platform,
  connection,
}: {
  /** "YouTube" or "Instagram", for the sentence. */
  platform: string;
  connection: ConnectionView;
}) {
  const { identity, verifiedHandle, expectedHandle, identityNote, identityBlocksPublish } = connection;

  return (
    <div className="pub-rows" data-identity={identity}>
      <p className="eyebrow">{identityCopy.heading}</p>
      <StatRow label={identityCopy.verifiedLabel} value={verifiedHandle ?? identityCopy.notVerified} />
      <StatRow label={identityCopy.expectedLabel} value={expectedHandle} />
      {verifiedHandle && <span className="hint">{identityCopy.verifiedBy(platform)}</span>}

      {identity === "match" && verifiedHandle && <p className="hint">{identityCopy.match(platform, verifiedHandle)}</p>}

      {identityNote &&
        (identityBlocksPublish ? (
          <div className="pub-problems" role="alert">
            <p className="eyebrow">{identityCopy.blockedHeading}</p>
            <p className="text-[12px]" style={{ color: "var(--ink)" }}>
              {identityNote}
            </p>
          </div>
        ) : (
          <p className="hint" role="status">
            {identityNote}
          </p>
        ))}
    </div>
  );
}
