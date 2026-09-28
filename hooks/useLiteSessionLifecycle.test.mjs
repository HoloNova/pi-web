import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./useLiteSessionLifecycle.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("presence is held per tab and released through the presence endpoint", () => {
  assert.match(source, /createLitePresenceController\(getClientId\(\)/);
  assert.match(source, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sessionId\)\}\/presence`/);
  assert.match(source, /body: JSON\.stringify\(\{ clientId, action \}\)/);
  // Page hide releases immediately; the TTL fallback covers a tab that dies.
  assert.match(source, /addEventListener\("pagehide", onPageHide\)/);
  assert.match(source, /controller\.release\(sid, \{ immediate: true \}\)/);
});

test("renews on an interval and follows the pure five-minute rule", () => {
  assert.match(source, /LITE_PRESENCE_RENEW_INTERVAL_MS = 30_000/);
  assert.match(source, /setInterval\(\(\) => controller\.renew\(sid\), LITE_PRESENCE_RENEW_INTERVAL_MS\)/);
  assert.match(source, /shouldHoldLitePresence\(\{/);
  assert.match(source, /liteIdleDeadlineIn\(lastInteractionAt, Date\.now\(\)\)/);
  assert.match(source, /for \(const event of LITE_INTERACTION_EVENTS\) \{/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibility\)/);
});

test("a hidden page keeps holding: the verdict takes no visibility input", () => {
  const evaluate = source.slice(source.indexOf("const evaluate = () =>"), source.indexOf("const scheduleIdle ="));
  assert.match(evaluate, /shouldHoldLitePresence\(\{/);
  assert.match(evaluate, /lastInteractionAt,/);
  assert.match(evaluate, /now: Date\.now\(\)/);
  // Hidden-but-recent holds, stale releases — both through the idle deadline
  // alone, never through the page's visibility.
  assert.doesNotMatch(evaluate, /visibilityState|visible:/);
  assert.doesNotMatch(source, /visibilityState/);
});

test("a visibility change only re-evaluates; it never releases by itself", () => {
  const visibilityHandler = source.slice(source.indexOf("const onVisibility ="), source.indexOf("const onPageHide ="));
  assert.match(visibilityHandler, /scheduleIdle\(\);\s*evaluate\(\);/);
  assert.doesNotMatch(visibilityHandler, /controller\.(release|hold)/);
});

test("does not dispose the controller on unmount, so Strict Mode remounts survive", () => {
  // The cleanup must release through the debounced path; an immediate dispose
  // here would race the effect re-running under Strict Mode.
  assert.doesNotMatch(source, /controllerRef\.current\?\.dispose\(\)/);
  const cleanup = source.slice(source.indexOf("return () => {"), source.indexOf("  }, [enabled, sessionId])"));
  assert.match(cleanup, /controller\.release\(sid\);/);
  assert.match(cleanup, /onHoldChangeRef\.current\(false, sid\)/);
});

test("never touches presence when Lite mode is off", () => {
  assert.match(source, /if \(!enabled \|\| !sessionId \|\| !controller\) return;/);
});
