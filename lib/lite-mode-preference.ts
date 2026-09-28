import { createDevicePreference } from "./device-preference";

// Lite mode is a device-level preference, deliberately not a server setting:
// it lives in localStorage, which every tab of one browser profile shares, and
// enabling it here must not force other devices into the reduced-lifetime
// session policy. See lib/device-preference.ts for the shared sync rules.
export const LITE_MODE_STORAGE_KEY = "pi-web:lite-mode";

const preference = createDevicePreference<boolean>({
  storageKey: LITE_MODE_STORAGE_KEY,
  fallback: false,
  parse: (raw) => raw === "1",
  serialize: (enabled) => (enabled ? "1" : "0"),
});

export function isLiteModeEnabled(): boolean {
  return preference.get();
}

export function setLiteModeEnabled(enabled: boolean): void {
  preference.set(enabled);
}

/**
 * Subscribe to Lite-mode changes: from this tab, and from every other tab of
 * the same browser profile through `storage` events. Other devices stay
 * independent — each one reads its own preference.
 */
export function subscribeLiteMode(listener: (enabled: boolean) => void): () => void {
  return preference.subscribe(listener);
}
