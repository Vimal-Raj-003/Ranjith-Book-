import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TRACK, canonicalInt, displayed, stepTrack, type Track, type WriteEvent } from "../src/lib/setting-writes";
import { validateSetting } from "../src/lib/settings/keys";

/**
 * `Inspector`'s `save(key, value)` is an optimistic write with rollback, and
 * the rollback is the part that can lie: it has to put back a value the SERVER
 * holds, not one the operator merely passed through. These drive the state
 * machine it is built on (`setting-writes.ts`) by hand, and then against a
 * simulated server, because the cases that went wrong were all overlaps --
 * two writes in flight at once -- and the component cannot be driven that way
 * from a unit test.
 */

/** Feed events in order; return every step so a test can read the sends and the rollbacks. */
function run(start: Track, events: WriteEvent[]) {
  let track = start;
  const steps = events.map((event) => {
    const step = stepTrack(track, event);
    track = step.track;
    return step;
  });
  return { track, steps, sends: steps.map((s) => s.send), rollbacks: steps.filter((s) => s.rolledBack).length };
}

const want = (value: string): WriteEvent => ({ type: "want", value });
const read = (value: string): WriteEvent => ({ type: "read", value });
const SAVED: WriteEvent = { type: "saved" };
const FAILED: WriteEvent = { type: "failed" };

/** A track whose server-confirmed value is `value`. */
const confirmed = (value: string): Track => stepTrack(EMPTY_TRACK, read(value)).track;

test("a write is sent at once, displayed at once, and confirmed when it lands", () => {
  const { track, sends, rollbacks } = run(confirmed("charles"), [want("vera"), SAVED]);
  assert.deepEqual(sends, ["vera", undefined]);
  assert.equal(displayed(track), "vera");
  assert.equal(track.confirmed, "vera");
  assert.equal(rollbacks, 0);
});

test("a write that is refused goes back to what the server holds, and says so", () => {
  const { track, rollbacks, steps } = run(confirmed("charles"), [want("vera"), FAILED]);
  assert.equal(displayed(track), "charles");
  assert.equal(rollbacks, 1);
  assert.equal(steps[1].rolledBack, true);
});

test("choosing what is already displayed sends nothing", () => {
  const { sends } = run(confirmed("charles"), [want("charles")]);
  assert.deepEqual(sends, [undefined]);
  // ...including a choice already on its way.
  assert.deepEqual(run(confirmed("charles"), [want("vera"), want("vera")]).sends, ["vera", undefined]);
});

test("a second choice waits for the first to land: writes cannot arrive out of order", () => {
  const { sends, track } = run(confirmed("charles"), [want("vera"), want("george")]);
  assert.deepEqual(sends, ["vera", undefined], "george is not sent while vera is in flight");
  assert.equal(displayed(track), "george", "but the control already shows it");
});

test("REVIEWED CASE: both overlapping writes refused -- back to charles, never to vera", () => {
  // The server holds charles. vera is sent; before it returns the operator picks
  // george. A per-call "previous" would restore vera -- a value the server never
  // held -- after the second failure, and a reload would silently change the answer.
  const { track, sends, steps } = run(confirmed("charles"), [want("vera"), want("george"), FAILED, FAILED]);
  assert.deepEqual(sends, ["vera", undefined, "george", undefined]);
  assert.equal(steps[2].rolledBack, undefined, "vera failing is not reported: george is the live choice and still to be tried");
  assert.equal(steps[3].rolledBack, true);
  assert.equal(displayed(track), "charles");
  assert.equal(track.confirmed, "charles");
});

test("REVIEWED CASE: the first refused, the second accepted -- no failure is reported", () => {
  const { track, rollbacks } = run(confirmed("charles"), [want("vera"), want("george"), FAILED, SAVED]);
  assert.equal(rollbacks, 0, "a spurious 'could not save' for a write that was superseded and then worked");
  assert.equal(displayed(track), "george");
  assert.equal(track.confirmed, "george");
});

test("the first accepted, the second refused -- back to the first, which the server really holds", () => {
  const { track, rollbacks } = run(confirmed("charles"), [want("vera"), want("george"), SAVED, FAILED]);
  assert.equal(rollbacks, 1);
  assert.equal(displayed(track), "vera");
  assert.equal(track.confirmed, "vera");
});

