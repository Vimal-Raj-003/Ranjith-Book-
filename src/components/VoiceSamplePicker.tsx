"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VOICES, strings, type VoiceOption } from "@/lib/strings";
import { TOAST_MAX_MS, useToast } from "./Toast";

const SAMPLE_CACHE_VER = "studio-32-v1";
const SAMPLE_TIMEOUT_MS = 120_000;

interface PlayerSnapshot {
  playingId: string | null;
  loadingId: string | null;
  remainingSec: number | null;
}

let sharedAudio: HTMLAudioElement | null = null;
let activeAbort: AbortController | null = null;
const blobCache = new Map<string, string>();
const listeners = new Set<() => void>();

let snapshot: PlayerSnapshot = {
  playingId: null,
  loadingId: null,
  remainingSec: null,
};

function emit(next: Partial<PlayerSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const fn of listeners) fn();
}

export function stopSharedVoiceSample() {
  activeAbort?.abort();
  activeAbort = null;
  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
  }
  if (snapshot.playingId || snapshot.loadingId || snapshot.remainingSec !== null) {
    emit({ playingId: null, loadingId: null, remainingSec: null });
  }
}

async function toggleSharedVoiceSample(
  voiceId: string,
  onError: (msg: string) => void,
): Promise<void> {
  if (snapshot.playingId === voiceId || snapshot.loadingId === voiceId) {
    stopSharedVoiceSample();
    return;
  }

  stopSharedVoiceSample();
  const abort = new AbortController();
  activeAbort = abort;
  emit({ loadingId: voiceId, playingId: null, remainingSec: null });

  const timeout = setTimeout(() => abort.abort("timeout"), SAMPLE_TIMEOUT_MS);
  try {
    const cacheKey = `${SAMPLE_CACHE_VER}:${voiceId}`;
    let url = blobCache.get(cacheKey);
    if (!url) {
      const res = await fetch("/api/voice/preview?v=studio32", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceId }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = typeof body?.error === "string" ? body.error : strings.voicePanel.previewFailed;
        if (activeAbort === abort) emit({ loadingId: null, playingId: null, remainingSec: null });
        onError(message);
        return;
      }
      const blob = await res.blob();
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob);
      blobCache.set(cacheKey, url);
    }

    if (abort.signal.aborted) return;
    if (!sharedAudio) {
      sharedAudio = new Audio();
      sharedAudio.addEventListener("ended", () => {
        emit({ playingId: null, loadingId: null, remainingSec: null });
      });
      sharedAudio.addEventListener("timeupdate", () => {
        if (!sharedAudio || sharedAudio.paused || !Number.isFinite(sharedAudio.duration)) return;
        const left = Math.max(1, Math.ceil(sharedAudio.duration - sharedAudio.currentTime));
        if (snapshot.remainingSec !== left) emit({ remainingSec: left });
      });
      sharedAudio.addEventListener("loadedmetadata", () => {
        if (!sharedAudio || !Number.isFinite(sharedAudio.duration)) return;
        emit({ remainingSec: Math.max(1, Math.round(sharedAudio.duration)) });
      });
    }

    sharedAudio.pause();
    sharedAudio.src = url;
    sharedAudio.currentTime = 0;
    emit({ loadingId: null, playingId: voiceId, remainingSec: 15 });
    await sharedAudio.play();
  } catch (err) {
    if (abort.signal.aborted && abort.signal.reason !== "timeout") return;
    const timedOut = abort.signal.reason === "timeout" || (err instanceof DOMException && err.name === "TimeoutError");
    if (activeAbort === abort) emit({ loadingId: null, playingId: null, remainingSec: null });
    onError(timedOut ? strings.voicePanel.previewTimedOut : strings.voicePanel.previewFailed);
  } finally {
    clearTimeout(timeout);
  }
}

