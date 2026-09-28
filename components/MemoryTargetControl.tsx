"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLiteMode } from "@/hooks/useLiteMode";
import { useMemoryStatus } from "@/hooks/useMemoryStatus";
import type { MemoryStatusResponse, MemoryTargetResponse } from "@/lib/api-types";

const STATE_LABEL_KEYS: Record<MemoryStatusResponse["state"], string> = {
  ok: "settings.memoryTargetStateOk",
  near: "settings.memoryTargetStateNear",
  over: "settings.memoryTargetStateOver",
};

/**
 * Service-wide memory target, edited in General settings. It is a soft target
 * for Pi-Web's own footprint: it drives Lite mode's idle-session reclaim and is
 * never a hard limit — the service's systemd MemoryHigh/MemoryMax guardrails
 * stay the real limit. The control reads the target once when it mounts (Lite
 * mode's chat notice owns the polling), and refreshes after a save.
 */
export function MemoryTargetControl() {
  const { t } = useI18n();
  const [liteModeEnabled] = useLiteMode();
  const { status, error, refresh } = useMemoryStatus({ enabled: true, poll: false });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const targetMiB = status?.targetMiB;
  useEffect(() => {
    if (targetMiB !== undefined) setDraft(String(targetMiB));
  }, [targetMiB]);

  const invalidRange = status
    ? t("settings.memoryTargetInvalid", { min: String(status.minMiB), max: String(status.maxMiB) })
    : "";

  const save = async () => {
    if (!status) return;
    const next = Number(draft);
    setSaveError(null);
    setSaved(false);
    if (!Number.isInteger(next) || next < status.minMiB || next > status.maxMiB) {
      setSaveError(invalidRange);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMiB: next }),
      });
      const data = await response.json() as MemoryTargetResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSaved(true);
      await refresh();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const state = status?.state ?? "ok";
  const usageText = status
    ? t("settings.memoryTargetUsage", { used: String(status.usedMiB), target: String(status.targetMiB) })
    : t("settings.memoryTargetLoading");

  return (
    <div className="settings-memory-target">
      <p className="settings-general-description">{t("settings.memoryTargetDescription")}</p>
      <div className="settings-shell-option">
        <label htmlFor="settings-memory-target">{t("settings.memoryTarget")}</label>
        <input
          id="settings-memory-target"
          type="number"
          inputMode="numeric"
          min={status?.minMiB ?? 1}
          max={status?.maxMiB ?? 1}
          step={1}
          value={draft}
          disabled={!status || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className="config-button config-button-small config-button-secondary"
          disabled={!status || saving || draft === String(status.targetMiB)}
          onClick={() => void save()}
        >
          {saving ? t("settings.memoryTargetSaving") : t("settings.memoryTargetSave")}
        </button>
      </div>
      <p className="settings-memory-readout" data-state={state}>
        <span className="settings-memory-state" data-state={state}>
          {status ? t(STATE_LABEL_KEYS[state]) : t("settings.memoryTargetLoading")}
        </span>
        <span>{usageText}</span>
      </p>
      {status?.approximate && (
        <p className="settings-general-description">{t("settings.memoryTargetFallback")}</p>
      )}
      {liteModeEnabled && (
        <p className="settings-general-description">{t("settings.memoryTargetLiteHint")}</p>
      )}
      {saveError && <p role="alert" className="settings-general-error">{saveError}</p>}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {saved && <p role="status" className="settings-memory-saved">{t("settings.memoryTargetSaved")}</p>}
    </div>
  );
}
