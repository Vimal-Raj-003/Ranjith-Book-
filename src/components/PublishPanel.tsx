"use client";

import CopyBlock from "./CopyBlock";
import { Disclosure, Hint } from "./ui";
import { strings } from "@/lib/strings";
import type { EpisodeState } from "./types";

/**
 * The four things that get pasted into YouTube and Instagram.
 *
 * Four boxes of pastable text is most of a laptop screen, and it is only
 * wanted at one moment — when the operator is about to post. So the whole
 * thing is a `<details>`, closed until then, and the summary names what is
 * inside it. Opening it is one keypress and nothing about the copy changed.
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
    <Disclosure className="disclosure-panel" summary={strings.publish.heading}>
      {!hasCopy ? (
        <Hint>{episode.status === "DONE" ? strings.publish.empty : strings.publish.waiting}</Hint>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid gap-2">
            {episode.title && <CopyBlock label={strings.publish.youtubeTitle} value={episode.title} rows={2} />}
            {hashtags && <CopyBlock label={strings.publish.hashtags} value={hashtags} mono rows={2} />}
            {description && <CopyBlock label={strings.publish.youtubeDescription} value={description} rows={4} />}
            {instagram && <CopyBlock label={strings.publish.instagram} value={instagram} rows={4} />}
          </div>
          {/* An empty copy box is indistinguishable from a broken one, so a
              missing field is left out and named in one line instead. */}
          {(!description || !hashtags) && <Hint>{strings.publish.partial}</Hint>}
        </div>
      )}
    </Disclosure>
  );
}
