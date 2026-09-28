"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_LITE_IDLE_MINUTES, isValidLiteIdleMinutes } from "@/lib/lite-lifecycle";
import {
  getLiteIdleMinutes,
  setLiteIdleMinutes,
  subscribeLiteIdleMinutes,
} from "@/lib/lite-idle-minutes";

/**
 * Reads the device-local idle-minutes preference after mount (localStorage is
 * not available during SSR) and keeps it live for every tab of this browser: a
 * change in any tab reaches this one through `subscribeLiteIdleMinutes`. Other
 * devices keep their own preference.
 */
export function useLiteIdleMinutes(): [number, (minutes: number) => void] {
  const [minutes, setMinutes] = useState(DEFAULT_LITE_IDLE_MINUTES);

  useEffect(() => {
    setMinutes(getLiteIdleMinutes());
    return subscribeLiteIdleMinutes(setMinutes);
  }, []);

  const update = useCallback((next: number) => {
    if (!isValidLiteIdleMinutes(next)) return;
    setLiteIdleMinutes(next);
  }, []);

  return [minutes, update];
}
