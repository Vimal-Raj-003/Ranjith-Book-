"use client";

import { useEffect, useId, useState } from "react";
import {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  GENERATION_ENGINES,
  strings,
  type GeminiModelId,
  type GenerationEngineId,
} from "@/lib/strings";

export interface EngineStatusItem {
  installed: boolean;
  signedIn: boolean;
  version: string | null;
  detail: string;
  authMethod?: "cli" | "api-key" | "none";
}

export interface EngineSnapshot {
  chosen: boolean;
  provider: GenerationEngineId;
  defaultProvider: GenerationEngineId;
  geminiModel?: GeminiModelId | string;
  status: Record<GenerationEngineId, EngineStatusItem>;
  hasGeminiKey?: boolean;
  hasCodexKey?: boolean;
}

export function EngineIcon({ engine }: { engine: GenerationEngineId }) {
  if (engine === "claude-cli") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7" />
      </svg>
    );
  }
  if (engine === "codex-cli") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 3a4.5 4.5 0 0 1 4.3 3.2A4.5 4.5 0 0 1 20.5 10a4.5 4.5 0 0 1-1.7 3.6A4.5 4.5 0 0 1 16 19.5a4.5 4.5 0 0 1-4 2 4.5 4.5 0 0 1-4-2A4.5 4.5 0 0 1 5.2 13.6 4.5 4.5 0 0 1 3.5 10a4.5 4.5 0 0 1 4.2-3.8A4.5 4.5 0 0 1 12 3Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C12.6 7.2 16.8 11.4 22 12C16.8 12.6 12.6 16.8 12 22C11.4 16.8 7.2 12.6 2 12C7.2 11.4 11.4 7.2 12 2Z" />
    </svg>
  );
}

