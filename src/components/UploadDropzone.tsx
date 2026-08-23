"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import { checkPhotoBatch } from "@/lib/ingest/validate";

interface PhotoItem {
  id: string;
  file: File;
  url: string;
  error?: string;
}

const RIGHTS_VALUES = ["public-domain", "in-copyright", "own-work"] as const;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

/**
 * The dropzone, plus the reorderable thumbnail strip.
 *
 * Order here IS the reading order the video is built from, so it has to be
 * visible and adjustable before ingest ever starts — and adjustable by
 * keyboard, not only by drag, since drag alone leaves anyone who can't drag
 * with no way to fix a misordered page. Every thumbnail gets move-up /
 * move-down buttons alongside the drag handle for exactly that reason.
 */
export default function UploadDropzone({
  onIngestStarted,
}: {
  /** Called once `POST /api/uploads/[id]/ingest` has been accepted, so the
   *  parent can start showing that run's progress. */
  onIngestStarted?: (uploadId: string) => void;
}) {
  const { show } = useToast();
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [title, setTitle] = useState("");
  // Optional. Never validated here into an error: the server drops anything
  // that is not an http(s) URL and stores null, so a typo can never cost the
  // operator a batch of photographs they have already taken.
  const [bookLink, setBookLink] = useState("");
  const [rights, setRights] = useState<string>("in-copyright");
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const itemsRef = useRef<PhotoItem[]>(items);

  const titleId = useId();
  const bookLinkId = useId();
  const bookLinkHintId = useId();
  const rightsId = useId();

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Object URLs are created client-side the moment a file is picked, so a
  // thumbnail appears before any network request starts, and are revoked on
  // removal/unmount so they don't leak.
  useEffect(() => {
    return () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
    };
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || f.type === "");
    if (files.length === 0) return;
    setItems((list) => [
      ...list,
      ...files.map((file) => ({ id: newId(), file, url: URL.createObjectURL(file) })),
    ]);
    setUploadId(null);
  }

  function removeAt(index: number) {
    setItems((list) => {
      const target = list[index];
      if (target) URL.revokeObjectURL(target.url);
      return list.filter((_, i) => i !== index);
    });
    setUploadId(null);
  }

  function move(from: number, to: number) {
    if (to < 0 || from === to) return;
    setItems((list) => {
      if (to >= list.length) return list;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setUploadId(null);
  }

  async function handleUpload() {
    if (busy) return;
    setBannerError(null);

    if (!title.trim()) {
      setBannerError(strings.upload.noTitleError);
      return;
    }
    if (items.length === 0) {
      setBannerError(strings.upload.noPhotosError);
      return;
    }

    // A quick client-side pass through the same pure check the server uses,
    // so an obviously-too-big batch is caught without a round trip. The
    // server still re-checks against the real received bytes — a client is
    // never trusted for that, only warned by it.
    try {
      checkPhotoBatch(items.map((it) => ({ name: it.file.name, bytes: it.file.size })));
    } catch (err) {
      const message = err instanceof Error ? err.message : strings.upload.genericError;
      setBannerError(message);
      show(message, "error");
      return;
    }

    setBusy(true);
    setItems((list) => list.map((it) => ({ ...it, error: undefined })));

    const form = new FormData();
    form.set("title", title.trim());
    form.set("bookLink", bookLink.trim());
    form.set("rightsStatus", rights);
    for (const item of items) form.append("photos", item.file, item.file.name);

    try {
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message: string = body.error || strings.upload.genericError;
        const matchIndex = items.findIndex((it) => message.includes(it.file.name));
        if (matchIndex >= 0) {
          setItems((list) => list.map((it, i) => (i === matchIndex ? { ...it, error: message } : it)));
        } else {
          setBannerError(message);
        }
        show(message, "error");
        return;
      }

      setUploadId(body.uploadId as string);
      show(strings.upload.uploadSuccess(body.pages?.length ?? items.length), "ok");
    } catch {
      setBannerError(strings.upload.genericError);
      show(strings.upload.genericError, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleIngest() {
    if (!uploadId || ingesting) return;
    setIngesting(true);
    try {
      const res = await fetch(`/api/uploads/${uploadId}/ingest`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || strings.upload.ingestError);

      show(strings.upload.ingestStarted, "ok");
      onIngestStarted?.(uploadId);

      // The run now lives under its own id; clear the dropzone so the
      // operator can start a fresh batch while this one processes.
      for (const it of items) URL.revokeObjectURL(it.url);
      setItems([]);
      setTitle("");
      setBookLink("");
      setUploadId(null);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : strings.upload.ingestError;
      setBannerError(messageText);
      show(messageText, "error");
    } finally {
      setIngesting(false);
    }
  }

  return (
    /* The heading lives on the panel this sits inside, so the section is
       labelled rather than titled twice. */
    <section aria-label={strings.upload.sectionHeading} className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={titleId} className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.upload.titleLabel}
          </label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={strings.upload.titlePlaceholder}
            className="rounded-lg border px-3 py-2 text-[14px]"
            style={{ background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" }}
          />
        </div>

        {/* Optional, and said so on the label rather than only in the hint —
            a field with no "(optional)" on it reads as required, and this one
            is the difference between a video that ends on a purchase card and
            one that quietly does not. */}
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={bookLinkId} className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.upload.bookLinkLabel}
          </label>
          <input
            id={bookLinkId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={bookLink}
            onChange={(e) => setBookLink(e.target.value)}
            placeholder={strings.upload.bookLinkPlaceholder}
            aria-describedby={bookLinkHintId}
            className="rounded-lg border px-3 py-2 text-[14px]"
            style={{ background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" }}
          />
          <p id={bookLinkHintId} className="text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
            {strings.upload.bookLinkHint}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={rightsId} className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.upload.rightsLabel}
          </label>
          <select
            id={rightsId}
            value={rights}
            onChange={(e) => setRights(e.target.value)}
            className="rounded-lg border px-3 py-2 text-[14px]"
            style={{ background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {RIGHTS_VALUES.map((value) => (
              <option key={value} value={value}>
                {strings.upload.rightsOptions[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* The actual keyboard-reachable entry point: dragging is a bonus, the
          button is not optional. */}
      <div
        className="slab flex flex-col items-center gap-2 border-dashed px-4 py-6 text-center"
        style={{ borderColor: dragActive ? "var(--cyan)" : "var(--line)" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        <p className="text-[13px]" style={{ color: "var(--mute)" }}>
          {strings.upload.dropHint}
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border px-4 py-2 text-[13px] font-semibold"
          style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
        >
          {strings.upload.chooseFiles}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div aria-live="polite" className="sr-only">
        {items.length > 0 ? strings.upload.readyAnnouncement(items.length) : ""}
      </div>

      {items.length === 0 ? (
        <p style={{ color: "var(--mute)" }}>{strings.upload.emptyHint}</p>
      ) : (
        <ul
          role="list"
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" }}
        >
          {items.map((item, index) => {
            const page = index + 1;
            return (
              <li
                key={item.id}
                role="listitem"
                draggable
                onDragStart={() => {
                  dragIndexRef.current = index;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndexRef.current;
                  dragIndexRef.current = null;
                  if (from !== null && from !== index) move(from, index);
                }}
                className="thumb-in slab flex flex-col gap-1.5 p-2"
              >
                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-md" style={{ background: "var(--slab-2)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob: URL, not an optimizable remote asset */}
                  <img
                    src={item.url}
                    alt={strings.upload.thumbAlt(page)}
                    className="h-full w-full object-cover"
                  />
                  <span
                    className="absolute left-1 top-1 rounded font-mono text-[11px]"
                    style={{ background: "var(--scrim)", color: "#fff", padding: "1px 5px" }}
                  >
                    {strings.upload.pageLabel(page)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, index - 1)}
                    disabled={index === 0}
                    aria-label={strings.upload.moveUp(page)}
                    className="flex h-6 w-6 items-center justify-center rounded border text-[12px] disabled:opacity-30"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, index + 1)}
                    disabled={index === items.length - 1}
                    aria-label={strings.upload.moveDown(page)}
                    className="flex h-6 w-6 items-center justify-center rounded border text-[12px] disabled:opacity-30"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(index)}
                    aria-label={strings.upload.removePage(page)}
                    className="flex h-6 w-6 items-center justify-center rounded border text-[12px]"
                    style={{ borderColor: "var(--line)", color: "var(--rose)" }}
                  >
                    ✕
                  </button>
                </div>

                {item.error && (
                  <p role="alert" className="text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
                    {item.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {bannerError && (
        <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
          {bannerError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleUpload}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-50"
          style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
        >
          {busy ? strings.upload.uploading : strings.upload.uploadButton}
        </button>

        {uploadId && (
          <button
            type="button"
            onClick={handleIngest}
            disabled={ingesting}
            className="rounded-lg border px-4 py-2 text-[13px] font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {ingesting ? strings.upload.ingestStarting : strings.upload.ingestButton}
          </button>
        )}
      </div>
    </section>
  );
}
