// A device-level preference lives in localStorage, which every tab of one
// browser profile shares. Enabling it in one tab must not reach another device,
// so this is deliberately not a server setting. Tabs of the same profile follow
// a change live through the `storage` event the browser delivers to every
// *other* tab of that profile.
//
// This is the one implementation behind the Lite-mode toggle and the Lite
// idle-minutes option, so both sync across tabs by the same rules.

export interface DevicePreferenceCodec<T> {
  /** localStorage key. */
  storageKey: string;
  /** Value used when storage is empty, cleared, or unreadable. */
  fallback: T;
  /** Parse a raw storage value (`null` when the key is absent or cleared). */
  parse(raw: string | null): T;
  /** Serialize a value for storage. */
  serialize(value: T): string;
}

export interface DevicePreference<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function createDevicePreference<T>(codec: DevicePreferenceCodec<T>): DevicePreference<T> {
  const listeners = new Set<(value: T) => void>();
  let storageListenerAttached = false;

  const notify = (value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error(
          "[pi-web] device preference listener failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  };

  // Another tab of this profile rewrote the preference. A browser never
  // delivers `storage` to the tab that performed the write, so this path only
  // ever reaches the other tabs: the writer is notified by `set` alone and
  // cannot be notified twice. `key === null` is `storage.clear()`, which drops
  // the preference as well.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== codec.storageKey) return;
    notify(codec.parse(event.newValue));
  };

  const attachStorageListener = (): void => {
    if (storageListenerAttached || typeof window === "undefined") return;
    if (typeof window.addEventListener !== "function") return;
    window.addEventListener("storage", onStorage);
    storageListenerAttached = true;
  };

  const detachStorageListener = (): void => {
    if (!storageListenerAttached) return;
    storageListenerAttached = false;
    if (typeof window === "undefined" || typeof window.removeEventListener !== "function") return;
    window.removeEventListener("storage", onStorage);
  };

  return {
    get(): T {
      if (typeof window === "undefined") return codec.fallback;
      try {
        const raw = window.localStorage.getItem(codec.storageKey);
        return raw === null ? codec.fallback : codec.parse(raw);
      } catch {
        return codec.fallback;
      }
    },
    set(value: T): void {
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(codec.storageKey, codec.serialize(value));
        } catch {
          // Private-mode storage failures keep the in-memory value usable in
          // this tab; the other tabs of the profile cannot see the write.
        }
      }
      notify(value);
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      attachStorageListener();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detachStorageListener();
      };
    },
  };
}
