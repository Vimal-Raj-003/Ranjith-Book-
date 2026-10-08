/**
 * The state behind an optimistic setting write: what the control shows, what the
 * server is known to hold, and which write is on its way.
 *
 * This module has NO imports and must keep it that way: `Inspector.tsx` is a
 * `"use client"` component and imports it, so anything it pulled in would land in
 * the browser bundle. (`settings/keys.ts` is server-only for that reason.)
 *
 * It is a pure step function, with the fetch left to the caller, because the bug
 * it replaces could not be tested where it lived. `save()` used to remember a
 * per-call "previous value" and put it back on failure. Two writes in flight made
 * those snapshots disagree: with the server on `charles`, choosing `vera` and then
 * `george` before either returned meant a double failure restored `vera` -- a
 * value the server never held -- and a reload changed the answer. Worse, the two
 * requests had no guaranteed arrival order, so the server could end on `vera`
 * while the control showed `george`.
 *
 * So there are two rules, and everything below follows from them:
 *
 *  1. Roll back to `confirmed`, the last value the server is KNOWN to hold (read
 *     from `GET /api/settings`, or accepted by a `PUT`). Never to a snapshot.
 *  2. At most one write per key is ever outstanding. A choice made meanwhile only
 *     updates `wanted`; when the outstanding write answers, the newest `wanted`
 *     is sent. Writes therefore reach the server in the order they were made, and
 *     a burst costs one request per ROUND TRIP rather than one per change: the
 *     first goes out at once, everything chosen while it is in flight collapses
 *     to the newest, and that goes out when the first answers. A burst shorter
 *     than a round trip is the first and the last. A slider drag that outlasts
 *     several round trips is therefore still several writes, which is safe but
 *     is not "one per gesture" -- a control that wants one commits on release
 *     (the music level slider does), and only then calls `want`.
 *
 * Nothing here disables a control while a write is in flight. That is
 * deliberate: a disabled `<select>` drops keyboard focus, and the arrow keys
 * that step through its options would stop after the first.
 */

export interface Track {
  /** The last value the server is known to hold; `undefined` until one is read or accepted. */
  confirmed: string | undefined;
  /** What the operator most recently chose, while it has not been settled either way. */
  wanted: string | undefined;
  /** The value of the write that is on its way. At most one. */
  sending: string | undefined;
}

export const EMPTY_TRACK: Track = { confirmed: undefined, wanted: undefined, sending: undefined };

export type WriteEvent =
  /** `GET /api/settings` answered with this value. */
  | { type: "read"; value: string }
  /** The operator chose this value. */
  | { type: "want"; value: string }
  /** The outstanding write was accepted. */
  | { type: "saved" }
  /** The outstanding write was refused, or never arrived. */
  | { type: "failed" };

export interface Step {
  track: Track;
  /** Send this value now. Set only when no write was outstanding. */
  send?: string;
  /** The operator's latest choice was refused and the control has gone back; tell them. */
  rolledBack?: true;
}

/** What the control should show: the operator's pending choice, else what the server holds. */
export function displayed(track: Track): string | undefined {
  return track.wanted ?? track.confirmed;
}

function send(track: Track, value: string): Step {
  return { track: { ...track, wanted: value, sending: value }, send: value };
}

export function stepTrack(track: Track, event: WriteEvent): Step {
  switch (event.type) {
    case "read":
      // A read never overrides a value a write has since confirmed, and never
      // touches what the operator has chosen in the meantime: it is older than both.
      return track.confirmed === undefined ? { track: { ...track, confirmed: event.value } } : { track };

    case "want": {
      if (event.value === displayed(track)) return { track };
      if (track.sending === undefined) return send(track, event.value);
      return { track: { ...track, wanted: event.value } };
    }

    case "saved": {
      if (track.sending === undefined) return { track };
      const landed: Track = { ...track, confirmed: track.sending, sending: undefined };
      if (landed.wanted === undefined || landed.wanted === landed.confirmed) {
        return { track: { ...landed, wanted: undefined } };
      }
      // The operator chose something else while this was in flight.
      return send(landed, landed.wanted);
    }

    case "failed": {
      if (track.sending === undefined) return { track };
      const idle: Track = { ...track, sending: undefined };
      // The refused write was the live choice: put back what the server holds.
      if (idle.wanted === track.sending) return { track: { ...idle, wanted: undefined }, rolledBack: true };
      // Superseded, and the operator has since come back to what the server holds:
      // nothing to send and nothing to report.
      if (idle.wanted === undefined || idle.wanted === idle.confirmed) return { track: { ...idle, wanted: undefined } };
      // Superseded by a different choice, which has not been tried yet.
      return send(idle, idle.wanted);
    }
  }
}

/**
 * An integer setting's value, spelled the one way the server spells it back.
 *
 * `stepTrack` confirms the value it SENT, not the body `PUT` echoes, so a value
 * spelled differently from the server's normal form leaves the control confirmed
 * on a string the server does not hold. `intIn` in `settings/keys.ts` accepts
 * "-22.0" and "+1" and stores "-22" and "1"; a slider that sent them as typed
 * would show a phantom difference after the save (and again after a reload), and
 * `want("-22")` against a control confirmed on "-22.0" would send a write that
 * changes nothing. So integer controls send `canonicalInt(raw)`, which is `intIn`'s
 * own normalisation, `String(Number(x))`, and a fixed point of it.
 * `tests/setting-writes.test.mts` holds the two together over the whole level range.
 *
 * Null for what `intIn` would refuse as not an integer: blank, fractional, not a
 * number. Bounds are not checked here -- the control has its own min and max and
 * the server is the authority on both.
 */
export function canonicalInt(raw: string | number): string | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) ? String(n) : null;
}
