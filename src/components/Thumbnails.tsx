"use client";

import { useId, useState } from "react";
import { strings } from "@/lib/strings";
import { pickPoster } from "@/lib/thumbnails/choose";
import { thumbUrl } from "@/lib/thumbnails/url";
import { EmptyState, Hint } from "./ui";
import { useToast } from "./Toast";
import type { EpisodeState, ThumbnailRef } from "./types";

/** What an episode's posters look like once an edit has been answered by the server. */
interface Edited {
  thumbnails: ThumbnailRef[];
  thumbChoice: string | null;
  thumbHeadline: string | null;
}

/** `failed` is how many posters a retitle could not redraw (and so dropped). */
type Answer = Edited & { failed?: number };

/**
 * The generated thumbnails, grouped by aspect ratio, with the two edits an
 * operator makes to them: which poster represents the episode, and what its
 * headline says.
 *
 * Two absences are handled separately and neither one is allowed to produce a
 * broken-image icon: an episode with no `thumbnails` array at all (the field
 * does not exist yet, or the run has not reached that step) gets a sentence,
 * and an individual image that fails to load is removed from the grid.
 *
 * The component keeps its own copy of what an edit produced, per episode,
 * because the inspector's snapshot of the episode is polled only while a run is
 * live and is never refreshed after. Without it a retitle would succeed on the
 * server and leave the old posters on screen. The server's answer carries the
 * new revisions; every URL here is built with them (`thumbUrl`), so the browser
 * fetches the redone poster instead of the year-old cached one -- for the
 * preview and for the download link alike.
 */
export default function Thumbnails({ episode }: { episode: EpisodeState }) {
  const toast = useToast();
  const headlineId = useId();
  const hintId = `${headlineId}-hint`;
  const [broken, setBroken] = useState<string[]>([]);
  const [edited, setEdited] = useState<Record<string, Edited>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<"choice" | "retitle" | null>(null);

  const id = episode.id;
  const mine = edited[id];
  const thumbnails = mine?.thumbnails ?? episode.thumbnails ?? [];
  // `||`: an empty string is "nothing set", exactly as null is.
  const choice = (mine ? mine.thumbChoice : episode.thumbChoice) || null;
  const saved = (mine ? mine.thumbHeadline : episode.thumbHeadline) || "";
  const draft = drafts[id] ?? saved;

  // Broken images are remembered by URL, so a redone poster (new revision, new
  // URL) gets a fresh chance, and one episode's failure never hides another's.
  const list = thumbnails.filter((t) => !broken.includes(thumbUrl(id, t, "grid")));
  const selected = pickPoster(list, choice)?.key ?? null;

  /** POST one edit. Resolves to the server's view of the episode, or throws a message to show. */
  async function send(payload: { choice: string } | { headline: string }, fallback: string): Promise<Answer> {
    let res: Response;
    try {
      res = await fetch(`/api/episodes/${id}/thumbnail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error(fallback);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === "string" && data.error ? data.error : fallback);
    return data as Answer;
  }

  async function choose(key: string) {
    if (pending || key === selected) return;
    const before: Edited = { thumbnails, thumbChoice: choice, thumbHeadline: saved || null };
    setEdited((all) => ({ ...all, [id]: { ...before, thumbChoice: key } })); // optimistic: the tile highlights at once
    setPending("choice");
    try {
      const answer = await send({ choice: key }, strings.thumbnails.choiceFailed);
      setEdited((all) => ({ ...all, [id]: answer }));
    } catch (err) {
      setEdited((all) => ({ ...all, [id]: before })); // roll back rather than lie about it
      toast.show((err as Error).message, "error");
    } finally {
      setPending(null);
    }
  }

  async function retitle() {
    if (pending) return;
    // No optimistic write here: six posters are being redrawn, so there is
    // nothing true to show until they have been. The grid dims instead.
    setPending("retitle");
    try {
      const answer = await send({ headline: draft }, strings.thumbnails.retitleFailed);
      setEdited((all) => ({ ...all, [id]: answer }));
      setDrafts((all) => ({ ...all, [id]: answer.thumbHeadline ?? "" }));
      if (answer.failed) toast.show(strings.thumbnails.retitledPartial(answer.failed), "warn");
      else toast.show(strings.thumbnails.retitled, "ok");
    } catch (err) {
      toast.show((err as Error).message, "error"); // the draft stays as typed
    } finally {
      setPending(null);
    }
  }

  if (list.length === 0) {
    return <EmptyState>{episode.status === "DONE" ? strings.thumbnails.empty : strings.thumbnails.pending}</EmptyState>;
  }

  const byAspect = new Map<string, ThumbnailRef[]>();
  for (const t of list) {
    const group = byAspect.get(t.aspect) ?? [];
    group.push(t);
    byAspect.set(t.aspect, group);
  }

  const changed = draft.trim() !== saved;

  return (
    <div className="flex flex-col gap-3">
      {[...byAspect.entries()].map(([aspect, items]) => (
        <div key={aspect} className="flex flex-col gap-1.5">
          <span className="field-label" style={{ marginBottom: 0 }}>
            {strings.thumbnails.aspectLabel(aspect)}
          </span>
          <div className="thumb-grid" aria-busy={pending === "retitle"}>
            {items.map((t) => {
              const isSelected = t.key === selected;
              return (
                <div key={t.key} className="thumb-cell">
                  <a
                    className="thumb-tile"
                    href={thumbUrl(id, t)}
                    download
                    title={strings.thumbnails.download(t.variant)}
                    style={{ aspectRatio: `${t.width} / ${t.height}` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- session-guarded API route, not a statically optimizable asset */}
                    <img
                      src={thumbUrl(id, t, "grid")}
                      alt={strings.thumbnails.alt(t.variant, t.aspect)}
                      loading="lazy"
                      onError={() => {
                        const url = thumbUrl(id, t, "grid");
                        setBroken((b) => (b.includes(url) ? b : [...b, url]));
                      }}
                    />
                  </a>
                  <button
                    type="button"
                    className="chip"
                    data-state={isSelected ? "on" : "off"}
                    aria-pressed={isSelected}
                    aria-label={strings.thumbnails.useLabel(t.variant, t.aspect)}
                    disabled={pending !== null}
                    onClick={() => choose(t.key)}
                  >
                    <span className="truncate">{isSelected ? strings.thumbnails.inUse : strings.thumbnails.use}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void retitle();
        }}
      >
        <label htmlFor={headlineId} className="field-label" style={{ marginBottom: 0 }}>
          {strings.thumbnails.headlineLabel}
        </label>
        <div className="flex gap-2">
          <input
            id={headlineId}
            type="text"
            className="control min-w-0 flex-1"
            value={draft}
            maxLength={120}
            placeholder={strings.thumbnails.headlinePlaceholder}
            aria-describedby={hintId}
            disabled={pending !== null}
            onChange={(e) => setDrafts((all) => ({ ...all, [id]: e.target.value }))}
          />
          <button
            type="submit"
            className="rounded-lg border px-3.5 py-1.5 text-[13px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
            disabled={pending !== null || !changed}
          >
            {pending === "retitle" ? strings.thumbnails.retitling : strings.thumbnails.retitle}
          </button>
        </div>
        <Hint id={hintId}>{strings.thumbnails.headlineHint}</Hint>
      </form>
    </div>
  );
}
