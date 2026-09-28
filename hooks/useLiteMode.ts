"use client";

import { useCallback, useEffect, useState } from "react";
import {
  isLiteModeEnabled,
  setLiteModeEnabled,
  subscribeLiteMode,
} from "@/lib/lite-mode-preference";

/**
 * Reads the Lite-mode preference after mount (localStorage is not available
 * during SSR) and keeps the value live for every tab of this browser: a toggle
 * in any tab reaches this one through `subscribeLiteMode`'s `storage` listener.
 * Other devices keep their own preference.
 */
export function useLiteMode(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(isLiteModeEnabled());
    return subscribeLiteMode(setEnabled);
  }, []);

  const update = useCallback((next: boolean) => {
    setLiteModeEnabled(next);
  }, []);

  return [enabled, update];
}