test("changing your mind back to the server's value while a write is in flight restores it", () => {
  // vera is on its way; the operator picks charles again. When vera lands the
  // server holds vera and the control shows charles, so charles must be sent.
  const landed = run(confirmed("charles"), [want("vera"), want("charles"), SAVED]);
  assert.deepEqual(landed.sends, ["vera", undefined, "charles"]);
  assert.equal(displayed(landed.track), "charles");
  assert.equal(landed.track.confirmed, "vera", "not confirmed until charles itself lands");
  // If vera is refused instead, the server still holds charles: nothing to send, nothing to report.
  const refused = run(confirmed("charles"), [want("vera"), want("charles"), FAILED]);
  assert.deepEqual(refused.sends, ["vera", undefined, undefined]);
  assert.equal(refused.rollbacks, 0);
  assert.equal(displayed(refused.track), "charles");
  assert.equal(refused.track.wanted, undefined, "settled");
});

test("a burst that fits inside one round trip sends the first and the last, nothing between", () => {
  // Everything chosen while a write is in flight collapses to the newest, so a
  // burst that is over before the server answers costs two writes, not one per change.
  const events: WriteEvent[] = ["-30", "-29", "-28", "-27", "-26", "-25"].map(want);
  const { sends, track } = run(confirmed("-22"), [...events, SAVED, SAVED]);
  assert.deepEqual(sends.filter((s) => s !== undefined), ["-30", "-25"]);
  assert.equal(displayed(track), "-25");
  assert.equal(track.confirmed, "-25");
});

test("a burst that outlasts several round trips sends about one write per round trip", () => {
  // The claim above does NOT stretch to a long drag: each answer lets the next
  // write out. 30 changes with an answer after every ten is four writes (the
  // first, then the newest at each answer), in order and all safe, but not "one
  // per gesture". That is what the music level slider commits on release for: it
  // only calls want() once the drag is over.
  const events: WriteEvent[] = [];
  for (let i = 1; i <= 30; i++) {
    events.push(want(String(-40 + i)));
    if (i % 10 === 0) events.push(SAVED);
  }
  events.push(SAVED);
  const { sends, track } = run(confirmed("-22"), events);
  assert.deepEqual(sends.filter((s) => s !== undefined), ["-39", "-30", "-20", "-10"]);
  assert.equal(displayed(track), "-10");
  assert.equal(track.confirmed, "-10");
});

test("what the settings read says does not override an edit, and a refusal falls back to it", () => {
  // The GET resolves after the operator has already chosen: the edit is newer.
  const early = run(EMPTY_TRACK, [want("vera"), read("charles")]);
  assert.equal(displayed(early.track), "vera");
  assert.equal(early.track.confirmed, "charles");
  // ...and when that edit is refused, charles -- what the read said -- is what comes back.
  assert.equal(displayed(run(early.track, [FAILED]).track), "charles");
  // A read never overwrites a value a write has since confirmed.
  assert.equal(run(EMPTY_TRACK, [want("vera"), SAVED, read("charles")]).track.confirmed, "vera");
});

test("a refused write with nothing ever read goes back to showing nothing", () => {
  // The picker shows 'Choose a narrator' for a key it has no value for.
  const { track } = run(EMPTY_TRACK, [want("vera"), FAILED]);
  assert.equal(displayed(track), undefined);
});

test("a stray answer with no write in flight changes nothing", () => {
  const start = confirmed("charles");
  assert.equal(run(start, [SAVED]).track, start);
  assert.equal(run(start, [FAILED]).track, start);
});

// ------------------------------------------------- against a simulated server

