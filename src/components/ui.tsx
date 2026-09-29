"use client";

/**
 * The small shared pieces every pane is built from. They exist so a panel
 * looks the same wherever it appears and so the empty / loading / error state
 * of each one is written once rather than improvised per panel.
 */

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
