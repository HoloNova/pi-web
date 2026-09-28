"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMemoryStatus } from "@/hooks/useMemoryStatus";
import { putMemoryTarget } from "@/lib/memory-status-store";
import type { MemoryStatusActiveResponse } from "@/lib/api-types";

const STATE_LABEL_KEYS: Record<MemoryStatusActiveResponse["state"], string> = {
  ok: "settings.memoryTargetStateOk",
  near: "settings.memoryTargetStateNear",
  over: "settings.memoryTargetStateOver",
};

/**
 * Service-wide memory target, edited in General settings. It is a soft target
 * for Pi-Web's own footprint: it drives Lite mode's idle-session reclaim and is
 * never a hard limit — the service's systemd MemoryHigh/MemoryMax guardrails
 * stay the real limit. It is rendered only while Lite mode is on, and it reads
 * and writes through the shared status store, so its numbers match the chat
 * card and a save is broadcast to it immediately.
 */
export function MemoryTargetControl() {
  const { t } = useI18n();
  const { status, error } = useMemoryStatus({ enabled: true, poll: true });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const active = status && status.active ? status : null;
  const targetMiB = active?.targetMiB;
  useEffect(() => {
    if (targetMiB !== undefined) setDraft(String(targetMiB));
  }, [targetMiB]);

  const invalidRange = active
    ? t("settings.memoryTargetInvalid", { min: String(active.minMiB), max: String(active.maxMiB) })
    : "";

  const save = async () => {
    if (!active) return;
    const next = Number(draft);
    setSaveError(null);
    setSaved(false);
    if (!Number.isInteger(next) || next < active.minMiB || next > active.maxMiB) {
      setSaveError(invalidRange);
      return;
    }
    setSaving(true);
    try {
      await putMemoryTarget(next);
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const state = active?.state ?? "ok";
  const usageText = active
    ? t("settings.memoryTargetUsage", { used: String(active.usedMiB), target: String(active.targetMiB) })
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
          min={active?.minMiB ?? 1}
          max={active?.maxMiB ?? 1}
          step={1}
          value={draft}
          disabled={!active || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className="config-button config-button-small config-button-secondary"
          disabled={!active || saving || draft === String(active.targetMiB)}
          onClick={() => void save()}
        >
          {saving ? t("settings.memoryTargetSaving") : t("settings.memoryTargetSave")}
        </button>
      </div>
      <p className="settings-memory-readout" data-state={state}>
        <span className="settings-memory-state" data-state={state}>
          {active ? t(STATE_LABEL_KEYS[state]) : t("settings.memoryTargetLoading")}
        </span>
        <span>{usageText}</span>
      </p>
      {active?.approximate && (
        <p className="settings-general-description">{t("settings.memoryTargetFallback")}</p>
      )}
      <p className="settings-general-description">{t("settings.memoryTargetLiteHint")}</p>
      {saveError && <p role="alert" className="settings-general-error">{saveError}</p>}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {saved && <p role="status" className="settings-memory-saved">{t("settings.memoryTargetSaved")}</p>}
    </div>
  );
}
