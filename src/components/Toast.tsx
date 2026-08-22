"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Transient notices, and nothing else.
 *
 * Every popup in this app now goes through here, and every one of them leaves
 * on its own inside two and a half seconds. That number is the point: a notice
 * that outstays it stops being read and starts being an obstacle over the
 * thing the reader was looking at. Anything that genuinely needs to persist —
 * a failed run, a blocked field — belongs inline next to what it is about, not
 * in a popup.
 */

export type ToastTone = "ok" | "warn" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

/** The ceiling, applied to every toast regardless of what the caller asks for. */
export const TOAST_MAX_MS = 3000;
export const TOAST_DEFAULT_MS = 2500;

interface ToastApi {
  show: (message: string, tone?: ToastTone, ms?: number) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

const TONE_COLOR: Record<ToastTone, string> = {
  ok: "var(--cyan)",
  warn: "var(--amber)",
  error: "var(--rose)",
};

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const show = useCallback((message: string, tone: ToastTone = "ok", ms = TOAST_DEFAULT_MS) => {
    const id = next.current++;
    // Clamped rather than trusted: a caller passing 30_000 is a bug, and the
    // reader is the one who would pay for it.
    const life = Math.min(Math.max(1200, ms), TOAST_MAX_MS);
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    timers.current.push(
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), life),
    );
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-5 z-[70] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="toast-in max-w-[min(92vw,520px)] rounded-xl border px-4 py-2.5 text-[13px] leading-snug shadow-lg"
            style={{
              borderColor: `color-mix(in srgb, ${TONE_COLOR[t.tone]} 42%, transparent)`,
              background: "var(--slab)",
              color: "var(--ink)",
            }}
          >
            <span className="mr-2 font-mono text-[11px] uppercase tracking-wider" style={{ color: TONE_COLOR[t.tone] }}>
              {t.tone === "ok" ? "done" : t.tone === "warn" ? "note" : "problem"}
            </span>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
