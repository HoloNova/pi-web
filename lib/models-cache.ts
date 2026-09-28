export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; input?: string[] }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

/**
 * Cache key for `/api/models`.
 *
 * Lite and normal loads see different catalogs — Lite has no
 * extension-registered providers — so they must never share an entry. Without
 * the split, switching Lite off could keep serving the Lite list for a full
 * TTL, and a Lite tab could briefly see extension providers.
 */
export function modelsCacheKey(cwd: string, lite: boolean): string {
  return lite ? `lite\u0000${cwd}` : cwd;
}

/**
 * `key` identifies the loader's catalog, not just the directory: callers whose
 * loader varies must vary the key too (see `modelsCacheKey()`).
 */
export function loadModelsWithCache(key: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(key);
  }

  const existingLoad = state.inFlight.get(key);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(key) === loadPromise) {
        const now = Date.now();
        for (const [entryKey, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(entryKey);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(key, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loadPromise) state.inFlight.delete(key);
    });

  state.inFlight.set(key, loadPromise);
  return loadPromise;
}
