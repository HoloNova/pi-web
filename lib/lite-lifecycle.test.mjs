import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  LITE_INTERACTION_EVENTS,
  liteIdleDeadlineIn,
  liteIdleMinutesToMs,
  shouldHoldLitePresence,
} = await jiti.import("./lite-lifecycle.ts");
const { DEFAULT_LITE_IDLE_MINUTES, MAX_LITE_IDLE_MINUTES, MIN_LITE_IDLE_MINUTES } =
  await jiti.import("./lite-config.ts");

const base = {
  enabled: true,
  mounted: true,
  lastInteractionAt: 1_000_000,
  now: 1_000_000,
  idleTimeoutMs: liteIdleMinutesToMs(DEFAULT_LITE_IDLE_MINUTES),
};

test("the idle window comes from the instance configuration, five minutes by default", () => {
  assert.equal(DEFAULT_LITE_IDLE_MINUTES, 5);
  assert.equal(liteIdleMinutesToMs(DEFAULT_LITE_IDLE_MINUTES), 5 * 60_000);
  assert.equal(MIN_LITE_IDLE_MINUTES, 1);
  assert.equal(MAX_LITE_IDLE_MINUTES, 60);
});

test("interaction events exclude heartbeats, polling and SSE", () => {
  assert.deepEqual([...LITE_INTERACTION_EVENTS], ["pointerdown", "keydown", "touchstart", "wheel"]);
  for (const notInteraction of ["message", "visibilitychange", "online", "scroll", "mousemove"]) {
    assert.equal(LITE_INTERACTION_EVENTS.includes(notInteraction), false);
  }
});

test("holds presence while enabled, mounted and recently touched", () => {
  assert.equal(shouldHoldLitePresence(base), true);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + base.idleTimeoutMs - 1 }), true);
});

test("drops presence once disabled, unmounted or idle for the configured window", () => {
  assert.equal(shouldHoldLitePresence({ ...base, enabled: false }), false);
  assert.equal(shouldHoldLitePresence({ ...base, mounted: false }), false);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + base.idleTimeoutMs }), false);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + base.idleTimeoutMs * 2 }), false);
});

test("the idle window is a parameter: a shorter one releases sooner", () => {
  const shortWindow = { ...base, idleTimeoutMs: liteIdleMinutesToMs(1) };
  assert.equal(shouldHoldLitePresence({ ...shortWindow, now: base.lastInteractionAt + 60_000 }), false);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + 60_000 }), true);
  // A non-positive or non-finite window never holds.
  assert.equal(shouldHoldLitePresence({ ...base, idleTimeoutMs: 0 }), false);
  assert.equal(shouldHoldLitePresence({ ...base, idleTimeoutMs: -1 }), false);
  assert.equal(shouldHoldLitePresence({ ...base, idleTimeoutMs: NaN }), false);
});

test("a hidden but recently interacted page still holds presence", () => {
  // Hiding the page is not an input to the rule, so even an explicit
  // `visible: false` cannot flip the verdict: a hidden tab stays warm.
  assert.equal(shouldHoldLitePresence({ ...base, visible: false }), true);
  assert.equal(
    shouldHoldLitePresence({ ...base, visible: false, now: base.lastInteractionAt + 60_000 }),
    true,
  );
});

test("a hidden page past the idle deadline releases", () => {
  assert.equal(
    shouldHoldLitePresence({ ...base, visible: false, now: base.lastInteractionAt + base.idleTimeoutMs }),
    false,
  );
});

test("the pure rule carries no visibility input, so a visibility change alone never releases", async () => {
  const source = await readFile(new URL("./lite-lifecycle.ts", import.meta.url), "utf8");
  const interfaceStart = source.indexOf("export interface LitePresenceInput");
  const inputBlock = source.slice(interfaceStart, source.indexOf("}", interfaceStart) + 1);
  assert.doesNotMatch(inputBlock, /visib/i, "the input type must not carry a dead visibility field");

  const rule = source.slice(
    source.indexOf("export function shouldHoldLitePresence"),
    source.indexOf("export function liteIdleDeadlineIn"),
  );
  assert.doesNotMatch(rule, /visib|document\./i, "the verdict must not depend on page visibility");
});

test("the idle window is not stored here any more", async () => {
  // It is a server-wide setting now (lib/lite-config.ts + /api/lite); this
  // module must not grow its own copy of storage or parsing helpers.
  const source = await readFile(new URL("./lite-lifecycle.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|parseLiteIdleMinutes|isValidLiteIdleMinutes/);
});

test("computes the remaining idle time, never negative", () => {
  const window = liteIdleMinutesToMs(DEFAULT_LITE_IDLE_MINUTES);
  assert.equal(liteIdleDeadlineIn(1000, 1000, window), window);
  assert.equal(liteIdleDeadlineIn(1000, 1000 + 60_000, window), window - 60_000);
  assert.equal(liteIdleDeadlineIn(1000, 1000 + window + 5, window), 0);
  // The configured window scales the deadline.
  assert.equal(liteIdleDeadlineIn(1000, 1000, liteIdleMinutesToMs(1)), 60_000);
});
