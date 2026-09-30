"use client";

import { useCallback } from "react";
import { useLiteConfig } from "@/hooks/useLiteConfig";

/**
 * Whether this Pi-Web instance runs Lite mode, with a setter that persists the
 * change server-side. The mode is the instance's, not this page's: every tab
 * and every device reads the same one.
 */
export function useLiteMode(): [boolean, (enabled: boolean) => void] {
  const { snapshot, save } = useLiteConfig();
  const setEnabled = useCallback((enabled: boolean) => {
    void save({ enabled });
  }, [save]);
  return [snapshot.config.enabled, setEnabled];
}
