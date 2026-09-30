"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { LiteConfig } from "@/lib/lite-config";
import {
  getLiteConfigServerSnapshot,
  getLiteConfigSnapshot,
  refreshLiteConfig,
  saveLiteConfig,
  subscribeLiteConfig,
  type LiteConfigSnapshot,
} from "@/lib/lite-config-store";

export interface LiteConfigControls {
  snapshot: LiteConfigSnapshot;
  /** Persist a partial change; resolves false when the server refused it. */
  save: (patch: Partial<LiteConfig>) => Promise<boolean>;
}

/**
 * This instance's Lite configuration. One read serves every component that asks
 * for it, and the value is re-read when the page becomes visible again — the
 * setting is shared, so another device may have changed it meanwhile.
 */
export function useLiteConfig(): LiteConfigControls {
  const snapshot = useSyncExternalStore(
    subscribeLiteConfig,
    getLiteConfigSnapshot,
    getLiteConfigServerSnapshot,
  );

  useEffect(() => {
    void refreshLiteConfig();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshLiteConfig();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const save = useCallback((patch: Partial<LiteConfig>) => saveLiteConfig(patch), []);

  return { snapshot, save };
}
