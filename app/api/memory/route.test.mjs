import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * Contract checks for the two memory endpoints.
 *
 * The measurement (lib/service-memory.test.mjs), the pressure policy
 * (lib/memory-pressure.test.mjs) and the reclaim ordering
 * (lib/lite-memory-reclaim.test.mjs) are tested directly; what is left — and
 * what needs pinning down — is which of the two endpoints is allowed to act,
 * and that neither of them acts outside Lite mode.
 */
const read = (path) => readFile(join(process.cwd(), path), "utf8");

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("a read reports, and never closes anything", async () => {
  const source = stripComments(await read("app/api/memory/route.ts"));
  assert.doesNotMatch(source, /runMemoryPressureReclaim\(/);
  // It may *count* what a pass could close; the closing itself lives in the
  // other endpoint, so a read cannot change how the service behaves.
  assert.match(source, /collectMemoryReclaimCandidates\(\)/);
  assert.match(source, /readServiceMemoryReading\(\)/);
  assert.match(source, /memoryPressureState\(/);
});

test("the reclaim pass is the only thing that acts, on request", async () => {
  const source = stripComments(await read("app/api/memory/reclaim/route.ts"));
  assert.match(source, /runMemoryPressureReclaim\(\)/);
  assert.match(source, /export async function POST/);
  // Trusted-host check first, then the mode gate: a normal-mode instance never
  // closes a session its operator did not ask Lite mode to close.
  const security = source.indexOf("isApiRequestAllowed(req)");
  const modeGate = source.indexOf("readLiteConfig().enabled");
  assert.ok(security !== -1 && modeGate !== -1 && security < modeGate);
});
