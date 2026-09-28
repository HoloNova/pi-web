import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  LITE_IDLE_PRESENCE_TIMEOUT_MS,
  LITE_INTERACTION_EVENTS,
  liteIdleDeadlineIn,
  shouldHoldLitePresence,
} = await jiti.import("./lite-lifecycle.ts");

const base = {
  enabled: true,
  mounted: true,
  lastInteractionAt: 1_000_000,
  now: 1_000_000,
};

test("the Lite idle window is five minutes", () => {
  assert.equal(LITE_IDLE_PRESENCE_TIMEOUT_MS, 5 * 60 * 1000);
});

test("interaction events exclude heartbeats, polling and SSE", () => {
  assert.deepEqual([...LITE_INTERACTION_EVENTS], ["pointerdown", "keydown", "touchstart", "wheel"]);
  for (const notInteraction of ["message", "visibilitychange", "online", "scroll", "mousemove"]) {
    assert.equal(LITE_INTERACTION_EVENTS.includes(notInteraction), false);
  }
});

test("holds presence while enabled, mounted and recently touched", () => {
  assert.equal(shouldHoldLitePresence(base), true);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + LITE_IDLE_PRESENCE_TIMEOUT_MS - 1 }), true);
});

test("drops presence once disabled, unmounted or idle for five minutes", () => {
  assert.equal(shouldHoldLitePresence({ ...base, enabled: false }), false);
  assert.equal(shouldHoldLitePresence({ ...base, mounted: false }), false);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + LITE_IDLE_PRESENCE_TIMEOUT_MS }), false);
  assert.equal(shouldHoldLitePresence({ ...base, now: base.lastInteractionAt + LITE_IDLE_PRESENCE_TIMEOUT_MS * 2 }), false);
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
    shouldHoldLitePresence({ ...base, visible: false, now: base.lastInteractionAt + LITE_IDLE_PRESENCE_TIMEOUT_MS }),
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

test("computes the remaining idle time, never negative", () => {
  assert.equal(liteIdleDeadlineIn(1000, 1000), LITE_IDLE_PRESENCE_TIMEOUT_MS);
  assert.equal(liteIdleDeadlineIn(1000, 1000 + 60_000), LITE_IDLE_PRESENCE_TIMEOUT_MS - 60_000);
  assert.equal(liteIdleDeadlineIn(1000, 1000 + LITE_IDLE_PRESENCE_TIMEOUT_MS + 5), 0);
});
