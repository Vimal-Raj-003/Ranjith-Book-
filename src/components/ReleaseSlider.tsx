"use client";

import { useRef, useState } from "react";
import { canonicalInt } from "@/lib/setting-writes";

/**
 * An integer range input that reports ONE value per gesture, when the operator
 * lets go.
 *
 * A drag is dozens of changes a second, and every one of them used to be handed to
 * `save()`. `setting-writes.ts` keeps those safe -- at most one write is in flight
 * and they land in order -- but it can only collapse a burst per round trip, so a
 * drag that outlasts a few of them still sends a write for each. Here the drag is
 * kept in local state and shown as it moves, and `onCommit` is called once, with
 * what the thumb was left on. That is what the settings file holds, so it is also
 * the only value worth a request.
 *
 * What is committed is `canonicalInt(raw)`, never the input's own string. The
 * write tracker confirms the value it SENT, not the body the server echoes, so a
 * spelling the server would normalise ("-22.0") would leave the control showing a
 * value the server does not hold. See `canonicalInt`.
 *
 * "Letting go" is three events, because a range input is moved three ways: the
 * pointer going up (mouse, touch and pen all end in one), the key coming up after
 * an arrow or Home/End/Page key (a held key repeats `input` events and is ONE
 * gesture), and losing focus, which catches a release that landed elsewhere. All
 * three go through one function that does nothing unless something changed.
 *
 * It is disabled until there is a value to show, rather than sitting on the
 * middle of its track and implying one: before the settings have been read the
 * honest position is none.
 */
export default function ReleaseSlider({
  id,
  min,
  max,
  step,
  value,
  format,
  onCommit,
}: {
  id: string;
  min: number;
  max: number;
  step: number;
  /** What the server is known to hold (or the operator has chosen and is waiting on), as a canonical integer string. */
  value: string | undefined;
  /** The reading, e.g. "−22 dB". Given to assistive technology as the value text and shown beneath. */
  format: (n: number) => string;
  /** Called once per gesture, with a canonical integer string. */
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // A ref, not the `draft` state: a handler must see "something changed since the
  // last release" even if it runs before the render that follows the last change.
  const moved = useRef(false);
  const shown = draft ?? value;

  function release(e: { currentTarget: HTMLInputElement }) {
    if (!moved.current) return;
    moved.current = false;
    setDraft(null);
    const sent = canonicalInt(e.currentTarget.value);
    if (sent !== null) onCommit(sent);
  }

  return (
    <>
      <input
        id={id}
        type="range"
        className="w-full"
        style={{ accentColor: "var(--amber)" }}
        min={min}
        max={max}
        step={step}
        value={shown ?? ""}
        disabled={shown === undefined}
        aria-valuetext={shown === undefined ? undefined : format(Number(shown))}
        onChange={(e) => {
          moved.current = true;
          setDraft(e.target.value);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyUp={release}
        onBlur={release}
      />
      {/* aria-hidden: the slider already says this as its value text, and an
          always-announced readout would speak on every step of a drag. */}
      <p className="hint mt-1" aria-hidden="true">
        {shown === undefined ? " " : format(Number(shown))}
      </p>
    </>
  );
}
