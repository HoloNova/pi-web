import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * One shared snapshot and one poll loop behind the chat card and the settings
 * control. The module keeps per-tab state, so every test tears its subscribers
 * down before returning (which stops the loop and detaches the visibility
 * listener) and restores the globals it replaced. Teardown is also registered
 * via `t.after` so a mid-test failure cannot leak a subscriber into the next
 * test.
 */
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const store = await jiti.import("./memory-status-store.ts");

const ACTIVE = {
  active: true,
  targetMiB: 1500,
  defaultMiB: 1500,
  minMiB: 256,
  maxMiB: 16384,
  nearRatio: 0.9,
  usedBytes: 1_500_000_000,
  usedMiB: 1430,
  state: "near",
  source: "cgroup",
  approximate: false,
  detail: "/cgroup/memory.current",
  reclaim: null,
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

// A fresh snapshot object per read, like the real JSON body: an identity-equal
// repeat would (correctly) be treated as "nothing changed".
const activeSnapshot = (targetMiB = 1500) => ({ ...ACTIVE, targetMiB });

function makeDocument(visibilityState = "visible") {
  const handlers = new Map();
  return {
    visibilityState,
    addEventListener(type, listener) {
      handlers.set(type, [...(handlers.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== listener));
    },
    emit(type) {
      for (const listener of [...(handlers.get(type) ?? [])]) listener();
    },
    listenerCount: (type) => (handlers.get(type) ?? []).length,
  };
}

function installGlobals({ fetchImpl, doc, lite = true }) {
  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    window: globalThis.window,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const intervals = new Set();
  globalThis.fetch = fetchImpl;
  globalThis.document = doc;
  globalThis.window = lite
    ? {
      localStorage: { getItem: () => "1", setItem() {} },
      addEventListener() {},
      removeEventListener() {},
    }
    : undefined;
  globalThis.setInterval = () => {
    const id = Symbol("interval");
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  return {
    intervals,
    restore() {
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      globalThis.setInterval = previous.setInterval;
      globalThis.clearInterval = previous.clearInterval;
    },
  };
}

test("one shared store and one poll loop serve two subscribers", async (t) => {
  const env = installGlobals({ fetchImpl: async () => jsonResponse(activeSnapshot()), doc: makeDocument() });
  t.after(env.restore);

  const first = [];
  const second = [];
  const unsubscribeFirst = store.subscribeMemoryStatus((snapshot) => first.push(snapshot), { poll: true });
  const unsubscribeSecond = store.subscribeMemoryStatus((snapshot) => second.push(snapshot), { poll: true });
  t.after(() => { unsubscribeFirst(); unsubscribeSecond(); });

  assert.equal(env.intervals.size, 1, "two polling subscribers share exactly one loop");

  await store.refreshMemoryStatus();
  assert.equal(store.getMemoryStatusSnapshot().status.targetMiB, 1500);
  assert.equal(first.at(-1).status.targetMiB, 1500);
  assert.equal(second.at(-1).status.targetMiB, 1500);
  assert.equal(first.at(-1), second.at(-1), "both surfaces render the same snapshot object");
  assert.equal(env.intervals.size, 1, "still exactly one loop after the read");

  unsubscribeFirst();
  assert.equal(env.intervals.size, 1, "one polling subscriber still keeps the loop alive");
  unsubscribeSecond();
  assert.equal(env.intervals.size, 0, "the last subscriber stops the loop");
});

test("concurrent reads share a single request", async (t) => {
  let calls = 0;
  const env = installGlobals({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return jsonResponse(activeSnapshot());
    },
    doc: makeDocument(),
  });
  t.after(env.restore);

  await Promise.all([
    store.refreshMemoryStatus(),
    store.refreshMemoryStatus(),
    store.refreshMemoryStatus(),
  ]);
  assert.equal(calls, 1, "the in-flight request is deduped");
});

test("a subscriber that does not want polling never starts the loop", async (t) => {
  const env = installGlobals({ fetchImpl: async () => jsonResponse(activeSnapshot()), doc: makeDocument() });
  t.after(env.restore);

  const seen = [];
  const unsubscribe = store.subscribeMemoryStatus((snapshot) => seen.push(snapshot), { poll: false });
  t.after(unsubscribe);
  assert.equal(env.intervals.size, 0);

  await store.refreshMemoryStatus();
  assert.equal(seen.at(-1).status.targetMiB, 1500, "a non-polling subscriber still receives broadcasts");
  assert.equal(env.intervals.size, 0, "reading once never starts a loop");

  unsubscribe();
  assert.equal(env.intervals.size, 0);
});

test("a save is broadcast to every subscriber without waiting for a poll", async (t) => {
  let saved = false;
  let putBody = null;
  let putHeaders = null;
  let getCalls = 0;
  const env = installGlobals({
    fetchImpl: async (url, init) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body);
        putHeaders = init.headers;
        saved = true;
        return jsonResponse({ targetMiB: 2048, defaultMiB: 1500, minMiB: 256, maxMiB: 16384, nearRatio: 0.9 });
      }
      getCalls += 1;
      return jsonResponse(activeSnapshot(saved ? 2048 : 1500));
    },
    doc: makeDocument(),
  });
  t.after(env.restore);

  const chat = [];
  const settings = [];
  const unsubscribeChat = store.subscribeMemoryStatus((snapshot) => chat.push(snapshot), { poll: true });
  const unsubscribeSettings = store.subscribeMemoryStatus((snapshot) => settings.push(snapshot), { poll: true });
  t.after(() => { unsubscribeChat(); unsubscribeSettings(); });

  await store.refreshMemoryStatus();
  assert.equal(chat.at(-1).status.targetMiB, 1500);

  await store.putMemoryTarget(2048);
  assert.equal(putBody.targetMiB, 2048);
  assert.equal(putHeaders["x-pi-web-lite"], "1", "a Lite tab sends the header the route requires");

  assert.equal(chat.at(-1).status.targetMiB, 2048, "the chat surface saw the save without a poll");
  assert.equal(settings.at(-1).status.targetMiB, 2048);
  assert.ok(getCalls >= 1, "the save reconciles against a fresh reading");

  unsubscribeChat();
  unsubscribeSettings();
});

test("polling pauses while the document is hidden and resumes when visible", async (t) => {
  const doc = makeDocument("hidden");
  const env = installGlobals({ fetchImpl: async () => jsonResponse(activeSnapshot()), doc });
  t.after(env.restore);

  const unsubscribe = store.subscribeMemoryStatus(() => {}, { poll: true });
  t.after(unsubscribe);
  assert.equal(env.intervals.size, 0, "a hidden tab does not poll");
  assert.equal(doc.listenerCount("visibilitychange"), 1, "one shared visibility listener");

  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  assert.equal(env.intervals.size, 1, "a visible tab polls");

  doc.visibilityState = "hidden";
  doc.emit("visibilitychange");
  assert.equal(env.intervals.size, 0, "hiding again stops the loop");

  unsubscribe();
  assert.equal(doc.listenerCount("visibilitychange"), 0, "the last subscriber detaches the listener");
});
