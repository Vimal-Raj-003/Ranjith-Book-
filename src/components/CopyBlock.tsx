"use client";

import { useState } from "react";

export default function CopyBlock({
  label,
  value,
  mono = false,
  rows = 6,
}: {
  label: string;
  value: string;
  mono?: boolean;
  rows?: number;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="slab overflow-hidden">
      <header className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--line)" }}>
        <span className="eyebrow">{label}</span>
        <button
          onClick={copy}
          className="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors"
          style={{
            color: copied ? "var(--cyan)" : "var(--mute)",
            background: copied ? "color-mix(in srgb, var(--cyan) 12%, transparent)" : "transparent",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <div
        className={`max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 text-[13.5px] leading-relaxed ${
          mono ? "font-mono" : ""
        }`}
        style={{ color: "var(--ink)", minHeight: rows * 22 }}
      >
        {value || <span style={{ color: "var(--mute-2)" }}>Nothing here yet.</span>}
      </div>
    </section>
  );
}
