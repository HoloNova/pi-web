import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

function makeLocalStorage({ failWrites = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (failWrites) throw new Error("storage disabled");
      data.set(key, String(value));
    },
  };
}

// Minimal browser window: the module needs localStorage plus the
// add/removeEventListener pair it registers the `storage` listener with.
function makeWindow({ localStorage = makeLocalStorage() } = {}) {
  const handlers = new Map();
  return {
    localStorage,
    addEventListener(type, listener) {
      handlers.set(type, [...(handlers.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== listener));
    },
    listenerCount: (type) => (handlers.get(type) ?? []).length,
    emit(type, event) {
      for (const listener of [...(handlers.get(type) ?? [])]) listener(event);
    },
  };
}

test("defaults to off off the browser and when storage is empty", async (t) => {
  delete globalThis.window;
  const { isLiteModeEnabled } = await jiti.import("./lite-mode-preference.ts");
  assert.equal(isLiteModeEnabled(), false);

  globalThis.window = makeWindow();
  t.after(() => { delete globalThis.window; });
  assert.equal(isLiteModeEnabled(), false);
});

test("persists the preference across reloads", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_MODE_STORAGE_KEY, isLiteModeEnabled, setLiteModeEnabled } = await jiti.import("./lite-mode-preference.ts");
  setLiteModeEnabled(true);
  assert.equal(win.localStorage.data.get(LITE_MODE_STORAGE_KEY), "1");
  assert.equal(isLiteModeEnabled(), true);

  setLiteModeEnabled(false);
  assert.equal(isLiteModeEnabled(), false);
});

test("notifies listeners once per write and attaches the storage listener lazily", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { setLiteModeEnabled, subscribeLiteMode } = await jiti.import("./lite-mode-preference.ts");
  const seen = [];
  assert.equal(win.listenerCount("storage"), 0, "no listener until something subscribes");
  const unsubscribe = subscribeLiteMode((enabled) => seen.push(enabled));
  assert.equal(win.listenerCount("storage"), 1);

  setLiteModeEnabled(true);
  setLiteModeEnabled(false);
  unsubscribe();
  setLiteModeEnabled(true);

  // One notification per write: the writing tab is never double-notified,
  // because the browser does not deliver `storage` back to it.
  assert.deepEqual(seen, [true, false]);
});

test("another tab's write reaches this tab through the storage event", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_MODE_STORAGE_KEY, isLiteModeEnabled, subscribeLiteMode } = await jiti.import("./lite-mode-preference.ts");
  const seen = [];
  subscribeLiteMode((enabled) => seen.push(enabled));
  assert.equal(isLiteModeEnabled(), false);

  // The other tab writes; the browser updates this tab's localStorage first and
  // then delivers the event.
  win.localStorage.data.set(LITE_MODE_STORAGE_KEY, "1");
  win.emit("storage", { key: LITE_MODE_STORAGE_KEY, newValue: "1", storageArea: win.localStorage });
  assert.deepEqual(seen, [true]);
  assert.equal(isLiteModeEnabled(), true);

  win.localStorage.data.set(LITE_MODE_STORAGE_KEY, "0");
  win.emit("storage", { key: LITE_MODE_STORAGE_KEY, newValue: "0", storageArea: win.localStorage });
  assert.deepEqual(seen, [true, false]);
  assert.equal(isLiteModeEnabled(), false);
});

test("ignores other keys, and reads a clear from another tab as disabled", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_MODE_STORAGE_KEY, subscribeLiteMode } = await jiti.import("./lite-mode-preference.ts");
  const seen = [];
  subscribeLiteMode((enabled) => seen.push(enabled));

  win.emit("storage", { key: "pi-web:theme", newValue: "dark" });
  win.emit("storage", { key: `${LITE_MODE_STORAGE_KEY}-other`, newValue: "1" });
  assert.deepEqual(seen, []);

  // `storage.clear()` elsewhere drops the preference, so Lite mode is off.
  win.emit("storage", { key: null, newValue: null });
  assert.deepEqual(seen, [false]);
});

test("stops listening for storage once the last subscriber leaves", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_MODE_STORAGE_KEY, subscribeLiteMode } = await jiti.import("./lite-mode-preference.ts");
  const first = [];
  const second = [];
  const unsubscribeFirst = subscribeLiteMode((enabled) => first.push(enabled));
  const unsubscribeSecond = subscribeLiteMode((enabled) => second.push(enabled));
  assert.equal(win.listenerCount("storage"), 1, "one shared storage listener for every subscriber");

  unsubscribeFirst();
  assert.equal(win.listenerCount("storage"), 1);
  unsubscribeSecond();
  assert.equal(win.listenerCount("storage"), 0);

  win.emit("storage", { key: LITE_MODE_STORAGE_KEY, newValue: "1" });
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
});

test("keeps the in-memory toggle usable when storage writes fail", async (t) => {
  const win = makeWindow({ localStorage: makeLocalStorage({ failWrites: true }) });
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { isLiteModeEnabled, setLiteModeEnabled, subscribeLiteMode } = await jiti.import("./lite-mode-preference.ts");
  const seen = [];
  subscribeLiteMode((enabled) => seen.push(enabled));

  setLiteModeEnabled(true);
  assert.deepEqual(seen, [true]);
  assert.equal(isLiteModeEnabled(), false, "a failed write leaves storage untouched");
});
