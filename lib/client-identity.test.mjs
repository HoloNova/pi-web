import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

function makeStorage() {
  const data = new Map();
  const writes = [];
  return {
    data,
    writes,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { writes.push([key, String(value)]); data.set(key, String(value)); },
  };
}

test("one id per page runtime, stable across calls", async (t) => {
  globalThis.window = { sessionStorage: makeStorage(), localStorage: makeStorage() };
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();

  const first = getClientId();
  assert.equal(typeof first, "string");
  assert.ok(first.length > 0);
  assert.equal(getClientId(), first);
});

test("the id is never persisted, so a copied tab storage cannot impersonate a page", async (t) => {
  const sessionStorage = makeStorage();
  const localStorage = makeStorage();
  globalThis.window = { sessionStorage, localStorage };
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  const id = getClientId();

  assert.ok(id.length > 0);
  assert.deepEqual(sessionStorage.writes, [], "nothing may be written to sessionStorage");
  assert.deepEqual(localStorage.writes, [], "nothing may be written to localStorage");
  assert.equal(sessionStorage.data.size, 0);
  assert.equal(localStorage.data.size, 0);
});

test("a reload is a new page runtime and therefore a new id", async (t) => {
  globalThis.window = { sessionStorage: makeStorage() };
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  const beforeReload = getClientId();

  // A reload discards the page's JavaScript runtime; only the server-side lease
  // TTL covers the page that went away without releasing.
  resetClientIdCache();
  assert.notEqual(getClientId(), beforeReload);
});

test("two pages get different ids", async (t) => {
  globalThis.window = {};
  t.after(() => { delete globalThis.window; });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  const pageA = getClientId();
  resetClientIdCache();
  const pageB = getClientId();
  assert.notEqual(pageA, pageB);
});

test("uses crypto.randomUUID when the browser provides it", async (t) => {
  const uuid = "11111111-2222-4333-8444-555555555555";
  globalThis.window = {};
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => uuid }, configurable: true });
  t.after(() => {
    Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true });
    delete globalThis.window;
  });

  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  assert.equal(getClientId(), uuid);
});

test("returns an empty id off the browser", async (t) => {
  delete globalThis.window;
  const { getClientId, resetClientIdCache } = await jiti.import("./client-identity.ts");
  resetClientIdCache();
  t.after(() => { resetClientIdCache(); });
  assert.equal(getClientId(), "");
});

test("the module never touches web storage", async () => {
  // Comments may name the storages to explain why they are avoided; the code
  // must not reach for them.
  const source = await readFile(new URL("./client-identity.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /window\.(sessionStorage|localStorage)/);
  assert.doesNotMatch(source, /\.(getItem|setItem|removeItem)\(/);
});
