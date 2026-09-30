import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Route checks for GET/PUT /api/lite. The agent dir is redirected to a temp
 * location, so the test never reads or writes the operator's own settings.
 */
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-lite-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { DEFAULT_LITE_CONFIG, LITE_CONFIG_BOUNDS, MAX_LITE_IDLE_MINUTES } =
  await jiti.import(join(process.cwd(), "lib/lite-config.ts"));
const { LITE_SETTINGS_FILE_NAME } = await jiti.import(join(process.cwd(), "lib/lite-config-settings.ts"));

const settingsPath = join(testAgentDir, LITE_SETTINGS_FILE_NAME);

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body, { headers = {}, host = "localhost" } = {}) {
  return new Request(`http://${host}/api/lite`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: host, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readSettings() {
  return existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : null;
}

test("a read reports the stored configuration with its bounds and never writes", async (t) => {
  t.after(async () => { await rm(settingsPath, { force: true }); });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const body = await response.json();
  assert.equal(body.enabled, DEFAULT_LITE_CONFIG.enabled);
  assert.equal(body.idleMinutes, DEFAULT_LITE_CONFIG.idleMinutes);
  assert.equal(body.memoryTargetMiB, DEFAULT_LITE_CONFIG.memoryTargetMiB);
  assert.deepEqual(body.bounds, LITE_CONFIG_BOUNDS);

  // Observation only: reading must not create or change the file.
  assert.equal(existsSync(settingsPath), false);
});

test("a read reports what the file holds", async (t) => {
  await writeFile(settingsPath, JSON.stringify({ version: 1, lite: { enabled: true, idleMinutes: 22 } }), "utf8");
  t.after(async () => { await rm(settingsPath, { force: true }); });

  const body = await (await GET()).json();
  assert.equal(body.enabled, true);
  assert.equal(body.idleMinutes, 22);
  assert.equal(body.memoryTargetMiB, DEFAULT_LITE_CONFIG.memoryTargetMiB);
});

test("a write changes only the fields it was given", async (t) => {
  await writeFile(settingsPath, JSON.stringify({ version: 1, lite: { idleMinutes: 30 } }), "utf8");
  t.after(async () => { await rm(settingsPath, { force: true }); });

  const response = await PUT(put({ enabled: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.idleMinutes, 30, "a field outside the patch keeps its stored value");
  assert.deepEqual(body.bounds, LITE_CONFIG_BOUNDS);

  const stored = await readSettings();
  assert.equal(stored.lite.enabled, true);
  assert.equal(stored.lite.idleMinutes, 30);

  // The stored value is what a later read reports.
  assert.equal((await (await GET()).json()).enabled, true);
});

test("a write that changes nothing else still answers with the whole configuration", async (t) => {
  t.after(async () => { await rm(settingsPath, { force: true }); });
  const body = await (await PUT(put({ idleMinutes: MAX_LITE_IDLE_MINUTES }))).json();
  assert.deepEqual(body, {
    enabled: DEFAULT_LITE_CONFIG.enabled,
    idleMinutes: MAX_LITE_IDLE_MINUTES,
    memoryTargetMiB: DEFAULT_LITE_CONFIG.memoryTargetMiB,
    extensionModels: DEFAULT_LITE_CONFIG.extensionModels,
    bounds: LITE_CONFIG_BOUNDS,
  });
});

test("the extension-model switch is a stored boolean like the others", async (t) => {
  t.after(async () => { await rm(settingsPath, { force: true }); });
  const on = await (await PUT(put({ extensionModels: true }))).json();
  assert.equal(on.extensionModels, true);
  // A partial write: the mode and the ranges are untouched.
  assert.equal(on.enabled, DEFAULT_LITE_CONFIG.enabled);
  assert.equal(on.idleMinutes, on.bounds.idleMinutes.default);

  const offAgain = await (await PUT(put({ extensionModels: false }))).json();
  assert.equal(offAgain.extensionModels, false);

  const bad = await PUT(put({ extensionModels: "on" }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /extensionModels must be a boolean/);
});

test("out-of-range and unknown fields are refused with the range in the message", async (t) => {
  await writeFile(settingsPath, JSON.stringify({ version: 1, lite: { idleMinutes: 9 } }), "utf8");
  t.after(async () => { await rm(settingsPath, { force: true }); });
  const before = await readFile(settingsPath, "utf8");

  const tooLong = await PUT(put({ idleMinutes: MAX_LITE_IDLE_MINUTES + 1 }));
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /idleMinutes must be a whole number between 1 and 60/);

  const fractional = await PUT(put({ memoryTargetMiB: 12.5 }));
  assert.equal(fractional.status, 400);
  assert.match((await fractional.json()).error, /memoryTargetMiB/);

  const wrongType = await PUT(put({ enabled: "on" }));
  assert.equal(wrongType.status, 400);
  assert.match((await wrongType.json()).error, /enabled/);

  const empty = await PUT(put({}));
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /at least one of/);

  const notAConfig = await PUT(put("[]"));
  assert.equal(notAConfig.status, 400);

  assert.equal(await readFile(settingsPath, "utf8"), before, "a refused write leaves the file alone");
});

test("a write needs JSON and a trusted host", async (t) => {
  t.after(async () => { await rm(settingsPath, { force: true }); });

  const wrongContentType = await PUT(new Request("http://localhost/api/lite", {
    method: "PUT",
    headers: { "Content-Type": "text/plain", Host: "localhost" },
    body: "enabled=true",
  }));
  assert.equal(wrongContentType.status, 415);

  // The same request-security check every mutating route uses: an untrusted
  // Host is refused, so config cannot be changed cross-site.
  const untrustedHost = await PUT(put({ enabled: true }, { host: "evil.example" }));
  assert.equal(untrustedHost.status, 403);
  assert.equal(existsSync(settingsPath), false);

  const crossSite = await PUT(put({ enabled: true }, {
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  }));
  assert.equal(crossSite.status, 403);
  assert.equal(existsSync(settingsPath), false);
});
