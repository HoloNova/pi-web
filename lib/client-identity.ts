// Stable identity for one browser tab. `sessionStorage` is per-tab and survives
// reloads, so every request from a tab (SSE lease, presence, agent commands)
// carries the same id and one tab can release only its own server-side leases.
export const CLIENT_ID_STORAGE_KEY = "pi-web:client-id";

let cachedClientId: string | null = null;

function createClientId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getClientId(): string {
  if (typeof window === "undefined") return "";
  if (cachedClientId) return cachedClientId;
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) {
      cachedClientId = existing;
      return existing;
    }
    const created = createClientId();
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
    cachedClientId = created;
    return created;
  } catch {
    cachedClientId = createClientId();
    return cachedClientId;
  }
}

/** Test seam: forget the in-memory id so the next call re-reads storage. */
export function resetClientIdCache(): void {
  cachedClientId = null;
}
