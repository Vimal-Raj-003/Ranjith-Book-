"use client";

import CopyBlock from "./CopyBlock";
import { Hint } from "./ui";
import { strings } from "@/lib/strings";
import type { EpisodeState } from "./types";

/**
 * The four things that get pasted into YouTube and Instagram.
 *
 * The description, hashtags and hook are written partway through a run. Until
 * `GET /api/episodes/[id]` returns them this panel says so in one line rather
 * than showing four empty boxes that look broken.
 */
export default function PublishPanel({ episode }: { episode: EpisodeState | null }) {
  if (!episode) return null;

  const hashtags = episode.hashtags?.join(" ") ?? "";
  const description = episode.description ?? "";
  const hook = episode.hook ?? "";
  const instagram = [hook, description, hashtags].filter(Boolean).join("\n\n");
  const hasCopy = Boolean(episode.title || description || hashtags);

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`publish-${episode.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`publish-${episode.id}`} className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
          {strings.publish.heading}
        </h2>
      </div>

      {!hasCopy ? (
        <div className="panel panel-body">
          <Hint>{episode.status === "DONE" ? strings.publish.empty : strings.publish.waiting}</Hint>
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {episode.title && <CopyBlock label={strings.publish.youtubeTitle} value={episode.title} rows={2} />}
            {hashtags && <CopyBlock label={strings.publish.hashtags} value={hashtags} mono rows={2} />}
            {description && <CopyBlock label={strings.publish.youtubeDescription} value={description} rows={6} />}
            {instagram && <CopyBlock label={strings.publish.instagram} value={instagram} rows={6} />}
          </div>
          {/* An empty copy box is indistinguishable from a broken one, so a
              missing field is left out and named in one line instead. */}
          {(!description || !hashtags) && <Hint>{strings.publish.partial}</Hint>}
        </>
      )}
    </section>
  );
}
