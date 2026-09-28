import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

function makeSessionStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

test("returns a stable id per tab and persists it in sessionStorage", async (t) => {
  const storage = makeSessionStorage();
  globalThis.window = { sessionStorage: storage };
  t.after(() => { delete globalThis.window; });

  const { CLIENT_ID_STORAGE_KEY, getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();

  const first = getClientId();
  assert.equal(typeof first, "string");
  assert.ok(first.length > 0);
  assert.equal(storage.data.get(CLIENT_ID_STORAGE_KEY), first);

  // A reload re-reads the same per-tab id.
  resetClientIdCache();
  assert.equal(getClientId(), first);

  // A fresh tab starts with its own storage and gets a different id.
  globalThis.window = { sessionStorage: makeSessionStorage() };
  resetClientIdCache();
  assert.notEqual(getClientId(), first);
});

test("keeps the id per tab even when two tabs share one localStorage", async (t) => {
  // The Lite-mode preference is device-wide (localStorage); the presence id is
  // deliberately not, or one tab's release could drop another tab's leases.
  const sharedLocalStorage = makeSessionStorage();
  globalThis.window = { localStorage: sharedLocalStorage, sessionStorage: makeSessionStorage() };
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  const tabA = getClientId();

  globalThis.window = { localStorage: sharedLocalStorage, sessionStorage: makeSessionStorage() };
  resetClientIdCache();
  const tabB = getClientId();

  assert.ok(tabA.length > 0);
  assert.notEqual(tabB, tabA);
  assert.equal(sharedLocalStorage.data.size, 0, "the id must never be stored device-wide");
});

test("reuses an id already present in sessionStorage", async (t) => {
  const storage = makeSessionStorage();
  storage.data.set("pi-web:client-id", "existing-tab");
  globalThis.window = { sessionStorage: storage };
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  assert.equal(getClientId(), "existing-tab");
});

test("returns an empty id off the browser", async (t) => {
  delete globalThis.window;
  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  t.after(() => { resetClientIdCache(); });
  assert.equal(getClientId(), "");
});
