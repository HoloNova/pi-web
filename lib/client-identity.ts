// Identity for one page's JavaScript runtime.
//
// It is deliberately not kept in sessionStorage: some browsers copy that
// storage into a new window or a window opened from an opener, and a copied id
// would let one page release another page's leases. A reload therefore starts a
// new id, and the server drops the old page's presence when its lease expires
// (or immediately, if the page managed to release before unloading).

let clientId: string | null = null;

function createClientId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** This page's id, or "" off the browser. Stable for the life of the page. */
export function getClientId(): string {
  if (typeof window === "undefined") return "";
  if (clientId) return clientId;
  clientId = createClientId();
  return clientId;
}

/** Test seam: forget the in-memory id so the next call creates a new one. */
export function resetClientIdCache(): void {
  clientId = null;
}