export default function EngineSelectorModal({
  open,
  snapshot,
  loading,
  onSelectEngine,
  onSaveApiKey,
  onRecheck,
  onSkip,
  onClose,
}: {
  open: boolean;
  snapshot: EngineSnapshot | null;
  loading?: boolean;
  onSelectEngine: (
    provider: GenerationEngineId,
    confirmUnconfigured?: boolean,
    geminiModel?: GeminiModelId,
  ) => Promise<EngineSnapshot | null>;
  onSaveApiKey: (provider: GenerationEngineId, apiKey: string) => Promise<EngineSnapshot | null>;
  onRecheck: () => Promise<void>;
  onSkip: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const keyInputId = useId();
  const [activeEngine, setActiveEngine] = useState<GenerationEngineId>(
    snapshot?.provider ?? "claude-cli",
  );
  const [selectedGeminiModel, setSelectedGeminiModel] = useState<GeminiModelId>(
    (snapshot?.geminiModel as GeminiModelId | undefined) ?? DEFAULT_GEMINI_MODEL_ID,
  );
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [needsSetupFor, setNeedsSetupFor] = useState<GenerationEngineId | null>(null);

  useEffect(() => {
    if (snapshot?.provider && !needsSetupFor) {
      setActiveEngine(snapshot.provider);
    }
  }, [snapshot?.provider, needsSetupFor]);

  useEffect(() => {
    if (snapshot?.geminiModel && GEMINI_MODELS.some((m) => m.id === snapshot.geminiModel)) {
      setSelectedGeminiModel(snapshot.geminiModel as GeminiModelId);
    }
  }, [snapshot?.geminiModel]);

  useEffect(() => {
    if (!open) {
      setErrorMsg(null);
      setApiKey("");
      setNeedsSetupFor(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onSkip]);

  if (!open) return null;

  const handleCardClick = async (engineId: GenerationEngineId) => {
    if (saving) return;
    const wasAlreadyGemini = activeEngine === "gemini" && engineId === "gemini";
    setActiveEngine(engineId);
    setErrorMsg(null);

    const knownStatus = snapshot?.status?.[engineId];
    if (engineId === "gemini") {
      if (knownStatus && !knownStatus.signedIn) {
        setNeedsSetupFor("gemini");
      }
      // On first click onto Gemini, keep the modal open so the user can pick their Gemini model button.
      if (!wasAlreadyGemini) {
        return;
      }
    }

    if (knownStatus && !knownStatus.signedIn) {
      setNeedsSetupFor(engineId);
      return;
    }

    setSaving(true);
    try {
      const updated = await onSelectEngine(
        engineId,
        false,
        engineId === "gemini" ? selectedGeminiModel : undefined,
      );
      const ready = updated?.status?.[engineId]?.signedIn ?? false;
      if (ready) {
        setNeedsSetupFor(null);
        onClose();
      } else {
        setNeedsSetupFor(engineId);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save generation engine.");
    } finally {
      setSaving(false);
    }
  };

  const handleSelectGeminiModel = async (modelId: GeminiModelId) => {
    if (saving) return;
    setSelectedGeminiModel(modelId);
    setActiveEngine("gemini");
    setErrorMsg(null);
    setSaving(true);
    try {
      const updated = await onSelectEngine("gemini", false, modelId);
      if (updated?.status?.gemini && !updated.status.gemini.signedIn) {
        setNeedsSetupFor("gemini");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save Gemini model.");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmUnconfigured = async (engineId: GenerationEngineId) => {
    if (saving) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      await onSelectEngine(
        engineId,
        true,
        engineId === "gemini" ? selectedGeminiModel : undefined,
      );
      setNeedsSetupFor(null);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save generation engine.");
    } finally {
      setSaving(false);
    }
  };

  const handleConnectKey = async () => {
    const target = needsSetupFor ?? activeEngine;
    if (saving || !apiKey.trim()) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const updated = await onSaveApiKey(target, apiKey.trim());
      setApiKey("");
      const st = updated?.status?.[target];
      if (st?.signedIn) {
        setNeedsSetupFor(null);
        onClose();
      } else if (st?.detail) {
        setErrorMsg(st.detail);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save API key.");
    } finally {
      setSaving(false);
    }
  };

  const setupTarget = needsSetupFor ?? (snapshot?.status && !snapshot.status[activeEngine]?.signedIn ? activeEngine : null);
  const setupEngineMeta = GENERATION_ENGINES.find((e) => e.id === setupTarget) ?? null;
  const setupStatus = setupTarget ? snapshot?.status?.[setupTarget] : null;
  const supportsApiKeyInput = setupTarget === "gemini" || setupTarget === "codex-cli";
  const selectedGeminiMeta = GEMINI_MODELS.find((m) => m.id === selectedGeminiModel) ?? GEMINI_MODELS[0];

  return (
    <div
      className="engine-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSkip();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="engine-modal-card"
      >
        <div className="engine-modal-title-row">
          <span className="engine-modal-bolt" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
            </svg>
          </span>
          <h2 id={titleId} className="engine-modal-title">
            {strings.engineModal.title}
          </h2>
        </div>

        <p className="engine-modal-subtitle">{strings.engineModal.subtitle}</p>

        <div className="engine-grid" role="group" aria-labelledby={titleId}>
          {GENERATION_ENGINES.map((engine) => {
            const st = snapshot?.status?.[engine.id];
            const isSelected = activeEngine === engine.id;
            const isReady = st?.signedIn ?? false;
            return (
              <button
                key={engine.id}
                type="button"
                className="engine-card"
                data-engine-option={engine.id}
                aria-pressed={isSelected}
                aria-disabled={saving}
                onClick={() => void handleCardClick(engine.id)}
              >
                <span className="engine-badge" data-engine={engine.id}>
                  <EngineIcon engine={engine.id} />
                </span>
                <span className="engine-card-name">{engine.label}</span>
                <span className="engine-card-desc">{engine.description}</span>
                <span
                  className="engine-status-pill"
                  data-ready={st ? String(isReady) : undefined}
                >
                  {!st
                    ? loading
                      ? strings.engineModal.checkingBadge
                      : engine.label
                    : isReady
                      ? strings.engineModal.connectedBadge
                      : strings.engineModal.needsSetupBadge}
                </span>
              </button>
            );
          })}
        </div>

        {activeEngine === "gemini" && (
          <div className="gemini-model-box" role="region" aria-label={strings.engineModal.geminiModelHeading}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold text-[var(--ink)]">
                  {strings.engineModal.geminiModelHeading}
                </div>
                <p className="hint mt-0.5">{strings.engineModal.geminiModelHint}</p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                aria-disabled={saving}
                onClick={() => void handleConfirmUnconfigured("gemini")}
              >
                {strings.engineModal.useEngine(selectedGeminiMeta.label)}
              </button>
            </div>

            <div className="gemini-model-grid" role="group" aria-label={strings.engineModal.geminiModelHeading}>
              {GEMINI_MODELS.map((m) => {
                const isModelSelected = selectedGeminiModel === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="gemini-model-btn"
                    data-gemini-model={m.id}
                    aria-pressed={isModelSelected}
                    aria-disabled={saving}
                    onClick={() => void handleSelectGeminiModel(m.id)}
                  >
                    <span className="gemini-model-name">
                      <span>{m.label}</span>
                      <span className="mono text-[10.5px] text-[var(--mute-2)]">{m.tag}</span>
                    </span>
                    <span className="gemini-model-note">{m.note}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {setupTarget && setupEngineMeta && (
          <div className="engine-setup-box" role="region" aria-label={`${setupEngineMeta.label} setup`}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[13px] font-semibold text-[var(--ink)]">
                {setupEngineMeta.label} · {setupStatus?.signedIn ? strings.engineModal.connectedBadge : strings.engineModal.needsSetupBadge}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-disabled={saving}
                  onClick={() => {
                    if (!saving) void onRecheck();
                  }}
                >
                  {strings.engineModal.recheck}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-disabled={saving}
                  onClick={() => void handleConfirmUnconfigured(setupTarget)}
                >
                  {strings.engineModal.useEngine(setupEngineMeta.label)}
                </button>
              </div>
            </div>

            {setupStatus?.detail && (
              <p className="hint mb-2 text-[var(--amber)]">{setupStatus.detail}</p>
            )}
            <p className="hint mb-2.5">{strings.engineModal.setupHelp[setupTarget]}</p>

            {supportsApiKeyInput && (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={keyInputId} className="sr-only">
                  {strings.engineModal.apiKeyLabel(setupEngineMeta.label)}
                </label>
                <input
                  id={keyInputId}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={strings.engineModal.apiKeyPlaceholder[setupTarget]}
                  className="field flex-1 min-w-[220px]"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  aria-disabled={saving || !apiKey.trim()}
                  onClick={() => void handleConnectKey()}
                >
                  {saving ? strings.engineModal.saving : strings.engineModal.saveAndConnect(setupEngineMeta.label)}
                </button>
              </div>
            )}
          </div>
        )}

        {errorMsg && (
          <p className="hint mt-3 text-[var(--rose)]" role="alert">
            {errorMsg}
          </p>
        )}

        <div className="engine-modal-footer">
          <span className="mono text-[12px] text-[var(--mute)]">
            {strings.engineModal.defaultHint}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-disabled={saving}
            onClick={onSkip}
          >
            {strings.engineModal.skipForNow}
          </button>
        </div>
      </div>
    </div>
  );
}
