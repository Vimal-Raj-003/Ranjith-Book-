"use client";

import { useEffect, useState } from "react";
import { ToastHost, useToast } from "./Toast";
import { strings } from "@/lib/strings";

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
        <EpisodeList />
      </main>
    </ToastHost>
  );
}
