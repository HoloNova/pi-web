import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * Contract checks for the memory policy's public surface.
 *
 * The measurement (lib/service-memory.test.mjs), the pressure thresholds
 * (lib/memory-pressure.test.mjs), the reclaim ordering
 * (lib/lite-memory-reclaim.test.mjs) and the policy tick
 * (lib/lite-memory-monitor.test.mjs) are tested directly. What is left to pin
 * down here is where the policy lives: the status read observes only, and the
 * thing that closes sessions is the server's own monitor — not a request.
 */
const read = (path) => readFile(join(process.cwd(), path), "utf8");

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const exists = async (path) => read(path).then(() => true, () => false);

test("the status read observes only: it measures and never walks sessions", async () => {
  const source = stripComments(await read("app/api/memory/route.ts"));
  assert.match(source, /readLiteConfig\(\)/);
  assert.match(source, /readServiceMemoryReading\(\)/);
  assert.match(source, /memoryPressureState\(/);

  // Nothing that closes a session, and nothing that has to look at one: the
  // reclaim pass owns that work, and only the monitor calls it.
  assert.doesNotMatch(source, /runMemoryPressureReclaim\(/);
  assert.doesNotMatch(source, /collectMemoryReclaimCandidates\(/);
  assert.doesNotMatch(source, /planIdleReclaim\(/);
});

test("the policy lives in the server monitor, not behind a request", async () => {
  const monitor = stripComments(await read("lib/lite-memory-monitor.ts"));
  assert.match(monitor, /runMemoryPressureReclaim\(\)/);
  assert.match(monitor, /memoryPressureState\(/);
  // One monitor per process, and a timer that never keeps the process open.
  assert.match(monitor, /__piWebLiteMemoryMonitor/);
  assert.match(monitor, /timer\.unref\?\.\(\)/);

  const boot = stripComments(await read("instrumentation-node.ts"));
  assert.match(boot, /startLiteMemoryMonitor\(\)/);

  // The browser-driven path is gone: no endpoint asks for a pass, and the
  // status route has no POST.
  assert.equal(await exists("app/api/memory/reclaim/route.ts"), false);
  assert.doesNotMatch(stripComments(await read("app/api/memory/route.ts")), /export async function POST/);
});
