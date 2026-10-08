"use client";

import { useCallback, useMemo, useState } from "react";
import { ToastHost } from "./Toast";
import UploadDropzone from "./UploadDropzone";
import UploadRun from "./UploadRun";
import EpisodeCard from "./EpisodeCard";
import VideoPreview from "./VideoPreview";
import PublishCenter from "./PublishCenter";
import LibraryGrid from "./LibraryGrid";
import Inspector from "./Inspector";
import Sidebar from "./Sidebar";
import { Badge, Disclosure, Panel, useMediaQuery, usePersistentFlag } from "./ui";
import { strings } from "@/lib/strings";
import FreeBooks from "./FreeBooks";
import BooksView from "./BooksView";
import type { EpisodeState, View } from "./types";

/**
 * The desktop application shell: a sidebar, a flexible workbench and an
 * inspector, collapsing to two columns below 1200px and to one below 900px.
 *
 * From 1200px up the shell is the window — `height: 100dvh`, the page itself
 * clipped, each pane scrolling inside its own box. That is the operator's
 * actual request: everything at once, no scrolling the page in either
 * direction. Under it the studio splits into two stacks, so the upload form
 * and the run sit beside the preview rather than a screen below it; below
 * 1200px they fall back to one column and the document scrolls the ordinary
 * way, which is what a phone wants.
 *
 * Both rails fold away, independently, and the choice is remembered for this
 * device. The widths live in `--side-col`/`--insp-col` on `.app-shell`, which
 * the two data attributes below switch, so what a rail gives up the middle
 * column takes — the operator's "collapse only the centre section where the
 * video we are working" read backwards: collapse everything AROUND the video.
 *
 * On a narrow window the two work stacks swap order once there is an episode
 * to look at: a phone should open on the video, not on an upload form it has
 * already been used for. The swap is in the markup rather than in CSS `order`
 * on purpose — `order` moves the picture and leaves the tab key reading the
 * old sequence, which is a worse bug than the one it fixes.
 *
 * All episode polling is owned here rather than by whichever pane happens to
 * be showing an episode. `EpisodeCard` runs the 1.5s poll for its id and
 * reports each snapshot up; the preview, the Publish Center and the inspector
 * all read that same snapshot. One poll per episode, and every pane agrees
 * with every other one.
 *
 * `PublishCenter` is the exception that proves the rule: it needs facts the
 * snapshot does not carry (whether the render is on disk, what each platform
 * would refuse), so it reads `GET /api/episodes/[id]/publish` itself -- but
 * only when the snapshot's `status` or `hasVideo` changes, never on the 1.5s
 * tick, because those are the only two things that can change its answer.
 */
export default function Studio({ email }: { email: string }) {
  const [view, setView] = useState<View>("studio");

  // Per-device UI state, not project data: which rails this person keeps open.
  const [sideOpen, setSideOpen] = usePersistentFlag("bookreel.rail.side", true);
  const [inspOpen, setInspOpen] = usePersistentFlag("bookreel.rail.insp", true);
  const narrow = useMediaQuery("(max-width: 1199px)");

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

  // Preview-first, but only once there is a preview worth leading with: on a
  // phone with nothing made yet, the upload form is the whole point of the
  // screen and putting an empty 9:16 box above it would be a regression.
  const previewFirst = narrow && Boolean(active);

  const studioStage = (
    <div className="work-col work-stage">
      <VideoPreview episode={active} />
      <PublishCenter episode={active} />
    </div>
  );

  return (
    <ToastHost>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-lg focus:px-3 focus:py-2"
        style={{ background: "var(--slab)", color: "var(--ink)" }}
      >
        {strings.app.skipToContent}
      </a>

      <div
        className="app-shell"
        data-side={sideOpen ? "open" : "collapsed"}
        data-insp={inspOpen ? "open" : "collapsed"}
      >
        <header className="app-side">
          <Sidebar
            view={view}
            onView={setView}
            email={email}
            collapsed={!sideOpen}
            onToggleCollapsed={() => setSideOpen(!sideOpen)}
          />
        </header>

        <main id="main" className="app-work" tabIndex={-1}>
          {/* `data-pane` names which view is mounted. Nothing in the app reads
              it; the layout harness waits on it, because a probe that fires
              while the previous pane is still painted measures the old tree
              and reports an overflow that does not exist. */}
          <div className="work-measure flex flex-col gap-3" data-pane={view}>
            {view === "studio" && (
              <>
                {/* One line, not four. What the studio is FOR is a sentence
                    the operator needed once; it is under the summary now. */}
                <div className="pane-head">
                  <h1 className="font-display text-[18px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
                    {strings.studio.subheading}
                  </h1>
                  <span className="text-[12px]" style={{ color: "var(--mute)" }}>
                    {strings.studio.workbenchIntro}
                  </span>
                  <div className="pane-head-end">
                    <Disclosure quiet summary={strings.studio.workbenchHelpSummary}>
                      <p className="max-w-[60ch] text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
                        {strings.studio.workbenchHelp}
                      </p>
                    </Disclosure>
                  </div>
                </div>

                <div className="work-split">
                  {/* What came out, and what you are making. On a wide window
                      the stage is on the right and takes the room the aside
                      no longer does; on a narrow one, once there is something
                      to watch, it comes first. */}
                  {previewFirst && studioStage}
                  <div className="work-col">
                    <Panel title={strings.upload.sectionHeading}>
                      <UploadDropzone onIngestStarted={(uploadId) => setRuns((list) => [uploadId, ...list])} />
                    </Panel>

                    {(runs.length > 0 || episodeIds.length > 0) && (
                      <section className="flex flex-col gap-2" aria-labelledby="runs-heading">
                        <h2 id="runs-heading" className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
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
                  </div>

                  {!previewFirst && studioStage}
                </div>
              </>
            )}

            {view === "books" && <BooksView />}

            {view === "library" && <LibraryGrid activeId={activeId} onOpen={openEpisode} />}

            {view === "free-books" && <FreeBooks />}

            {view === "queue" && (
              <section className="flex flex-col gap-3" aria-labelledby="queue-heading">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 id="queue-heading" className="font-display text-[18px] font-semibold" style={{ color: "var(--ink)" }}>
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
          <Inspector
            episode={active}
            collapsed={!inspOpen}
            onToggleCollapsed={() => setInspOpen(!inspOpen)}
          />
        </aside>
      </div>
    </ToastHost>
  );
}
