"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_TIMEZONE, isValidDate, isValidTime, todayIn, zoneLabel } from "@/lib/schedule/reference-time";

const button = "rounded-lg border border-[var(--line)] text-[var(--ink)] transition-colors hover:border-[var(--violet)] hover:bg-[var(--slab-2)] focus-visible:outline-[var(--violet)] disabled:cursor-not-allowed disabled:opacity-35";
const accent = { background: "var(--violet)", borderColor: "var(--violet)", color: "var(--on-accent)" };
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (value: number) => String(value).padStart(2, "0");
const readDay = (value: string) => isValidDate(value) ? new Date(`${value}T12:00:00.000Z`) : null;
const dayValue = (date: Date) => `${String(date.getUTCFullYear()).padStart(4, "0")}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
const dayAt = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day, 12));
const dateText = (value: string, long = false) => {
  const date = readDay(value);
  return date ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: long ? "long" : "short", year: "numeric", ...(long ? { weekday: "long" as const } : {}) }).format(date) : "Choose date";
};

interface PickerProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  timezone?: string;
  disabled?: boolean;
  className?: string;
  min?: string;
  max?: string;
}

function PickerIcon({ clock = false }: { clock?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--violet)]">
    {clock ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>}
  </svg>;
}

/** A styled dialog in the browser's top layer: no ancestor can clip it. */
function PickerPopover({ label, display, value, disabled, className = "", clock, onOpen, children }: {
  label: string; display: string; value: string; disabled?: boolean; className?: string; clock?: boolean;
  onOpen: () => void; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The layout-effect cleanup closes the dialog and restores focus to its trigger.
  const close = useCallback(() => { setOpen(false); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = dialog.current!;
    panel.showModal();
    const position = () => {
      if (!trigger.current) return;
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const anchor = trigger.current.getBoundingClientRect();
      panel.style.width = `${Math.max(0, Math.min(304, width - 24))}px`;
      panel.style.maxHeight = `${Math.max(0, height - 24)}px`;
      const size = panel.getBoundingClientRect();
      const below = anchor.bottom + 8;
      const above = anchor.top - size.height - 8;
      const top = below + size.height <= y + height - 12 ? below : above >= y + 12 ? above : y + 12;
      panel.style.left = `${Math.max(x + 12, Math.min(anchor.left, x + width - size.width - 12))}px`;
      panel.style.top = `${top}px`;
    };
    position();
    const frame = requestAnimationFrame(() => panel.querySelector<HTMLElement>("[data-picker-focus]")?.focus());
    const resize = new ResizeObserver(position);
    resize.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      if (panel.open) panel.close();
    };
  }, [open]);

  return <>
    <button type="button" ref={trigger} disabled={disabled} aria-label={label} aria-describedby={`${id}-value`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      data-picker-value={value} title={display}
      onClick={() => { onOpen(); setOpen(true); }}
      className={`${button} flex min-h-9 items-center justify-between gap-2 bg-[var(--field)] px-2.5 py-1.5 text-left font-mono text-[12px] tabular-nums ${className}`}>
      <span className="truncate">{display}</span><PickerIcon clock={clock} />
    </button>
    <span id={`${id}-value`} className="sr-only">{value ? `Selected ${clock ? "time" : "date"}: ${display}.` : display}</span>
    {open && createPortal(<dialog ref={dialog} id={id} aria-label={label} aria-modal="true"
      onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      className="fixed m-0 overflow-y-auto rounded-2xl border p-4 text-[var(--ink)] shadow-2xl outline-none backdrop:bg-transparent"
      style={{ left: 0, top: 0, right: "auto", bottom: "auto", maxWidth: "calc(100vw - 24px)", background: "var(--slab)", borderColor: "color-mix(in srgb, var(--violet) 35%, var(--line))", boxShadow: "0 18px 64px #0006, 0 0 0 1px color-mix(in srgb, var(--violet) 8%, transparent)" }}>
      {children(close)}
    </dialog>, document.body)}
  </>;
}

export function ScheduleDatePicker({ value, onChange, label, timezone = DEFAULT_TIMEZONE, min = "", max = "", ...props }: PickerProps) {
  const today = todayIn(timezone);
  const initial = readDay(value) ?? readDay(today)!;
  const [view, setView] = useState(initial);
  const [focused, setFocused] = useState(dayValue(initial));
  const [choosingMonth, setChoosingMonth] = useState(false);
  const [yearText, setYearText] = useState(String(initial.getUTCFullYear()));
  const calendar = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const lower = isValidDate(min) ? min : "";
  const upper = isValidDate(max) ? max : "";
  const allowed = (date: string) => isValidDate(date) && (!lower || date >= lower) && (!upper || date <= upper);
  const clamp = (date: string) => lower && date < lower ? lower : upper && date > upper ? upper : date;
  const year = view.getUTCFullYear();
  const month = view.getUTCMonth();
  const monthAllowed = (y: number, m: number) => y >= 100 && y <= 9999 && (!upper || dayValue(dayAt(y, m, 1)) <= upper) && (!lower || dayValue(dayAt(y, m + 1, 0)) >= lower);
  const changeView = (date: Date, focus = false) => {
    const target = dayValue(date);
    if (!allowed(target)) return;
    setView(date); setFocused(target); setYearText(String(date.getUTCFullYear()));
    if (focus) requestAnimationFrame(() => calendar.current?.querySelector<HTMLButtonElement>(`[data-date="${target}"]`)?.focus());
  };
  const moveMonth = (delta: number, focus = false, from = view) => {
    const start = dayAt(from.getUTCFullYear(), from.getUTCMonth() + delta, 1);
    if (!monthAllowed(start.getUTCFullYear(), start.getUTCMonth())) return;
    const day = Math.min(from.getUTCDate(), dayAt(start.getUTCFullYear(), start.getUTCMonth() + 1, 0).getUTCDate());
    changeView(readDay(clamp(dayValue(dayAt(start.getUTCFullYear(), start.getUTCMonth(), day))))!, focus);
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -((date.getUTCDay() + 6) % 7), End: 6 - ((date.getUTCDay() + 6) % 7) };
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault(); moveMonth((event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1), true, date);
    } else if (event.key in deltas) {
      event.preventDefault();
      const next = dayAt(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + deltas[event.key]);
      const target = readDay(clamp(dayValue(next)));
      if (target) changeView(target, true);
    }
  };
  const first = dayAt(year, month, 1);
  const gridStart = 1 - ((first.getUTCDay() + 6) % 7);
  const previous = dayAt(year, month - 1, 1);
  const next = dayAt(year, month + 1, 1);

  return <PickerPopover {...props} label={label} value={value} display={dateText(value)} onOpen={() => {
    const date = readDay(clamp(isValidDate(value) ? value : today))!;
    setView(date); setFocused(dayValue(date)); setYearText(String(date.getUTCFullYear())); setChoosingMonth(false);
  }}>{close => {
    const select = (date: string) => { if (allowed(date)) { onChange(date); close(); } };
    return <div ref={calendar}>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-[var(--mute)]">Select date · {zoneLabel(timezone)}</p>
      <div className="mb-3 flex items-center justify-between gap-1">
        <button type="button" aria-label="Previous month" disabled={!monthAllowed(previous.getUTCFullYear(), previous.getUTCMonth())} onClick={() => moveMonth(-1)} className={`${button} h-9 w-9 text-lg`}>‹</button>
        <button type="button" aria-label={`Choose month and year, ${months[month]} ${year}`} aria-expanded={choosingMonth} onClick={() => setChoosingMonth(!choosingMonth)} className={`${button} min-h-9 flex-1 border-transparent px-2 font-display text-[15px] font-semibold`}>
          <span id={headingId} aria-live="polite">{months[month]} {year}</span> <span aria-hidden="true" className="text-[var(--violet)]">⌄</span>
        </button>
        <button type="button" aria-label="Next month" disabled={!monthAllowed(next.getUTCFullYear(), next.getUTCMonth())} onClick={() => moveMonth(1)} className={`${button} h-9 w-9 text-lg`}>›</button>
      </div>
      {choosingMonth ? <div>
        <div className="mb-3 flex items-center gap-2">
          <button type="button" aria-label="Previous year" disabled={year <= 100 || !Array.from({ length: 12 }, (_, m) => monthAllowed(year - 1, m)).some(Boolean)} onClick={() => { setView(dayAt(year - 1, month, 1)); setYearText(String(year - 1)); }} className={`${button} h-9 w-9`}>−</button>
          <input aria-label="Calendar year" inputMode="numeric" value={yearText} maxLength={4} onChange={event => {
            const text = event.target.value; setYearText(text);
            if (/^\d{3,4}$/.test(text) && Number(text) >= 100 && Number(text) <= 9999) setView(dayAt(Number(text), month, 1));
          }} onBlur={() => setYearText(String(year))} className={`${button} min-w-0 flex-1 bg-[var(--field)] py-2 text-center font-mono text-sm tabular-nums`} />
          <button type="button" aria-label="Next year" disabled={year >= 9999 || !Array.from({ length: 12 }, (_, m) => monthAllowed(year + 1, m)).some(Boolean)} onClick={() => { setView(dayAt(year + 1, month, 1)); setYearText(String(year + 1)); }} className={`${button} h-9 w-9`}>+</button>
        </div>
        <div className="grid grid-cols-3 gap-2" aria-label="Choose month">
          {months.map((name, m) => <button key={name} type="button" disabled={!monthAllowed(year, m)} aria-pressed={m === month} onClick={() => {
            changeView(readDay(clamp(dayValue(dayAt(year, m, 1))))!, true); setChoosingMonth(false);
          }} className={`${button} py-2 font-mono text-[12px]`} style={m === month ? accent : undefined}>{name.slice(0, 3)}</button>)}
        </div>
      </div> : <div role="grid" aria-labelledby={headingId}>
        <div role="row" className="mb-1 grid grid-cols-7">
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(day => <span key={day} role="columnheader" className="py-1 text-center font-mono text-[10px] text-[var(--mute)]">{day}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => <div key={week} role="row" className="grid grid-cols-7 gap-0.5">
          {Array.from({ length: 7 }, (_, weekday) => {
            const date = dayAt(year, month, gridStart + week * 7 + weekday);
            const iso = dayValue(date);
            const selected = iso === value;
            return <div key={iso} role="gridcell" aria-selected={selected}>
              <button type="button" data-date={iso} data-picker-focus={iso === focused ? "" : undefined} tabIndex={iso === focused ? 0 : -1}
                aria-label={dateText(iso, true)} aria-current={iso === today ? "date" : undefined} disabled={!allowed(iso)}
                onKeyDown={event => navigate(event, date)} onFocus={() => setFocused(iso)} onClick={() => select(iso)}
                className={`${button} relative h-9 w-full border-transparent font-mono text-[12px] tabular-nums`}
                style={selected ? accent : { color: date.getUTCMonth() === month ? "var(--ink)" : "var(--mute-2)" }}>
                {date.getUTCDate()}
                {iso === today && <span aria-hidden="true" className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full" style={{ background: selected ? "var(--on-accent)" : "var(--violet)" }} />}
              </button>
            </div>;
          })}
        </div>)}
      </div>}
      <div className="mt-3 flex items-center justify-between border-t border-[var(--line)] pt-3">
        <button type="button" className={`${button} px-3 py-1.5 font-mono text-[11px]`} onClick={() => { onChange(""); close(); }}>Clear</button>
        <button type="button" disabled={!allowed(today)} className={`${button} px-3 py-1.5 font-mono text-[11px] text-[var(--violet)]`} onClick={() => select(today)}>Today</button>
      </div>
    </div>;
  }}</PickerPopover>;
}

export function ScheduleTimePicker({ value, onChange, label, timezone = DEFAULT_TIMEZONE, min = "", max = "", ...props }: PickerProps) {
  const [hour, setHour] = useState("00");
  const [minute, setMinute] = useState("00");
  const candidate = `${two(Number(hour))}:${two(Number(minute))}`;
  const valid = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute) && isValidTime(candidate) && (!isValidTime(min) || candidate >= min) && (!isValidTime(max) || candidate <= max);
  const errorId = useId();

  return <PickerPopover {...props} label={label} value={value} display={isValidTime(value) ? value : "Choose time"} clock onOpen={() => {
    const [h, m] = (isValidTime(value) ? value : "00:00").split(":"); setHour(h); setMinute(m);
  }}>{close => {
    const apply = () => { if (valid) { onChange(candidate); close(); } };
    return <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="font-display text-[15px] font-semibold">Select time</span>
        <span className="rounded-md bg-[var(--slab-2)] px-2 py-1 font-mono text-[10px] text-[var(--violet)]">24-hour · {zoneLabel(timezone)}</span>
      </div>
      <div className="flex items-start gap-3">
        {[{ name: "Hour", text: hour, set: setHour, limit: 24 }, { name: "Minute", text: minute, set: setMinute, limit: 60 }].map((part, index) => {
          const step = (delta: number) => part.set(two(((Number(part.text) || 0) + delta + part.limit) % part.limit));
          return <div key={part.name} className="min-w-0 flex-1">
            <label className="mb-1.5 block font-mono text-[10px] text-[var(--mute)]" htmlFor={`${errorId}-${part.name}`}>{part.name} · 00–{part.limit - 1}</label>
            <input id={`${errorId}-${part.name}`} aria-label={part.name} role="spinbutton" aria-valuemin={0} aria-valuemax={part.limit - 1}
              aria-valuenow={/^\d{1,2}$/.test(part.text) && Number(part.text) < part.limit ? Number(part.text) : undefined}
              data-picker-focus={index === 0 ? "" : undefined} inputMode="numeric" maxLength={2}
              value={part.text} onChange={event => part.set(event.target.value)} onFocus={event => event.target.select()}
              onBlur={() => { if (/^\d{1,2}$/.test(part.text) && Number(part.text) < part.limit) part.set(two(Number(part.text))); }}
              onKeyDown={event => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); step(event.key === "ArrowUp" ? 1 : -1); }
                if (event.key === "Enter") { event.preventDefault(); apply(); }
              }}
              aria-invalid={!/^\d{1,2}$/.test(part.text) || Number(part.text) >= part.limit} aria-describedby={!valid ? errorId : undefined}
              className={`${button} w-full bg-[var(--field)] py-3 text-center font-mono text-[32px] tabular-nums focus:border-[var(--violet)]`} />
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <button type="button" aria-label={`Decrease ${part.name.toLowerCase()}`} className={`${button} py-1 text-lg`} onClick={() => step(-1)}>−</button>
              <button type="button" aria-label={`Increase ${part.name.toLowerCase()}`} className={`${button} py-1 text-lg`} onClick={() => step(1)}>+</button>
            </div>
          </div>;
        })}
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <span className="mr-1 font-mono text-[10px] text-[var(--mute)]">Minutes</span>
        {[0, 15, 30, 45].map(m => <button key={m} type="button" aria-label={`Set minute to ${two(m)}`} aria-pressed={Number(minute) === m && minute !== ""}
          onClick={() => setMinute(two(m))} className={`${button} flex-1 py-1.5 font-mono text-[11px]`} style={Number(minute) === m && minute !== "" ? accent : undefined}>{two(m)}</button>)}
      </div>
      {!valid && <p id={errorId} role="status" className="mt-2 font-mono text-[11px] text-[var(--rose)]">Enter a valid 24-hour time{isValidTime(min) || isValidTime(max) ? ` between ${min || "00:00"} and ${max || "23:59"}` : " (00:00–23:59)"}.</p>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--line)] pt-3">
        <button type="button" className={`${button} px-3 py-2 font-mono text-[11px]`} onClick={() => { onChange(""); close(); }}>Clear</button>
        <button type="button" disabled={!valid} onClick={apply} className={`${button} px-3 py-2 font-mono text-[11px] font-semibold`} style={accent}>Use time{valid ? ` · ${candidate}` : ""}</button>
      </div>
    </div>;
  }}</PickerPopover>;
}
