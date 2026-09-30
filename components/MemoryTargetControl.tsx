"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLiteConfig } from "@/hooks/useLiteConfig";
import { useMemoryStatus } from "@/hooks/useMemoryStatus";
import type { MemoryStatusActiveResponse } from "@/lib/api-types";

const STATE_LABEL_KEYS: Record<MemoryStatusActiveResponse["state"], string> = {
  ok: "settings.memoryTargetStateOk",
  near: "settings.memoryTargetStateNear",
  over: "settings.memoryTargetStateOver",
};

/**
 * Service-wide memory target, edited in General settings while Lite mode is on.
 * It is a soft target for Pi-Web's own footprint: reaching it makes Lite mode
 * reclaim idle sessions, and it is never a hard limit — the service's systemd
 * MemoryHigh/MemoryMax guardrails stay the real limit. The number itself is part
 * of the instance's Lite configuration, so it is stored and broadcast through
 * the same store as the rest of the mode, while the reading comes from the
 * shared memory-status snapshot the chat card also uses.
 */
export function MemoryTargetControl() {
  const { t } = useI18n();
  const { snapshot: lite, save } = useLiteConfig();
  const { status, error, refresh, reclaim } = useMemoryStatus({ enabled: true, poll: true });
  const [draft, setDraft] = useState(() => String(lite.config.memoryTargetMiB));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimMessage, setReclaimMessage] = useState<string | null>(null);

  const bounds = lite.bounds.memoryTargetMiB;
  const stored = lite.config.memoryTargetMiB;
  const active = status && status.active ? status : null;
  const state = active?.state ?? "ok";

  useEffect(() => {
    setDraft(String(stored));
  }, [stored]);

  const invalidRange = t("settings.memoryTargetInvalid", {
    min: String(bounds.min),
    max: String(bounds.max),
  });

  const saveTarget = async () => {
    const next = Number(draft);
    setSaveError(null);
    setSaved(false);
    if (!Number.isInteger(next) || next < bounds.min || next > bounds.max) {
      setSaveError(invalidRange);
      return;
    }
    setSaving(true);
    try {
      const ok = await save({ memoryTargetMiB: next });
      if (!ok) throw new Error(t("settings.memoryTargetSaveFailed"));
      setSaved(true);
      await refresh();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reclaimNow = async () => {
    setReclaiming(true);
    setReclaimMessage(null);
    try {
      const result = await reclaim();
      setReclaimMessage(
        result.reclaimed.length > 0
          ? t("settings.memoryReclaimClosed", { count: String(result.reclaimed.length) })
          : t("settings.memoryReclaimNone"),
      );
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReclaiming(false);
    }
  };

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
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className="config-button config-button-small config-button-secondary"
          disabled={saving || draft === String(stored)}
          onClick={() => void saveTarget()}
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
      {(active?.approximate ?? false) && (
        <p className="settings-general-description">{t("settings.memoryTargetFallback")}</p>
      )}
      <div className="settings-shell-option">
        <span>{t("settings.memoryReclaim")}</span>
        <button
          type="button"
          className="config-button config-button-small config-button-secondary"
          disabled={reclaiming}
          onClick={() => void reclaimNow()}
        >
          {reclaiming ? t("settings.memoryReclaiming") : t("settings.memoryReclaimAction")}
        </button>
      </div>
      <p className="settings-general-description">{t("settings.memoryTargetLiteHint")}</p>
      {reclaimMessage && <p role="status" className="settings-memory-saved">{reclaimMessage}</p>}
      {saveError && <p role="alert" className="settings-general-error">{saveError}</p>}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {saved && <p role="status" className="settings-memory-saved">{t("settings.memoryTargetSaved")}</p>}
    </div>
  );
}
