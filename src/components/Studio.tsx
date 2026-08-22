"use client";

import { useEffect, useState } from "react";
import { ToastHost, useToast } from "./Toast";
import UploadDropzone from "./UploadDropzone";
import PipelineRail from "./PipelineRail";
import RunClock from "./RunClock";
import { strings } from "@/lib/strings";

const POLL_MS = 1500;
const TERMINAL = new Set(["DONE", "FAILED"]);

interface EpisodeState {
  id: string;
  bookTitle: string;
  title: string | null;
  status: string;
  step: string;
  error: string | null;
  notes: string[];
  partNumber: number;
  seriesTotal: number;
  hasVideo: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalMs: number | null;
}

/** One episode's rail, polled every 1.5s until it reaches a terminal state,
 *  with a video player once the render is done. */
function EpisodeRun({ episodeId }: { episodeId: string }) {
  const [episode, setEpisode] = useState<EpisodeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/api/episodes/${episodeId}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (cancelled || !res.ok || !body) return;
        setEpisode(body as EpisodeState);
        if (!TERMINAL.has(body.status)) {
          timer = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [episodeId]);

  if (!episode) return null;

  return (
    <div className="slab flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
          {strings.run.episodeLabel(episode.partNumber, episode.seriesTotal)}
        </span>
        <RunClock startedAt={episode.startedAt} totalMs={episode.totalMs} running={episode.status === "RUNNING"} />
      </div>

      <span className="font-display text-[15px]" style={{ color: "var(--ink)" }}>
        {episode.title || strings.studio.untitled}
      </span>

      <PipelineRail step={episode.step} status={episode.status} error={episode.error} />

      {episode.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {episode.notes.map((n, i) => (
            <li key={i} className="text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
              {n}
            </li>
          ))}
        </ul>
      )}

      {episode.status === "FAILED" && (
        <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
          {episode.error || strings.run.failed}
        </p>
      )}

      {episode.hasVideo && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold" style={{ color: "var(--cyan)" }}>
            {strings.run.videoReady}
          </span>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- SRT is generated separately, not attached as a track here */}
          <video
            controls
            playsInline
            src={`/api/episodes/${episodeId}/video`}
            className="w-full rounded-lg"
            style={{ background: "#000", aspectRatio: "9 / 16" }}
          />
        </div>
      )}
    </div>
  );
}

/** One upload's ingest phase, polled until it hands off at least one episode
 *  id — before that, there is nothing else in the UI to poll (see the doc
 *  comment on `GET /api/uploads/[id]`). */
function UploadRun({ uploadId }: { uploadId: string }) {
  const [state, setState] = useState<{
    status: string;
    step: string;
    error: string | null;
    episodeIds: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/api/uploads/${uploadId}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (cancelled || !res.ok || !body) return;
        setState(body);
        // Once episodes exist, each one polls itself — no need to keep
        // polling the upload too.
        if (body.episodeIds.length === 0 && body.status !== "FAILED") {
          timer = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [uploadId]);

  if (!state) return null;

  if (state.episodeIds.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        {state.episodeIds.map((id) => (
          <EpisodeRun key={id} episodeId={id} />
        ))}
      </div>
    );
  }

  return (
    <div className="slab flex flex-col gap-3 p-4">
      <PipelineRail step={state.step} status={state.status} error={state.error} />
    </div>
  );
}

interface EpisodeSummary {
  id: string;
  title: string | null;
  status: string;
  step: string;
  theme: string;
  partNumber: number;
  seriesTotal: number;
  durationSec: number | null;
  createdAt: string;
  bookTitle: string;
}

function EpisodeList() {
  const { show } = useToast();
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/episodes", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || strings.studio.loadError);
        if (!cancelled) setEpisodes(data.episodes ?? []);
      } catch (err) {
        if (cancelled) return;
        setEpisodes([]);
        show((err as Error).message || strings.studio.loadError, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [show]);

  if (episodes === null) {
    return (
      <p style={{ color: "var(--mute)" }} aria-live="polite">
        {strings.studio.loading}
      </p>
    );
  }

  if (episodes.length === 0) {
    return (
      <p style={{ color: "var(--mute)" }}>{strings.studio.empty}</p>
    );
  }

  return (
    <ul role="list" className="flex flex-col gap-3">
      {episodes.map((ep) => (
        <li
          key={ep.id}
          role="listitem"
          className="slab flex flex-col gap-1 px-4 py-3"
        >
          <span className="font-display text-[15px]" style={{ color: "var(--ink)" }}>
            {ep.title || strings.studio.untitled}
          </span>
          <span className="font-mono text-[12px]" style={{ color: "var(--mute)" }}>
            {ep.bookTitle} · {ep.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Studio() {
  // Every upload the operator has started ingesting THIS session, newest
  // first. There is no need to persist this across a reload — a finished run
  // shows up in `EpisodeList` regardless, and a run still in progress is
  // resumed the moment `GET /api/uploads/[id]` is polled again after a
  // reload, since progress lives in the database, not in this state.
  const [runs, setRuns] = useState<string[]>([]);

  return (
    <ToastHost>
      <main
        className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-6 px-5 py-10"
        style={{ background: "var(--void)", color: "var(--ink)" }}
      >
        <header>
          <div className="eyebrow">{strings.studio.heading}</div>
          <h1 className="mt-2 font-display text-[26px] font-semibold leading-tight">
            {strings.studio.subheading}
          </h1>
        </header>
        <UploadDropzone onIngestStarted={(uploadId) => setRuns((list) => [uploadId, ...list])} />

        {runs.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
              {strings.run.heading}
            </h2>
            {runs.map((uploadId) => (
              <UploadRun key={uploadId} uploadId={uploadId} />
            ))}
          </section>
        )}

        <EpisodeList />
      </main>
    </ToastHost>
  );
}
