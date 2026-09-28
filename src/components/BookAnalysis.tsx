"use client";

import { useCallback, useEffect, useState } from "react";
import { ANALYSIS_STEPS } from "@/lib/pipeline-steps";
import { strings } from "@/lib/strings";
import type { AnalysisView, EpisodeState } from "./types";
import PipelineRail from "./PipelineRail";
import IdeaCard from "./IdeaCard";
import VideoPreview from "./VideoPreview";
import { Disclosure, EmptyState, Panel } from "./ui";
import EpisodeCard, { POLL_MS } from "./EpisodeCard";
import { useToast } from "./Toast";

/**
 * One book's analysis: its progress while it runs, then its ideas.
 *
 * Polls until the run settles. Unlike the photo ingest poll, a failed or
 * non-OK response does not end the polling while the run is live — a single
 * dropped request during a ten-minute analysis must not freeze the screen on
 * whatever step it last saw.
 */
export default function BookAnalysis({ uploadId, onChanged }: { uploadId: string; onChanged: () => void }) {
  const { show } = useToast();
  const [view, setView] = useState<AnalysisView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [episodeStates, setEpisodeStates] = useState<Record<string, EpisodeState>>({});

  // One EpisodeCard per video polls it and reports here; the preview reads
  // the same snapshot, exactly as the photo Studio does.
  const handleEpisodeState = useCallback((state: EpisodeState) => {
    setEpisodeStates((prev) => {
      const before = prev[state.id];
      if (before && JSON.stringify(before) === JSON.stringify(state)) return prev;
      return { ...prev, [state.id]: state };
    });
  }, []);

  async function generate() {
    if (!view) return;
    const ideaIds = view.ideas.filter((i) => i.selected).map((i) => i.id);
    if (!ideaIds.length) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/books/${uploadId}/videos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ideaIds }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.episodes) throw new Error(body?.error || strings.books.generateError);
      const list = body.episodes as { ideaId: string; episodeId: string; created: boolean }[];
      show(strings.books.generated(list.filter((e) => e.created).length, list.filter((e) => !e.created).length), "ok");
      setSelectedVideo(list[0]?.episodeId ?? null);
      // Re-read the book so every idea carries its episode id.
      setPollKey((k) => k + 1);
    } catch (err) {
      show(err instanceof Error ? err.message : strings.books.generateError, "error");
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let misses = 0;

    async function poll() {
      try {
        const res = await fetch(`/api/books/${uploadId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) return setLoadError(true);
        const body = (await res.json().catch(() => null)) as AnalysisView | null;
        if (!res.ok || !body) throw new Error();
        misses = 0;
        setView(body);
        if (body.status === "DONE" || body.status === "FAILED") {
          onChanged();
          return;
        }
      } catch {
        if (++misses >= 20) return setLoadError(true);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [uploadId, pollKey, onChanged]);

  async function retry() {
    setRetrying(true);
    try {
      const res = await fetch(`/api/books/${uploadId}/analyze`, { method: "POST" });
      if (!res.ok) throw new Error();
      setView((v) => (v ? { ...v, status: "QUEUED", error: null } : v));
      setPollKey((k) => k + 1);
    } catch {
      show(strings.books.retryError, "error");
    } finally {
      setRetrying(false);
    }
  }

  const toggle = useCallback(
    async (ideaId: string, selected: boolean) => {
      setPending((s) => new Set(s).add(ideaId));
      // Optimistic, then rolled back if the write fails.
      setView((v) => v && { ...v, ideas: v.ideas.map((i) => (i.id === ideaId ? { ...i, selected } : i)) });
      try {
        const res = await fetch(`/api/books/${uploadId}/ideas/${ideaId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selected }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setView((v) => v && { ...v, ideas: v.ideas.map((i) => (i.id === ideaId ? { ...i, selected: !selected } : i)) });
        show(strings.books.selectError, "error");
      } finally {
        setPending((s) => {
          const next = new Set(s);
          next.delete(ideaId);
          return next;
        });
      }
    },
    [uploadId, show],
  );

  if (loadError) return <EmptyState>{strings.books.loadError}</EmptyState>;
  if (!view) return <EmptyState>{strings.studio.loading}</EmptyState>;

  const live = view.status !== "DONE";
  const selectedCount = view.ideas.filter((i) => i.selected).length;
  // Videos are listed in the order of the ideas they were made from.
  const videoIds = view.ideas.map((i) => i.episode?.id).filter((id): id is string => Boolean(id));
  const activeVideo = selectedVideo && videoIds.includes(selectedVideo) ? selectedVideo : (videoIds[0] ?? null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-[17px] font-semibold" style={{ color: "var(--ink)" }}>
          {view.bookTitle}
        </h2>
        <span className="text-[12px]" style={{ color: "var(--mute)" }}>
          {strings.books.pages(view.pageCount)}
        </span>
      </div>

      {live && (
        <Panel title={strings.books.runHeading}>
          <div aria-live="polite" className="flex flex-col gap-2">
            <PipelineRail step={view.step} status={view.status} error={view.error} stepList={ANALYSIS_STEPS} />
            {view.progress && view.status !== "FAILED" && (
              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: "var(--slab-2)" }} aria-hidden>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${view.progress.total ? Math.round((view.progress.done / view.progress.total) * 100) : 0}%`,
                      background: "var(--cyan)",
                      transition: "width .4s",
                    }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--mute)" }}>
                  {view.progress.label}
                </span>
              </div>
            )}
          </div>
          {view.status === "FAILED" && (
            <div className="mt-3 flex flex-col items-start gap-2">
              <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
                {view.error || strings.run.failed}
              </p>
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="rounded-lg border px-3 py-1 text-[12.5px] font-semibold disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              >
                {retrying ? strings.books.retrying : strings.books.retry}
              </button>
            </div>
          )}
        </Panel>
      )}

      {view.notes.length > 0 && (
        <Disclosure quiet summary={strings.books.notes(view.notes.length)}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
            {view.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Disclosure>
      )}

      {view.status === "DONE" && (
        <section aria-labelledby="ideas-heading" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <h2 id="ideas-heading" className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
                {strings.books.ideasHeading(view.ideas.length)}
              </h2>
              <p className="text-[12px]" style={{ color: "var(--mute)" }}>
                {strings.books.ideasIntro(view.pageCount)}
              </p>
            </div>
            <span className="font-mono text-[11.5px]" style={{ color: "var(--mute)" }}>
              {strings.books.selectedCount(selectedCount)}
            </span>
            <button
              type="button"
              onClick={generate}
              disabled={selectedCount === 0 || generating}
              aria-describedby="generate-hint"
              className="rounded-lg px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
              style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
            >
              {generating ? strings.books.generating : strings.books.generate(selectedCount)}
            </button>
          </div>
          <p id="generate-hint" className="text-[11.5px]" style={{ color: "var(--mute-2)" }}>
            {selectedCount === 0 ? strings.books.generateNone : strings.books.generateHint}
          </p>

          {videoIds.length > 0 && (
            <section aria-labelledby="videos-heading" className="flex flex-col gap-2">
              <h2 id="videos-heading" className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
                {strings.books.videosHeading}
              </h2>
              <div className="grid items-start gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
                <div className="flex flex-col gap-2">
                  {videoIds.map((id) => (
                    <EpisodeCard
                      key={id}
                      episodeId={id}
                      active={id === activeVideo}
                      onSelect={setSelectedVideo}
                      onState={handleEpisodeState}
                    />
                  ))}
                </div>
                <VideoPreview episode={activeVideo ? (episodeStates[activeVideo] ?? null) : null} />
              </div>
            </section>
          )}

          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
            {view.ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} busy={pending.has(idea.id)} onToggle={(sel) => toggle(idea.id, sel)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