export function useVoiceSampleState(): PlayerSnapshot {
  const [state, setState] = useState<PlayerSnapshot>(snapshot);
  useEffect(() => {
    const sync = () => setState(snapshot);
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return state;
}

/**
 * Compact 15s play/stop sample pill placed directly beside a voice name.
 * Stops event propagation so clicking it inside a dropdown auditions the voice
 * without closing the menu or altering the chosen voice.
 */
export function VoiceSampleButton({
  voice,
  compact = false,
}: {
  voice: Pick<VoiceOption, "id" | "label">;
  compact?: boolean;
}) {
  const toast = useToast();
  const state = useVoiceSampleState();
  const isPlaying = state.playingId === voice.id;
  const isLoading = state.loadingId === voice.id;
  const active = isPlaying || isLoading;

  return (
    <button
      type="button"
      aria-label={isPlaying ? strings.voicePanel.stopSample(voice.label) : strings.voicePanel.playSample(voice.label)}
      aria-pressed={isPlaying}
      aria-busy={isLoading}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggleSharedVoiceSample(voice.id, (msg) => toast.show(msg, "error", TOAST_MAX_MS));
      }}
      className={`shrink-0 rounded-md border font-mono font-semibold tabular-nums transition-colors ${
        compact ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11px]"
      }`}
      style={{
        borderColor: active ? "var(--cyan)" : "var(--line)",
        background: isPlaying ? "var(--cyan)" : "var(--slab-2)",
        color: isPlaying ? "var(--on-accent)" : active ? "var(--cyan)" : "var(--ink)",
        cursor: isLoading ? "progress" : "pointer",
      }}
    >
      {isLoading
        ? strings.voicePanel.sampleLoadingLabel
        : isPlaying
          ? strings.voicePanel.sampleStopLabel(state.remainingSec)
          : strings.voicePanel.samplePlayLabel}
    </button>
  );
}

/**
 * Full 12-voice audition list grouped by gender, with a 15-second sample button
 * right beside every voice name. Used inside the right-hand Settings -> Voice panel.
 */
