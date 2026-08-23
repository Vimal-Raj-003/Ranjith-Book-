"use client";

import { useCallback, useEffect, useState } from "react";
import { strings } from "@/lib/strings";
import { Badge, StatusBadge } from "./ui";
import type { EpisodeSummary } from "./types";

function initials(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "BR";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

/** The 9:16 poster, or a quiet tinted field with the book's initials. */
function Poster({ episode }: { episode: EpisodeSummary }) {
  const poster = (episode.thumbnails ?? []).find((t) => t.aspect === "9:16") ?? episode.thumbnails?.[0];
  const [broken, setBroken] = useState(false);

  if (!poster || broken) {
    return (
      <div className="poster">
        <div className="poster-empty" aria-hidden>
          {initials(episode.bookTitle)}
        </div>
      </div>
    );
  }

  return (
    <div className="poster">
      {/* eslint-disable-next-line @next/next/no-img-element -- session-guarded API route, not a statically optimizable asset */}
      <img
        src={`/api/episodes/${episode.id}/thumbnail/${poster.key}`}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </div>
  );
}

/**
 * Every episode the operator has made, as a card grid rather than the plain
 * text list this replaced. The grid keeps its shape while loading — the
 * skeleton cards are the same size as the real ones — so nothing jumps when
 * the fetch resolves.
 */
export default function LibraryGrid({
  activeId,
  onOpen,
}: {
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await fetch("/api/episodes", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || strings.studio.loadError);
        if (!cancelled) setEpisodes((data.episodes ?? []) as EpisodeSummary[]);
      } catch (err) {
        if (cancelled) return;
        setEpisodes([]);
        setError((err as Error).message || strings.studio.loadError);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="library-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="library-heading" className="font-display text-[20px] font-semibold" style={{ color: "var(--ink)" }}>
            {strings.library.heading}
          </h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--mute)" }}>
            {strings.library.intro}
          </p>
        </div>
        <span aria-live="polite" className="badge">
          {episodes === null ? strings.studio.loading : strings.library.countLabel(episodes.length)}
        </span>
      </div>

      {error && (
        <div className="panel panel-body flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
            {error}
          </p>
          <button
            type="button"
            onClick={reload}
            className="rounded-lg border px-3 py-1.5 text-[13px]"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {strings.library.retry}
          </button>
        </div>
      )}

      {episodes === null ? (
        <div className="library-grid" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="library-card">
              <div className="poster skeleton" />
              <div className="flex flex-col gap-2 p-3">
                <div className="skeleton" style={{ height: 14 }} />
                <div className="skeleton" style={{ height: 11, width: "60%" }} />
              </div>
            </div>
          ))}
        </div>
      ) : episodes.length === 0 && !error ? (
        <p className="text-[13px]" style={{ color: "var(--mute)" }}>
          {strings.studio.empty}
        </p>
      ) : (
        <ul role="list" className="library-grid">
          {episodes.map((ep) => {
            const title = ep.title || strings.studio.untitled;
            return (
              <li key={ep.id}>
                <button
                  type="button"
                  className="library-card w-full"
                  aria-current={activeId === ep.id ? "true" : undefined}
                  aria-label={strings.library.open(title)}
                  onClick={() => onOpen(ep.id)}
                >
                  <Poster episode={ep} />
                  <span className="flex flex-col gap-1.5 p-3">
                    <span className="font-display text-[14px] font-semibold leading-snug" style={{ color: "var(--ink)" }}>
                      {title}
                    </span>
                    <span className="truncate text-[12px]" style={{ color: "var(--mute)" }}>
                      {ep.bookTitle}
                    </span>
                    <span className="card-meta flex flex-wrap items-center gap-1.5 pt-1">
                      <StatusBadge status={ep.status} label={strings.run.statusLabel(ep.status)} />
                      {ep.durationSec != null && <Badge>{strings.library.durationLabel(ep.durationSec)}</Badge>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
