const SESSION_LIVENESS_PROTOCOL_VERSION = 1;
export const SESSION_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
export const SESSION_LIVENESS_LEASE_TTL_MS = 90_000;
const SESSION_LIVENESS_LEASES_KEY = "@agegr/pi-web/session-liveness-leases/v1";
const SESSION_LIVENESS_LISTENERS_KEY = "@agegr/pi-web/session-liveness-listeners/v1";

export interface SessionLivenessProvider {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive(): boolean;
}

interface SessionIdentity {
  sessionId: string;
  sessionFile?: string;
}

interface SessionLivenessRegistry {
  version: typeof SESSION_LIVENESS_PROTOCOL_VERSION;
  register(provider: SessionLivenessProvider): () => void;
  hasActiveProvider(session: SessionIdentity): boolean;
}

export interface SessionLivenessLease {
  renew(): void;
  release(): void;
}

interface LeaseRecord extends SessionLivenessLease {
  sessionId: string;
  expiresAt: number;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Browser tab/device that owns this lease, when it is client-scoped. */
  clientId?: string;
  /** True for a page-presence lease; only these notify reclaim listeners. */
  presence: boolean;
}

type LeaseStore = Map<string, Set<LeaseRecord>>;

type SessionPresenceReleaseListener = (sessionId: string, clientId: string) => void;

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Session liveness provider ${field} must be a non-empty string`);
  }
}

function validateProvider(provider: SessionLivenessProvider): void {
  if (!provider || typeof provider !== "object") {
    throw new Error("Session liveness provider must be an object");
  }
  assertNonEmptyString(provider.name, "name");
  assertNonEmptyString(provider.sessionId, "sessionId");
  if (provider.sessionFile !== undefined) {
    assertNonEmptyString(provider.sessionFile, "sessionFile");
  }
  if (typeof provider.isActive !== "function") {
    throw new Error("Session liveness provider isActive must be a function");
  }
}

function createRegistry(): SessionLivenessRegistry {
  const providers = new Map<symbol, SessionLivenessProvider>();

  return {
    version: SESSION_LIVENESS_PROTOCOL_VERSION,
    register(provider) {
      validateProvider(provider);
      const token = Symbol(provider.name);
      providers.set(token, provider);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        providers.delete(token);
      };
    },
    hasActiveProvider(session) {
      const identities = new Set([session.sessionId, session.sessionFile].filter((value): value is string => Boolean(value)));
      for (const provider of providers.values()) {
        if (!identities.has(provider.sessionId) && (!provider.sessionFile || !identities.has(provider.sessionFile))) {
          continue;
        }
        try {
          const active = provider.isActive();
          if (typeof active !== "boolean") {
            throw new Error("isActive() must return a boolean");
          }
          if (active) return true;
        } catch (error) {
          console.error(`[pi-web] Session liveness provider '${provider.name}' failed; preserving the session:`, error);
          return true;
        }
      }
      return false;
    },
  };
}

function isCompatibleRegistry(value: unknown): value is SessionLivenessRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionLivenessRegistry>;
  return candidate.version === SESSION_LIVENESS_PROTOCOL_VERSION
    && typeof candidate.register === "function"
    && typeof candidate.hasActiveProvider === "function";
}

function getRegistry(): SessionLivenessRegistry {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(SESSION_LIVENESS_REGISTRY_KEY);
  const existing = store[key];
  if (isCompatibleRegistry(existing)) return existing;
  const registry = createRegistry();
  store[key] = registry;
  return registry;
}

const registry = getRegistry();

function getLeaseStore(): LeaseStore {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(SESSION_LIVENESS_LEASES_KEY);
  const existing = store[key];
  if (existing instanceof Map) return existing as LeaseStore;
  const leases: LeaseStore = new Map();
  store[key] = leases;
  return leases;
}

// The SSE route and the agent route are bundled into separate module graphs,
// each with its own copy of this module. Global listeners keep a reclaim
// request raised on one graph visible to the registry on the other.
function getPresenceListeners(): Set<SessionPresenceReleaseListener> {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(SESSION_LIVENESS_LISTENERS_KEY);
  const existing = store[key];
  if (existing instanceof Set) return existing as Set<SessionPresenceReleaseListener>;
  const listeners = new Set<SessionPresenceReleaseListener>();
  store[key] = listeners;
  return listeners;
}

function notifyPresenceReleased(sessionId: string, clientId: string): void {
  for (const listener of [...getPresenceListeners()]) {
    try {
      listener(sessionId, clientId);
    } catch (error) {
      console.error(
        "[pi-web] session presence release listener failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function scheduleLeaseExpiry(lease: LeaseRecord): void {
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = setTimeout(() => {
    if (!lease.released && lease.expiresAt <= Date.now()) lease.release();
    else if (!lease.released) scheduleLeaseExpiry(lease);
  }, Math.max(1, lease.expiresAt - Date.now()));
  const unref = (lease.timer as unknown as { unref?: () => void }).unref;
  unref?.call(lease.timer);
}

function createLease(
  sessionId: string,
  options: { clientId?: string; presence?: boolean } = {},
): LeaseRecord {
  const leases = getLeaseStore();
  const presence = options.presence ?? false;
  const clientId = options.clientId;
  const providerRelease = registerSessionLivenessProvider({
    name: presence ? "pi-web-selected-presence" : "pi-web-selected-session",
    sessionId,
    isActive: () => !lease.released && lease.expiresAt > Date.now(),
  });
  const release = () => {
    if (lease.released) return;
    lease.released = true;
    if (lease.timer) clearTimeout(lease.timer);
    providerRelease();
    const sessionLeases = leases.get(sessionId);
    sessionLeases?.delete(lease);
    if (sessionLeases?.size === 0) leases.delete(sessionId);
    if (presence) notifyPresenceReleased(sessionId, clientId ?? "");
  };
  const renew = () => {
    if (lease.released) return;
    lease.expiresAt = Date.now() + SESSION_LIVENESS_LEASE_TTL_MS;
    scheduleLeaseExpiry(lease);
  };
  const lease: LeaseRecord = {
    sessionId,
    expiresAt: Date.now() + SESSION_LIVENESS_LEASE_TTL_MS,
    released: false,
    timer: null,
    presence,
    ...(clientId !== undefined ? { clientId } : {}),
    renew,
    release,
  };
  const sessionLeases = leases.get(sessionId) ?? new Set<LeaseRecord>();
  sessionLeases.add(lease);
  leases.set(sessionId, sessionLeases);
  scheduleLeaseExpiry(lease);
  return lease;
}

/** Keep one selected browser session alive while its lease is being renewed. */
export function acquireSessionLivenessLease(
  sessionId: string,
  options: { clientId?: string } = {},
): SessionLivenessLease {
  return createLease(sessionId, { ...(options.clientId !== undefined ? { clientId: options.clientId } : {}) });
}

/**
 * Renew every live browser lease for a session; expired leases are ignored.
 * A clientId renews only that tab's leases so one page cannot keep another
 * page's presence alive.
 */
export function renewSessionLivenessLeases(sessionId: string, clientId?: string): number {
  const leases = getLeaseStore().get(sessionId);
  if (!leases) return 0;
  let renewed = 0;
  for (const lease of [...leases]) {
    if (clientId !== undefined && lease.clientId !== clientId) continue;
    if (lease.released || lease.expiresAt <= Date.now()) {
      lease.release();
      continue;
    }
    lease.renew();
    renewed += 1;
  }
  return renewed;
}

/**
 * Register or refresh this tab's presence for a session. Presence is what makes
 * the server treat the session as actively viewed; it is deliberately separate
 * from the SSE connection lease so a reconnect blip cannot drop the viewer.
 */
export function acquireSessionPresence(sessionId: string, clientId: string): void {
  assertNonEmptyString(sessionId, "sessionId");
  assertNonEmptyString(clientId, "clientId");
  const leases = getLeaseStore().get(sessionId);
  if (leases) {
    for (const lease of [...leases]) {
      if (lease.presence && lease.clientId === clientId && !lease.released) {
        lease.renew();
        return;
      }
    }
  }
  createLease(sessionId, { clientId, presence: true });
}

/**
 * Drop this tab's presence and every lease it owns (the SSE connection lease
 * included) in one step, then let reclaim listeners decide whether the wrapper
 * can now close. Idempotent: a second release for an already-released client
 * notifies nobody.
 */
export function releaseSessionPresence(sessionId: string, clientId: string): void {
  const leases = getLeaseStore().get(sessionId);
  if (!leases) return;
  for (const lease of [...leases]) {
    if (lease.clientId === clientId) lease.release();
  }
}

export function hasActiveSessionPresence(sessionId: string): boolean {
  const leases = getLeaseStore().get(sessionId);
  if (!leases) return false;
  for (const lease of leases) {
    if (lease.presence && !lease.released && lease.expiresAt > Date.now()) return true;
  }
  return false;
}

/**
 * Observe page-presence releases and lease-expiry fallbacks. The listener runs
 * after the lease is gone, so it can decide whether an idle session wrapper now
 * has no viewer left.
 */
export function onSessionPresenceReleased(listener: SessionPresenceReleaseListener): () => void {
  const listeners = getPresenceListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Register session-scoped work that must survive pi-web's automatic idle eviction.
 * Explicit shutdown and runtime replacement still take precedence.
 */
export function registerSessionLivenessProvider(provider: SessionLivenessProvider): () => void {
  return registry.register(provider);
}

export function hasActiveSessionLivenessProvider(session: SessionIdentity): boolean {
  return registry.hasActiveProvider(session);
}
