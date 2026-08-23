"use client";

import { useState } from "react";
import { strings } from "@/lib/strings";
import { EmptyState } from "./ui";
import type { EpisodeState, ThumbnailRef } from "./types";

/**
 * The generated thumbnails, grouped by aspect ratio.
 *
 * Two absences are handled separately and neither one is allowed to produce a
 * broken-image icon: an episode with no `thumbnails` array at all (the field
 * does not exist yet, or the run has not reached that step) gets a sentence,
 * and an individual image that fails to load is removed from the grid.
 */
export default function Thumbnails({ episode }: { episode: EpisodeState }) {
  const [broken, setBroken] = useState<string[]>([]);
  const list = (episode.thumbnails ?? []).filter((t) => !broken.includes(t.key));

  if (list.length === 0) {
    return <EmptyState>{episode.status === "DONE" ? strings.thumbnails.empty : strings.thumbnails.pending}</EmptyState>;
  }

  const byAspect = new Map<string, ThumbnailRef[]>();
  for (const t of list) {
    const group = byAspect.get(t.aspect) ?? [];
    group.push(t);
    byAspect.set(t.aspect, group);
  }

  return (
    <div className="flex flex-col gap-3">
      {[...byAspect.entries()].map(([aspect, items]) => (
        <div key={aspect} className="flex flex-col gap-1.5">
          <span className="field-label" style={{ marginBottom: 0 }}>
            {strings.thumbnails.aspectLabel(aspect)}
          </span>
          <div className="thumb-grid">
            {items.map((t) => (
              <a
                key={t.key}
                className="thumb-tile"
                href={`/api/episodes/${episode.id}/thumbnail/${t.key}`}
                download
                title={strings.thumbnails.download(t.variant)}
                style={{ aspectRatio: `${t.width} / ${t.height}` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- session-guarded API route, not a statically optimizable asset */}
                <img
                  src={`/api/episodes/${episode.id}/thumbnail/${t.key}`}
                  alt={strings.thumbnails.alt(t.variant, t.aspect)}
                  loading="lazy"
                  onError={() => setBroken((b) => (b.includes(t.key) ? b : [...b, t.key]))}
                />
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
