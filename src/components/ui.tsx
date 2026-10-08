"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The small shared pieces every pane is built from. They exist so a panel
 * looks the same wherever it appears and so the empty / loading / error state
 * of each one is written once rather than improvised per panel.
 */

/**
 * Everything using `usePersistentFlag` right now, so a write in this tab tells
 * the other readers. `localStorage` only fires `storage` in OTHER tabs.
 */
const flagListeners = new Set<() => void>();

/** Where the choice goes when `localStorage` is unavailable (private mode). */
const flagMemory = new Map<string, string>();

/**
 * Read one remembered flag. Exported so `tests/shell-layout.test.mts` can hold
 * the storage-disabled path to its promise without a browser: in node there is
 * no `window` at all, which is the same code path as a browser that throws on
 * `localStorage`.
 */
export function readFlag(key: string): string | null {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // Storage disabled, or no window. The in-memory copy below is the fallback.
  }
  return stored ?? flagMemory.get(key) ?? null;
}

/** Write one, and tell every reader in this tab. See `readFlag` for the export. */
export function writeFlag(key: string, next: boolean) {
  const v = next ? "1" : "0";
  flagMemory.set(key, v);
  try {
    window.localStorage.setItem(key, v);
  } catch {
    // Not being able to REMEMBER the choice must not stop making it.
  }
  for (const listener of flagListeners) listener();
}

/**
 * A boolean the browser remembers for this device — which rail is collapsed,
 * and nothing else.
 *
 * `localStorage` rather than a setting: this is where one person likes their
 * panes, not a property of the project. Putting it in `PUT /api/settings`
 * would sync a laptop's layout onto a phone, which is the opposite of what a
 * responsive shell wants, and would spend a request on every click.
 *
 * `useSyncExternalStore` rather than state-plus-an-effect, because
 * `localStorage` IS an external store: the server snapshot is `null`, so the
 * markup React sends and the markup it hydrates agree, and the remembered
 * value arrives on the first client read rather than through a setState in an
 * effect body (which React's own lint calls a cascading render, correctly).
 */
export function usePersistentFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    flagListeners.add(onChange);
    window.addEventListener("storage", onChange);
    return () => {
      flagListeners.delete(onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const raw = useSyncExternalStore(
    subscribe,
    () => readFlag(key),
    () => null,
  );
  const value = raw === "0" || raw === "1" ? raw === "1" : initial;

  const set = useCallback((next: boolean) => writeFlag(key, next), [key]);

  return [value, set];
}

/**
 * Whether a media query matches, tracked live.
 *
 * Used for the one thing CSS cannot do here: changing the ORDER of two
 * columns on a phone. `order` would do it visually and leave the tab key
 * reading the other way round, which is a worse bug than the one it fixes, so
 * the swap happens in the markup instead. `false` on the server, as above.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The chevron a rail toggle carries, pointing the way the rail will move. */
function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

/**
 * The control that collapses or expands a rail.
 *
 * A real `<button>` carrying `aria-expanded`, so it is in the tab order, works
 * on Enter and Space, and is announced with its state — the same contract
 * `<summary>` gives the disclosures, which is why neither is a div.
 *
 * The `label` is fixed and must stay fixed: `aria-expanded` already carries
 * the state, and a name that also announces it says the same thing twice, in
 * opposite voices. Only the chevron changes.
 *
 * It must also be rendered from ONE position in the tree in both states. A
 * rail that early-returns a different subtree when collapsed unmounts this
 * button and mounts a new one, which drops keyboard focus to `<body>` on every
 * click and means a screen reader never hears `aria-expanded` change — it is a
 * different element, not the same one in a new state. Both rails keep it as
 * the first child of a wrapper that exists either way.
 *
 * `data-rail-toggle` is how the layout harness finds it; nothing in the app
 * reads it.
 */
export function RailToggle({
  rail,
  expanded,
  label,
  onToggle,
}: {
  rail: "side" | "insp";
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  // Pointing outward means "give the middle its space back", pointing inward
  // means "put this rail back" — from whichever edge the rail is on.
  const dir: "left" | "right" = rail === "side" ? (expanded ? "left" : "right") : expanded ? "right" : "left";
  return (
    <button
      type="button"
      className="rail-toggle"
      data-rail-toggle={rail}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <Chevron dir={dir} />
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
  bodyClassName = "panel-body",
  ...rest
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section className={`panel ${className}`} {...rest}>
      {title && (
        <header className="panel-head">
          <h3 className="font-display text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
            {title}
          </h3>
          {actions}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type BadgeTone = "soon" | "live" | "done" | "failed" | "cancelled" | "plain";

export function Badge({ tone = "plain", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={`badge${tone === "plain" ? "" : ` badge-${tone}`}`}>{children}</span>;
}

/** A run status rendered as a badge, with the tone matching its meaning. */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone: BadgeTone =
    status === "DONE"
      ? "done"
      : status === "FAILED"
        ? "failed"
        : status === "CANCELLED"
          ? "cancelled"
          : status === "RUNNING"
            ? "live"
            : "plain";
  return <Badge tone={tone}>{label}</Badge>;
}

export function Hint({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p className="hint" id={id}>
      {children}
    </p>
  );
}

/**
 * A real `<details>`/`<summary>`, and deliberately nothing cleverer.
 *
 * Everything the operator asked to stop seeing at once — the theme
 * descriptions, the voice and music panels, the long hints, the publish copy
 * — is folded into one of these. A div that toggles a class would look the
 * same and be unusable: `<summary>` is focusable, opens on Enter and Space,
 * and is announced with its expanded state without a single aria attribute.
 * That is the whole reason this component is three lines of markup.
 *
 * `defaultOpen` maps to the `open` attribute, which the browser then owns —
 * there is no controlled mode on purpose, because a disclosure whose state
 * React re-asserts fights the reader every time a poll re-renders the pane.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  quiet = false,
  className = "",
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** A footnote you can open, rather than another boxed panel. */
  quiet?: boolean;
  className?: string;
}) {
  return (
    <details className={`disclosure${quiet ? " disclosure-quiet" : ""} ${className}`} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed" style={{ color: "var(--mute)" }}>
      {children}
    </p>
  );
}

/** A read-only fact. Used wherever a value exists but cannot be changed yet. */
export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
        {label}
      </span>
      <span className="text-right text-[13px]" style={{ color: "var(--ink)" }}>
        {value}
      </span>
    </div>
  );
}

export function Skeleton({ height, className = "" }: { height: number | string; className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} style={{ height }} />;
}
