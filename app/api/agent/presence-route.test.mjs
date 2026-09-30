import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Route checks for POST /api/agent/[id]/presence. The agent dir is redirected
 * to a temp location, so the Lite configuration this route reads is the test's,
 * never the operator's.
 */
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-presence-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const settingsPath = join(testAgentDir, "pi-web-settings.json");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import(join(process.cwd(), "app/api/agent/[id]/presence/route.ts"));
const { hasActiveSessionPresence } = await jiti.import(join(process.cwd(), "lib/session-liveness.ts"));

const sessionId = "presence-route-session";
const routeContext = { params: Promise.resolve({ id: sessionId }) };

function request(body, { host = "localhost", headers = {} } = {}) {
  return new Request(`http://${host}/api/agent/${sessionId}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

async function setLiteEnabled(enabled) {
  await writeFile(settingsPath, JSON.stringify({ version: 1, lite: { enabled, idleMinutes: 5 } }), "utf8");
}

test("acquire, renew and release drive per-page presence", async () => {
  await setLiteEnabled(true);

  let response = await POST(request({ clientId: "tab-a", action: "acquire" }), routeContext);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, viewed: true });
  assert.equal(hasActiveSessionPresence(sessionId), true);

  response = await POST(request({ clientId: "tab-a", action: "renew" }), routeContext);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).viewed, true);

  // A second page does not replace the first.
  await POST(request({ clientId: "tab-b", action: "acquire" }), routeContext);
  await POST(request({ clientId: "tab-a", action: "release" }), routeContext);
  assert.equal(hasActiveSessionPresence(sessionId), true);

  response = await POST(request({ clientId: "tab-b", action: "release" }), routeContext);
  assert.equal((await response.json()).viewed, false);
  assert.equal(hasActiveSessionPresence(sessionId), false);
});

test("rejects a missing client id, an unknown action and invalid JSON", async () => {
  await setLiteEnabled(true);

  assert.equal((await POST(request({ action: "acquire" }), routeContext)).status, 400);
  assert.equal((await POST(request({ clientId: "  ", action: "acquire" }), routeContext)).status, 400);
  assert.equal((await POST(request({ clientId: "tab-a", action: "bogus" }), routeContext)).status, 400);
  assert.equal((await POST(request("not json"), routeContext)).status, 400);
  assert.equal((await POST(request({ clientId: "x".repeat(200), action: "acquire" }), routeContext)).status, 400);
});

test("presence is refused while the instance runs in normal mode", async () => {
  await setLiteEnabled(false);

  const response = await POST(request({ clientId: "tab-a", action: "acquire" }), routeContext);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Lite mode/);
  assert.equal(hasActiveSessionPresence(sessionId), false);
});

test("an untrusted host or a cross-site request cannot claim or drop presence", async () => {
  await setLiteEnabled(true);

  const untrustedHost = await POST(request({ clientId: "tab-a", action: "acquire" }, { host: "evil.example" }), routeContext);
  assert.equal(untrustedHost.status, 403);

  const crossSite = await POST(request(
    { clientId: "tab-a", action: "release" },
    { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } },
  ), routeContext);
  assert.equal(crossSite.status, 403);

  assert.equal(hasActiveSessionPresence(sessionId), false);
});
