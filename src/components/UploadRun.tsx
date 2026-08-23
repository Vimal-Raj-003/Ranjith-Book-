"use client";

import { useEffect, useState } from "react";
import PipelineRail from "./PipelineRail";
import { Panel } from "./ui";
import { strings } from "@/lib/strings";
import { POLL_MS } from "./EpisodeCard";

/**
 * One upload's ingest phase, polled until it hands off at least one episode
 * id — before that, there is nothing else in the UI to poll (see the doc
 * comment on `GET /api/uploads/[id]`). The episodes themselves are polled by
 * `EpisodeCard`, hoisted into `Studio` so each id is polled exactly once.
 */
export default function UploadRun({
  uploadId,
  onEpisodes,
}: {
  uploadId: string;
  /** Called with this upload's episode ids as soon as they exist. */
  onEpisodes: (ids: string[]) => void;
}) {
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
        if (body.episodeIds.length > 0) onEpisodes(body.episodeIds as string[]);
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
  }, [uploadId, onEpisodes]);

  // Once the episodes exist they are rendered by `Studio`, so this pane has
  // nothing left to say.
  if (!state || state.episodeIds.length > 0) return null;

  return (
    <Panel title={strings.run.ingestHeading}>
      <div aria-live="polite">
        <PipelineRail step={state.step} status={state.status} error={state.error} />
      </div>
      {state.status === "FAILED" && (
        <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--rose)" }}>
          {state.error || strings.run.failed}
        </p>
      )}
    </Panel>
  );
}