export function VoiceAuditionList({
  selectedVoiceId,
  onSelectVoice,
}: {
  selectedVoiceId: string | undefined;
  onSelectVoice: (voiceId: string) => void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 border-t pt-2.5" style={{ borderColor: "var(--line-soft)" }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
          {strings.voicePanel.auditionHeading}
        </span>
      </div>
      <p className="text-[11.5px] leading-snug" style={{ color: "var(--mute)" }}>
        {strings.voicePanel.auditionHint}
      </p>
      {(["female", "male"] as const).map((gender) => (
        <div key={gender} className="flex flex-col gap-1">
          <span className="mt-0.5 font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.voicePanel.genderLabel[gender]}
          </span>
          <ul role="list" className="flex flex-col gap-1">
            {VOICES.filter((v) => v.gender === gender).map((v) => {
              const selected = selectedVoiceId === v.id;
              return (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1"
                  style={{
                    borderColor: selected ? "var(--cyan)" : "var(--line)",
                    background: selected ? "var(--slab-2)" : "var(--field)",
                  }}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectVoice(v.id)}
                    className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-[12px]"
                  >
                    <span
                      aria-hidden
                      className="font-mono text-[10px]"
                      style={{ color: selected ? "var(--cyan)" : "var(--mute-2)" }}
                    >
                      {selected ? "●" : "○"}
                    </span>
                    <span className="font-semibold" style={{ color: "var(--ink)" }}>
                      {v.label}
                    </span>
                    <span className="truncate text-[11px]" style={{ color: "var(--mute)" }}>
                      — {v.note}
                    </span>
                  </button>
                  <VoiceSampleButton voice={v} compact />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export interface ExtraVoiceChoice {
  value: string;
  label: string;
}

/**
 * Custom accessible dropdown replacing plain `<select>` in BookAnalysis toolbar
 * and IdeaCard so every voice option has an inline `▶ 15s` sample play button
 * right next to its name (plus a quick play button beside the closed control
 * whenever a specific voice is selected).
 */
export function VoiceSampleDropdown({
  value,
  onChange,
  extraOptions,
  ariaLabel,
  disabled = false,
  genderOrder = ["male", "female"],
}: {
  value: string;
  onChange: (nextValue: string) => void;
  extraOptions: ExtraVoiceChoice[];
  ariaLabel: string;
  disabled?: boolean;
  genderOrder?: readonly ("male" | "female")[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; maxHeight: number }>({
    top: 0,
    left: 0,
    width: 320,
    maxHeight: 380,
  });

  const selectedVoice = VOICES.find((v) => v.id === value);
  const selectedExtra = extraOptions.find((o) => o.value === value);
  const displayLabel = selectedVoice
    ? `${selectedVoice.label} — ${selectedVoice.note}`
    : selectedExtra?.label ?? extraOptions[0]?.label ?? value;

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    const menuWidth = Math.max(310, Math.min(370, window.innerWidth - 24));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    const spaceBelow = window.innerHeight - rect.bottom - 14;
    const spaceAbove = rect.top - 14;
    const desiredHeight = 400;

    if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
      setCoords({
        top: rect.bottom + 6,
        left,
        width: menuWidth,
        maxHeight: Math.max(200, Math.min(desiredHeight, spaceBelow)),
      });
    } else {
      const maxH = Math.max(200, Math.min(desiredHeight, spaceAbove));
      setCoords({
        top: Math.max(12, rect.top - maxH - 6),
        left,
        width: menuWidth,
        maxHeight: maxH,
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const onScrollOrResize = () => updatePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(nextVal: string) {
    onChange(nextVal);
    setOpen(false);
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        className="inline-flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-[12px] font-mono disabled:opacity-50"
        style={{
          background: "var(--field)",
          borderColor: open ? "var(--cyan)" : "var(--line)",
          color: "var(--ink)",
        }}
      >
        <span className="truncate">{displayLabel}</span>
        <span aria-hidden className="text-[10px]" style={{ color: "var(--mute)" }}>
          ▾
        </span>
      </button>

      {selectedVoice && !disabled && <VoiceSampleButton voice={selectedVoice} compact />}

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="fixed z-[110] flex flex-col gap-1.5 overflow-y-auto rounded-xl border p-2 shadow-2xl"
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              maxHeight: `${coords.maxHeight}px`,
              background: "var(--slab)",
              borderColor: "var(--line)",
              color: "var(--ink)",
            }}
          >
            <div
              className="border-b px-2 pb-1.5 font-mono text-[10.5px]"
              style={{ borderColor: "var(--line-soft)", color: "var(--mute)" }}
            >
              {strings.voicePanel.auditionHint}
            </div>

            {extraOptions.map((opt) => {
              const selected = value === opt.value;
              return (
                <button
                  key={`extra:${opt.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(opt.value)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-[12px]"
                  style={{
                    background: selected ? "var(--slab-2)" : "transparent",
                    color: selected ? "var(--cyan)" : "var(--ink)",
                  }}
                >
                  <span aria-hidden className="text-[10px]">
                    {selected ? "●" : "○"}
                  </span>
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })}

            {genderOrder.map((gender) => (
              <div key={gender} className="mt-1 flex flex-col gap-1">
                <div
                  className="px-2 font-mono text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--mute-2)" }}
                >
                  {strings.voicePanel.genderLabel[gender]}
                </div>
                {VOICES.filter((v) => v.gender === gender).map((v) => {
                  const selected = value === v.id;
                  return (
                    <div
                      key={v.id}
                      className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1"
                      style={{
                        borderColor: selected ? "var(--cyan)" : "var(--line-soft)",
                        background: selected ? "var(--slab-2)" : "var(--field)",
                      }}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => pick(v.id)}
                        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-[12px]"
                      >
                        <span
                          aria-hidden
                          className="font-mono text-[10px]"
                          style={{ color: selected ? "var(--cyan)" : "var(--mute-2)" }}
                        >
                          {selected ? "●" : "○"}
                        </span>
                        <span className="font-semibold" style={{ color: "var(--ink)" }}>
                          {v.label}
                        </span>
                        <span className="truncate text-[11px]" style={{ color: "var(--mute)" }}>
                          — {v.note}
                        </span>
                      </button>
                      <VoiceSampleButton voice={v} compact />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
