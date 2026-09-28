import { createDevicePreference } from "./device-preference";
import { DEFAULT_LITE_IDLE_MINUTES, parseLiteIdleMinutes } from "./lite-lifecycle";

// How long a page may sit without real interaction before it releases its
// session. A device-level preference like the Lite toggle: it lives in
// localStorage and follows the shared sync rules in lib/device-preference.ts,
// so a change in one tab re-arms the deadline in the others without a reload.
export const LITE_IDLE_MINUTES_STORAGE_KEY = "pi-web:lite-idle-minutes";

const preference = createDevicePreference<number>({
  storageKey: LITE_IDLE_MINUTES_STORAGE_KEY,
  fallback: DEFAULT_LITE_IDLE_MINUTES,
  parse: (raw) => parseLiteIdleMinutes(raw),
  serialize: (minutes) => String(minutes),
});

export function getLiteIdleMinutes(): number {
  return preference.get();
}

export function setLiteIdleMinutes(minutes: number): void {
  preference.set(minutes);
}

export function subscribeLiteIdleMinutes(listener: (minutes: number) => void): () => void {
  return preference.subscribe(listener);
}
