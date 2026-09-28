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

test("defaults to five minutes off the browser and when storage is empty", async (t) => {
  delete globalThis.window;
  const { getLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  assert.equal(getLiteIdleMinutes(), 5);

  globalThis.window = makeWindow();
  t.after(() => { delete globalThis.window; });
  assert.equal(getLiteIdleMinutes(), 5);
});

test("persists the chosen minutes across reloads and rejects out-of-range values", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_IDLE_MINUTES_STORAGE_KEY, getLiteIdleMinutes, setLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  setLiteIdleMinutes(30);
  assert.equal(win.localStorage.data.get(LITE_IDLE_MINUTES_STORAGE_KEY), "30");
  assert.equal(getLiteIdleMinutes(), 30);

  // A hand-edited or older value that is not 1..60 minutes reads as the default.
  win.localStorage.data.set(LITE_IDLE_MINUTES_STORAGE_KEY, "0");
  assert.equal(getLiteIdleMinutes(), 5);
  win.localStorage.data.set(LITE_IDLE_MINUTES_STORAGE_KEY, "61");
  assert.equal(getLiteIdleMinutes(), 5);
  win.localStorage.data.set(LITE_IDLE_MINUTES_STORAGE_KEY, "nope");
  assert.equal(getLiteIdleMinutes(), 5);
});

test("notifies listeners once per write and attaches the storage listener lazily", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { setLiteIdleMinutes, subscribeLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  const seen = [];
  assert.equal(win.listenerCount("storage"), 0, "no listener until something subscribes");
  const unsubscribe = subscribeLiteIdleMinutes((minutes) => seen.push(minutes));
  assert.equal(win.listenerCount("storage"), 1);

  setLiteIdleMinutes(10);
  setLiteIdleMinutes(45);
  unsubscribe();

  assert.deepEqual(seen, [10, 45]);
});

test("another tab's write reaches this tab through the storage event", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_IDLE_MINUTES_STORAGE_KEY, getLiteIdleMinutes, subscribeLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  const seen = [];
  const unsubscribe = subscribeLiteIdleMinutes((minutes) => seen.push(minutes));
  t.after(unsubscribe);
  assert.equal(getLiteIdleMinutes(), 5);

  win.localStorage.data.set(LITE_IDLE_MINUTES_STORAGE_KEY, "20");
  win.emit("storage", { key: LITE_IDLE_MINUTES_STORAGE_KEY, newValue: "20", storageArea: win.localStorage });
  assert.deepEqual(seen, [20]);
  assert.equal(getLiteIdleMinutes(), 20);

  // A malformed value from another tab lands on the default, not the last value.
  win.localStorage.data.set(LITE_IDLE_MINUTES_STORAGE_KEY, "999");
  win.emit("storage", { key: LITE_IDLE_MINUTES_STORAGE_KEY, newValue: "999", storageArea: win.localStorage });
  assert.deepEqual(seen, [20, 5]);

  unsubscribe();
});

test("ignores other keys, and reads a clear from another tab as the default", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_IDLE_MINUTES_STORAGE_KEY, subscribeLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  const seen = [];
  const unsubscribe = subscribeLiteIdleMinutes((minutes) => seen.push(minutes));
  t.after(unsubscribe);

  win.emit("storage", { key: "pi-web:theme", newValue: "dark" });
  win.emit("storage", { key: `${LITE_IDLE_MINUTES_STORAGE_KEY}-other`, newValue: "10" });
  assert.deepEqual(seen, []);

  win.emit("storage", { key: null, newValue: null });
  assert.deepEqual(seen, [5]);

  unsubscribe();
});

test("stops listening for storage once the last subscriber leaves", async (t) => {
  const win = makeWindow();
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { LITE_IDLE_MINUTES_STORAGE_KEY, subscribeLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  const first = [];
  const second = [];
  const unsubscribeFirst = subscribeLiteIdleMinutes((minutes) => first.push(minutes));
  const unsubscribeSecond = subscribeLiteIdleMinutes((minutes) => second.push(minutes));
  assert.equal(win.listenerCount("storage"), 1, "one shared storage listener for every subscriber");

  unsubscribeFirst();
  assert.equal(win.listenerCount("storage"), 1);
  unsubscribeSecond();
  assert.equal(win.listenerCount("storage"), 0);

  win.emit("storage", { key: LITE_IDLE_MINUTES_STORAGE_KEY, newValue: "10" });
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
});

test("keeps the in-memory value usable when storage writes fail", async (t) => {
  const win = makeWindow({ localStorage: makeLocalStorage({ failWrites: true }) });
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });

  const { getLiteIdleMinutes, setLiteIdleMinutes, subscribeLiteIdleMinutes } = await jiti.import("./lite-idle-minutes.ts");
  const seen = [];
  const unsubscribe = subscribeLiteIdleMinutes((minutes) => seen.push(minutes));
  t.after(unsubscribe);

  setLiteIdleMinutes(15);
  assert.deepEqual(seen, [15]);
  assert.equal(getLiteIdleMinutes(), 5, "a failed write leaves storage untouched");

  unsubscribe();
});
