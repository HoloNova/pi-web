// Lite mode is a device-level preference, deliberately not a server setting:
// it lives in localStorage, which every tab of one browser profile shares, and
// enabling it here must not force other devices into the reduced-lifetime
// session policy. Tabs of the same browser follow a toggle live through the
// `storage` event the browser delivers to every *other* tab of that profile.
export const LITE_MODE_STORAGE_KEY = "pi-web:lite-mode";

type LiteModeListener = (enabled: boolean) => void;

const listeners = new Set<LiteModeListener>();
let storageListenerAttached = false;

function notifyLiteModeListeners(enabled: boolean): void {
  for (const listener of [...listeners]) {
    try {
      listener(enabled);
    } catch (error) {
      console.error("[pi-web] lite mode listener failed:", error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Another tab of this browser profile rewrote the preference. A browser never
 * delivers `storage` to the tab that performed the write, so this path only
 * ever reaches the other tabs: the writer is notified by `setLiteModeEnabled`
 * alone and cannot be notified twice.
 */
function onLiteModeStorage(event: StorageEvent): void {
  // `key === null` is `storage.clear()`, which drops the preference as well.
  if (event.key !== null && event.key !== LITE_MODE_STORAGE_KEY) return;
  notifyLiteModeListeners(event.newValue === "1");
}

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", onLiteModeStorage);
  storageListenerAttached = true;
}

function detachStorageListener(): void {
  if (!storageListenerAttached) return;
  storageListenerAttached = false;
  if (typeof window === "undefined" || typeof window.removeEventListener !== "function") return;
  window.removeEventListener("storage", onLiteModeStorage);
}

export function isLiteModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LITE_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLiteModeEnabled(enabled: boolean): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LITE_MODE_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Private-mode storage failures keep the in-memory toggle usable in this
      // tab; the other tabs of the profile cannot see the write in that case.
    }
  }
  notifyLiteModeListeners(enabled);
}

/**
 * Subscribe to Lite-mode changes: from this tab, and from every other tab of
 * the same browser profile through `storage` events. Other devices stay
 * independent — each one reads its own preference.
 */
export function subscribeLiteMode(listener: LiteModeListener): () => void {
  listeners.add(listener);
  attachStorageListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detachStorageListener();
  };
}
