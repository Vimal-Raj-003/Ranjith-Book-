"use client";

import { useCallback, useMemo, useState } from "react";
import { ToastHost } from "./Toast";
import UploadDropzone from "./UploadDropzone";
import UploadRun from "./UploadRun";
import EpisodeCard from "./EpisodeCard";
import VideoPreview from "./VideoPreview";
import PublishPanel from "./PublishPanel";
import LibraryGrid from "./LibraryGrid";
import Inspector from "./Inspector";
import Sidebar from "./Sidebar";
import { Badge, Panel } from "./ui";
import { strings } from "@/lib/strings";
import FreeBooks from "./FreeBooks";
import type { EpisodeState, View } from "./types";

/**
 * The desktop application shell: a fixed sidebar, a flexible workbench and an
 * inspector, collapsing to two columns below 1200px and to one below 900px.
 *
 * All episode polling is owned here rather than by whichever pane happens to
 * be showing an episode. `EpisodeCard` runs the 1.5s poll for its id and
 * reports each snapshot up; the preview, the publish blocks and the inspector
 * all read that same snapshot. One poll per episode, and every pane agrees
 * with every other one.
 */
export default function Studio({ email }: { email: string }) {
  const [view, setView] = useState<View>("studio");

  // Every upload the operator has started ingesting THIS session, newest
  // first. There is no need to persist this across a reload — a finished run
  // shows up in the library regardless, and a run still in progress is
  // resumed the moment `GET /api/uploads/[id]` is polled again after a
  // reload, since progress lives in the database, not in this state.
  const [runs, setRuns] = useState<string[]>([]);
  const [episodeIds, setEpisodeIds] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, EpisodeState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const watchEpisodes = useCallback((ids: string[]) => {
    setEpisodeIds((prev) => {
      const added = ids.filter((id) => !prev.includes(id));
      return added.length === 0 ? prev : [...added, ...prev];
    });
  }, []);

  const handleState = useCallback((state: EpisodeState) => {
    setStates((prev) => {
      const before = prev[state.id];
      // Skip the write when nothing changed, so a poll that returns an
      // identical snapshot cannot re-render the panes underneath it.
      if (before && JSON.stringify(before) === JSON.stringify(state)) return prev;
      return { ...prev, [state.id]: state };
    });
  }, []);

  const openEpisode = useCallback(
    (id: string) => {
      watchEpisodes([id]);
      setSelectedId(id);
      setView("studio");
    },
    [watchEpisodes],
  );

  const activeId = selectedId ?? episodeIds[0] ?? null;
  const active = useMemo(() => (activeId ? (states[activeId] ?? null) : null), [activeId, states]);

  return (
    <ToastHost>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-lg focus:px-3 focus:py-2"
        style={{ background: "var(--slab)", color: "var(--ink)" }}
      >
        {strings.app.skipToContent}
      </a>

      <div className="app-shell">
        <header className="app-side">
          <Sidebar view={view} onView={setView} email={email} />
        </header>

        <main id="main" className="app-work" tabIndex={-1}>
          <div className="work-measure flex flex-col gap-6">
            {view === "studio" && (
              <>
                <div>
                  <div className="eyebrow">{strings.studio.workbench}</div>
                  <h1 className="mt-2 font-display text-[24px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
                    {strings.studio.subheading}
                  </h1>
                  <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed" style={{ color: "var(--mute)" }}>
                    {strings.studio.workbenchIntro}
                  </p>
                </div>

                <Panel title={strings.upload.sectionHeading}>
                  <UploadDropzone onIngestStarted={(uploadId) => setRuns((list) => [uploadId, ...list])} />
                </Panel>

                {(runs.length > 0 || episodeIds.length > 0) && (
                  <section className="flex flex-col gap-3" aria-labelledby="runs-heading">
                    <h2 id="runs-heading" className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
                      {strings.run.heading}
                    </h2>
                    {runs.map((uploadId) => (
                      <UploadRun key={uploadId} uploadId={uploadId} onEpisodes={watchEpisodes} />
                    ))}
                    {episodeIds.map((id) => (
                      <EpisodeCard
                        key={id}
                        episodeId={id}
                        active={id === activeId}
                        onSelect={setSelectedId}
                        onState={handleState}
                      />
                    ))}
                  </section>
                )}

                <VideoPreview episode={active} />
                <PublishPanel episode={active} />
              </>
            )}

            {view === "library" && <LibraryGrid activeId={activeId} onOpen={openEpisode} />}

            {view === "free-books" && <FreeBooks />}

            {view === "queue" && (
              <section className="flex flex-col gap-4" aria-labelledby="queue-heading">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 id="queue-heading" className="font-display text-[24px] font-semibold" style={{ color: "var(--ink)" }}>
                    {strings.queue.heading}
                  </h1>
                  <Badge tone="soon">{strings.queue.badge}</Badge>
                </div>
                <Panel>
                  <p className="max-w-[56ch] text-[13px] leading-relaxed" style={{ color: "var(--mute)" }}>
                    {strings.queue.body}
                  </p>
                </Panel>
              </section>
            )}
          </div>
        </main>

        <aside className="app-insp" aria-label={strings.inspector.heading}>
          <Inspector episode={active} />
        </aside>
      </div>
    </ToastHost>
  );
}
