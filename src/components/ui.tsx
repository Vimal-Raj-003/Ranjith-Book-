"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

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

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One accessible modal, reused wherever a pane has to open over a scrolling
 * list rather than inline — today the Publish panel launched from an episode
 * card, in both the Studio and the Book-PDF views.
 *
 * It is MOUNTED when open and unmounted when closed: the caller renders
 * `{open && <Dialog …>}`, so this component's own mount is the open event and
 * its unmount is the close. That is why there is no `open` prop — a dialog that
 * stayed mounted-but-hidden would keep its focus trap and its body-scroll lock
 * running while invisible.
 *
 * The contract it keeps, so a reader is never stranded:
 *  - `role="dialog"` + `aria-modal="true"`, labelled by its own heading.
 *  - Focus moves INTO it on open (the panel, or the first focusable), and Tab
 *    is trapped so it cannot wander behind the overlay.
 *  - Escape closes it, and closing RESTORES focus to whatever opened it — the
 *    Publish button — so a keyboard user is put back where they were.
 *  - The background does not scroll underneath it.
 *  - A click on the backdrop (not the panel) closes it.
 *
 * Rendered through a portal to `document.body` so no ancestor's `transform`
 * (which would make a `position: fixed` overlay scroll with the card) can trap
 * it — the containing-block hazard this codebase has hit before.
 */
export function Dialog({
  title,
  onClose,
  children,
  closeLabel = "Close",
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  closeLabel?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Stored at mount so Escape / backdrop / close-button all return focus to the
  // control that opened the dialog.
  const openerRef = useRef<Element | null>(null);
  // `onClose` is a fresh closure on every parent render, and the parent
  // (EpisodeCard) re-renders whenever a SIBLING episode's poll reports state.
  // If the focus/trap effect depended on `onClose` it would re-run on each of
  // those renders and yank focus back to the panel mid-keystroke. The ref lets
  // the effect run exactly once on mount while always calling the latest close.
  const onCloseRef = useRef(onClose);
  // Kept current in an effect, not during render (a ref write during render is
  // both disallowed and unnecessary here).
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    // Focus the first focusable control, else the panel itself (which carries
    // tabIndex -1 for exactly this).
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstItem || active === panel)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the opener, if it is still in the document.
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
    // Mount-only: see `onCloseRef`. Re-running this on every parent render is
    // the focus-steal bug it exists to prevent. It references only refs and
    // module constants, so there is nothing to add to the dependency list.
  }, []);

  // No `document` during a server render; the dialog is only ever mounted by a
  // client interaction, so this guard simply makes SSR a no-op.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // The dialog is portaled; React still bubbles its events through the
      // component tree. Stop click here so a host that opened the dialog from
      // inside a clickable region (an episode card) does not also receive it.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dialog-head">
          <h2 id={titleId} className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
            {title}
          </h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={closeLabel}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
