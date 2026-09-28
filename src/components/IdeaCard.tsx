"use client";

import { strings } from "@/lib/strings";
import type { IdeaView } from "./types";
import { Badge, Disclosure, StatusBadge } from "./ui";

function pageList(pages: IdeaView["sourcePages"]): string {
  return pages.map((p) => strings.books.pageRef(p.number, p.label)).join(", ");
}

/**
 * One idea. What is always on screen is what an operator decides on: the
 * title, the opening line, the idea itself and where in the book it is. Why
 * it would work, and the exact words it rests on, are one click away — they
 * matter for trust, not for scanning a list of twenty.
 */
export default function IdeaCard({
  idea,
  onToggle,
  busy,
}: {
  idea: IdeaView;
  onToggle: (selected: boolean) => void;
  busy: boolean;
}) {
  const preview = idea.sourcePages.find((p) => p.pageId);

  return (
    <article
      className="panel flex flex-col gap-2 p-3"
      style={{ borderColor: idea.selected ? "var(--cyan)" : undefined }}
      aria-labelledby={`idea-${idea.id}`}
    >
      <header className="flex items-start gap-2.5">
        <span className="mt-0.5 font-mono text-[12px] tabular-nums" style={{ color: "var(--mute-2)" }}>
          {String(idea.rank).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`idea-${idea.id}`} className="font-display text-[15px] font-semibold leading-snug" style={{ color: "var(--ink)" }}>
            {idea.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>{strings.books.angle[idea.angle] ?? strings.books.angle.other}</Badge>
            {idea.episode && (
              <StatusBadge status={idea.episode.status} label={strings.books.videoStatus(idea.episode.status)} />
            )}
            {idea.sectionTitle && (
              <span className="truncate text-[11.5px]" style={{ color: "var(--mute)" }} title={idea.sectionTitle}>
                {idea.sectionTitle}
              </span>
            )}
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px]" style={{ color: "var(--ink)" }}>
          <input
            type="checkbox"
            checked={idea.selected}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={strings.books.selectLabel(idea.title)}
            className="h-4 w-4"
            style={{ accentColor: "var(--cyan)" }}
          />
          {strings.books.select}
        </label>
      </header>

      {idea.hook && (
        <p className="border-l-2 pl-2.5 text-[13px] italic leading-snug" style={{ borderColor: "var(--amber)", color: "var(--ink)" }}>
          <span className="sr-only">{strings.books.hookLabel}: </span>“{idea.hook}”
        </p>
      )}

      <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>
        {idea.coreIdea}
      </p>

      <p className="font-mono text-[11px]" style={{ color: "var(--mute-2)" }}>
        {pageList(idea.sourcePages)}
      </p>

      <Disclosure quiet summary={strings.books.whyLabel}>
        <dl className="grid gap-1.5 text-[12.5px] leading-snug">
          {(
            [
              ["whyItMatters", idea.whyItMatters],
              ["hookPotential", idea.hookPotential],
              ["storyPotential", idea.storyPotential],
              ["practicalValue", idea.practicalValue],
              ["visualPotential", idea.visualPotential],
            ] as const
          )
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
                  {strings.books[k]}
                </dt>
                <dd style={{ color: "var(--ink)" }}>{v}</dd>
              </div>
            ))}
        </dl>
      </Disclosure>

      <Disclosure quiet summary={strings.books.sourceSummary(pageList(idea.sourcePages))}>
        <div className="flex gap-3">
          {preview?.pageId && (
            // eslint-disable-next-line @next/next/no-img-element -- private, session-gated page image
            <img
              src={`/api/pages/${preview.pageId}/image`}
              alt={strings.books.pagePreviewAlt(preview.number)}
              loading="lazy"
              className="h-auto w-[92px] shrink-0 self-start rounded border"
              style={{ borderColor: "var(--line)" }}
            />
          )}
          <div className="flex min-w-0 flex-col gap-2">
            {idea.sourceText.split("\n\n").map((q, i) => (
              <blockquote key={i} className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink)" }}>
                {q}
              </blockquote>
            ))}
            {idea.relatedPages.length > 0 && (
              <p className="text-[11.5px]" style={{ color: "var(--mute)" }}>
                {strings.books.related(idea.relatedPages.map((n) => `p. ${n}`).join(", "))}
              </p>
            )}
          </div>
        </div>
      </Disclosure>
    </article>
  );
}
