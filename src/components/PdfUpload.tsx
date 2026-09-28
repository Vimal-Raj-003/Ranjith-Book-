"use client";

import { useId, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { useToast } from "./Toast";

const MAX_BYTES = 300 * 1024 * 1024;
const RIGHTS_VALUES = ["in-copyright", "public-domain", "own-work"] as const;

const fieldStyle = { background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" };
const labelClass = "font-mono text-[11px] uppercase tracking-wider";

/** "atomic_habits-2018.pdf" → "atomic habits 2018": a starting point the operator edits. */
function titleFromFile(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Upload one book PDF, then start its analysis — one action, because nobody
 * uploads a book to leave it sitting there. The PDF goes up as a raw body
 * through XMLHttpRequest rather than `fetch`, which has no upload progress: a
 * 150MB scan takes long enough that a button reading "Uploading…" with no
 * number looks exactly like a hang.
 */
export default function PdfUpload({ onStarted }: { onStarted: (uploadId: string) => void }) {
  const { show } = useToast();
  const titleId = useId();
  const rightsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [rights, setRights] = useState<string>("in-copyright");
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) return setError(strings.books.notPdf);
    if (f.size > MAX_BYTES) return setError(strings.books.tooLarge);
    setFile(f);
    if (!title.trim()) setTitle(titleFromFile(f.name));
  }

  function upload(f: File): Promise<{ uploadId: string }> {
    const params = new URLSearchParams({ title: title.trim(), rightsStatus: rights });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/books?${params}`);
      xhr.setRequestHeader("Content-Type", "application/pdf");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let body: { uploadId?: string; error?: string } | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body?.uploadId) resolve({ uploadId: body.uploadId });
        else reject(new Error(body?.error || strings.books.uploadError));
      };
      xhr.onerror = () => reject(new Error(strings.books.uploadError));
      xhr.send(f);
    });
  }

  async function start() {
    if (!file) return setError(strings.books.noFile);
    if (!title.trim()) return setError(strings.books.noTitle);
    setError(null);
    setPct(0);
    try {
      const { uploadId } = await upload(file);
      setPct(null);
      setStarting(true);
      const res = await fetch(`/api/books/${uploadId}/analyze`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || strings.books.uploadError);
      show(strings.books.started, "ok");
      setFile(null);
      setTitle("");
      onStarted(uploadId);
    } catch (err) {
      const text = err instanceof Error ? err.message : strings.books.uploadError;
      setError(text);
      show(text, "error");
    } finally {
      setPct(null);
      setStarting(false);
    }
  }

  const busy = pct !== null || starting;

  return (
    <section aria-label={strings.books.uploadHeading} className="flex flex-col gap-2.5">
      <div
        className="slab flex flex-wrap items-center justify-center gap-3 border-dashed px-4 py-4 text-center"
        style={{ borderColor: drag ? "var(--cyan)" : "var(--line)" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        {file ? (
          <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
            {strings.books.chosen(file.name, (file.size / 1024 / 1024).toFixed(1))}
          </p>
        ) : (
          <p className="text-[13px]" style={{ color: "var(--mute)" }}>
            {strings.books.dropHint}
          </p>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-lg border px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
          style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
        >
          {strings.books.choose}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={titleId} className={labelClass} style={{ color: "var(--mute-2)" }}>
            {strings.upload.titleLabel}
          </label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={strings.upload.titlePlaceholder}
            className="rounded-lg border px-3 py-1.5 text-[14px]"
            style={fieldStyle}
          />
        </div>
        <div className="flex flex-col gap-1 sm:w-[40%]">
          <label htmlFor={rightsId} className={labelClass} style={{ color: "var(--mute-2)" }}>
            {strings.upload.rightsLabel}
          </label>
          <select
            id={rightsId}
            value={rights}
            onChange={(e) => setRights(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-[14px]"
            style={fieldStyle}
          >
            {RIGHTS_VALUES.map((v) => (
              <option key={v} value={v}>
                {strings.upload.rightsOptions[v]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-lg px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
          style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
        >
          {pct !== null ? strings.books.uploading(pct) : starting ? strings.books.starting : strings.books.start}
        </button>
        {pct !== null && (
          <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--slab-2)" }} aria-hidden>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--cyan)", transition: "width .2s" }} />
          </div>
        )}
      </div>
    </section>
  );
}