/** A small seeded generator, so a failure here is reproducible from the seed. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test("under any interleaving of choices, answers and refusals the control ends on what the server holds", () => {
  const VALUES = ["a", "b", "c", "d"];
  for (let seed = 1; seed <= 400; seed++) {
    const rand = lcg(seed);
    let track = confirmed("a");
    let server = "a";
    const everHeld = new Set(["a"]);
    let inFlight: string | undefined; // the value of the one PUT the shell has outstanding

    const apply = (event: WriteEvent) => {
      const step = stepTrack(track, event);
      track = step.track;
      if (step.rolledBack) {
        // Whatever it puts back must be something the server has actually held.
        assert.ok(everHeld.has(displayed(track)!), `seed ${seed}: rolled back to ${displayed(track)}, which the server never held`);
      }
      if (step.send !== undefined) {
        assert.equal(inFlight, undefined, `seed ${seed}: a second write was sent while one was in flight`);
        inFlight = step.send;
      }
    };
    const answer = (ok: boolean) => {
      const sent = inFlight!;
      inFlight = undefined;
      if (ok) {
        server = sent;
        everHeld.add(sent);
      }
      apply(ok ? SAVED : FAILED);
    };

    for (let i = 0; i < 25; i++) {
      if (inFlight !== undefined && rand() < 0.5) answer(rand() < 0.6);
      else apply(want(VALUES[Math.floor(rand() * VALUES.length)]));
    }
    // Let everything outstanding land, with refusals still possible, until the shell is idle.
    while (inFlight !== undefined) answer(rand() < 0.6);

    assert.equal(displayed(track), server, `seed ${seed}: the control shows ${displayed(track)} but the server holds ${server}`);
    assert.equal(track.confirmed, server, `seed ${seed}: the confirmed value drifted from the server's`);
    assert.equal(track.wanted, undefined, `seed ${seed}: settled`);
  }
});

// ------------------------------------------------------- integer settings are sent canonical

test("canonicalInt is the server's own spelling of an integer setting", () => {
  // The tracker confirms what it SENT, so what a slider sends has to be what the
  // server echoes back. Over the whole level range, and the intensity tiers:
  for (let n = -40; n <= -13; n++) {
    assert.equal(canonicalInt(n), validateSetting("musicLevel", n), `level ${n}`);
    assert.equal(canonicalInt(String(n)), String(n), `level "${n}"`);
  }
  for (const n of [0, 1, 2]) assert.equal(canonicalInt(n), validateSetting("musicIntensity", n), `intensity ${n}`);
  // Odd spellings of an integer: wherever the server accepts one, it stores exactly
  // what canonicalInt says. ("+1" and "1e1" are in range for neither level nor
  // intensity-10, so they are compared where they are valid.)
  for (const raw of ["-22", "-22.0", "-22.00", "-0", "0", "1", "+1", " 1 ", "2.0", "-1e1", "-3e1"]) {
    const sent = canonicalInt(raw);
    assert.notEqual(sent, null, raw);
    for (const key of ["musicLevel", "musicIntensity"] as const) {
      const stored = validateSetting(key, raw);
      if (stored !== null) assert.equal(stored, sent, `"${raw}" for ${key}: the server stores ${stored}`);
    }
    // A fixed point: spelling it again changes nothing.
    assert.equal(canonicalInt(sent!), sent, raw);
  }
});

test("canonicalInt refuses what the server refuses as not an integer", () => {
  for (const raw of ["", "  ", "-22.5", "loud", "NaN", "Infinity", "1/2", Number.NaN, 0.5, Infinity]) {
    assert.equal(canonicalInt(raw as string | number), null, String(raw));
  }
});

test("a slider that sends the canonical spelling never shows a phantom unsaved value", () => {
  // The control shows -22, which the server holds. A drag that lands back on it
  // spelled "-22.0" is the SAME setting. Sent as typed it is a write that changes
  // nothing and leaves the tracker confirmed on a string the server does not
  // hold; canonicalised it is recognised as already displayed and nothing is sent.
  const typed = run(confirmed("-22"), [want("-22.0"), SAVED]);
  assert.deepEqual(typed.sends, ["-22.0", undefined], "as typed: a pointless write");
  assert.notEqual(typed.track.confirmed, validateSetting("musicLevel", "-22.0"), "and the tracker now disagrees with the server's echo");
  const canonical = run(confirmed("-22"), [want(canonicalInt("-22.0")!)]);
  assert.deepEqual(canonical.sends, [undefined]);
  assert.equal(displayed(canonical.track), "-22");
});
