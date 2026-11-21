"use client";

import type { UploadProgressReading } from "@/lib/schedule/upload-progress";

export interface UploadProgressBarProps {
  platform: string;
  reading: UploadProgressReading;
  /** Whether to render the current upload stage caption below the bar. */
  showStage?: boolean;
}

/**
 * Animated dark-theme horizontal upload progress bar for a single platform lane
 * (YouTube or Instagram). Displays exact upload percentage beside the bar when
 * backed by real upload progress, or an indeterminate loading bar with stage text
 * when exact percentage is unavailable.
 */
export default function UploadProgressBar({
  platform,
  reading,
  showStage = false,
}: UploadProgressBarProps) {
  const { mode, percent, stage } = reading;
  const isIndeterminate = mode === "indeterminate";
  const isActive = mode === "determinate" || mode === "indeterminate";
  const isComplete = mode === "complete";
  const isIdle = mode === "idle";
  const isHalted = mode === "halted";
  const widthPct = percent !== null ? Math.max(0, Math.min(100, percent)) : 0;

  return (
    <div
      className="br-upload-progress font-mono"
      data-upload-progress={platform.toLowerCase()}
      data-upload-mode={mode}
    >
      <div className="br-upload-row">
        <div
          className="br-upload-track"
          data-mode={mode}
          role="progressbar"
          aria-label={`${platform} upload progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={isIndeterminate || percent === null ? undefined : widthPct}
          aria-valuetext={
            percent !== null
              ? stage
                ? `${widthPct}% — ${stage}`
                : `${widthPct}%`
              : stage ?? undefined
          }
        >
          {isIndeterminate ? (
            <div className="br-upload-indeterminate" />
          ) : (
            <div
              className="br-upload-fill"
              data-active={isActive ? "true" : undefined}
              data-complete={isComplete ? "true" : undefined}
              data-halted={isHalted ? "true" : undefined}
              style={{ width: `${widthPct}%` }}
            />
          )}
        </div>
        {percent !== null && (
          <span
            className="br-upload-pct"
            data-upload-percent
            data-complete={isComplete ? "true" : undefined}
            data-idle={isIdle ? "true" : undefined}
            data-halted={isHalted ? "true" : undefined}
          >
            {widthPct}%
          </span>
        )}
      </div>
      {showStage && stage && (
        <div
          className="br-upload-stage"
          data-upload-stage
          data-active={isActive ? "true" : undefined}
          title={stage}
        >
          {stage}
        </div>
      )}
    </div>
  );
}
