import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Route-level checks for the Lite model reads and the write guard.
 *
 * The coding-agent package is aliased to a stub, so the tests prove which
 * factory a route picked without loading the real SDK (and therefore without
 * loading an extension). The stub records through `globalThis` because jiti
 * runs without a module cache, and it points `getAgentDir()` at a temp
 * directory so the real credential store and the Lite settings file live there
 * instead of in the operator's agent dir.
 *
 * Which catalog a route serves follows the *instance's* Lite setting (the
 * server's own configuration), never a request: no client can ask for the
 * extension-loading catalog.
 */
const SDK_STUB = `
function provider(id, name, { oauth, apiKeyLogin }) {
  return {
    id,
    name,
    auth: {
      ...(apiKeyLogin ? { apiKey: { login: async ({ prompt }) => ({ type: "api_key", providerId: id, apiKey: await prompt({ type: "secret" }) }) } } : {}),
      ...(oauth ? { oauth: { name: name + " (OAuth)" } } : {}),
    },
  };
}
function runtime() {
  const providers = [
    provider("anthropic", "Anthropic", { oauth: true, apiKeyLogin: true }),
    provider("openai", "OpenAI", { oauth: false, apiKeyLogin: true }),
  ];
  return {
    getModels: () => [],
    getError: () => null,
    listCredentials: async () => [],
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
  };
}
export const calls = globalThis.__piWebSdkCalls ?? (globalThis.__piWebSdkCalls = []);
export function createAgentSessionServices() {
  calls.push("createAgentSessionServices");
  return { modelRuntime: runtime() };
}
export function getAgentDir() { return globalThis.__piWebAgentDir; }
export class ModelRuntime {
  static async create() {
    calls.push("ModelRuntime.create");
    return runtime();
  }
}
`;

async function makeJiti(lite, extensionModels = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lite-routes-"));
  const agentDir = join(dir, "agent");
  const stubPath = join(dir, "pi-coding-agent-stub.mjs");
  await writeFile(stubPath, SDK_STUB, "utf8");
  await mkdir(agentDir, { recursive: true });
  // lib/lite-config-settings.ts reads this file from the agent dir.
  await writeFile(
    join(agentDir, "pi-web-settings.json"),
    JSON.stringify({ version: 1, lite: { enabled: lite, extensionModels } }),
    "utf8",
  );
  globalThis.__piWebAgentDir = agentDir;
  globalThis.__piWebSdkCalls = [];
  const jiti = createJiti(import.meta.url, {
    alias: { "@earendil-works/pi-coding-agent": stubPath },
    tsconfigPaths: true,
    interopDefault: true,
    moduleCache: false,
  });
  return { jiti, agentDir, calls: () => globalThis.__piWebSdkCalls };
}

test("the provider list follows the instance's Lite setting", async () => {
  const liteRun = await makeJiti(true);
  const { GET } = await liteRun.jiti.import(join(process.cwd(), "app/api/auth/providers/route.ts"));

  const lite = await GET();
  assert.equal(lite.status, 200);
  const liteBody = await lite.json();
  // Dual-auth providers appear once in each list (#309), served from the Lite
  // catalog without loading a single extension.
  assert.deepEqual(liteBody.oauthProviders.map((p) => p.id), ["anthropic"]);
  assert.deepEqual(liteBody.apiKeyProviders.map((p) => p.id), ["anthropic", "openai"]);
  assert.deepEqual(liteRun.calls(), ["ModelRuntime.create"]);

  const normalRun = await makeJiti(false);
  const normalGET = (await normalRun.jiti.import(join(process.cwd(), "app/api/auth/providers/route.ts"))).GET;
  const normal = await normalGET();
  assert.equal(normal.status, 200);
  assert.deepEqual(normalRun.calls(), ["createAgentSessionServices"]);
});

test("API-key login for a built-in provider needs no extension load in Lite mode", async () => {
  const { jiti, agentDir, calls } = await makeJiti(true);
  const { POST } = await jiti.import(join(process.cwd(), "app/api/auth/api-key/[provider]/route.ts"));

  const response = await POST(new Request("http://localhost/api/auth/api-key/anthropic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-test" }),
  }), { params: Promise.resolve({ provider: "anthropic" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(calls(), ["ModelRuntime.create"]);
  // End to end: the key reached the credential store, at the stubbed agent dir.
  const stored = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
  assert.deepEqual(Object.keys(stored), ["anthropic"]);
  assert.equal(stored.anthropic.apiKey, "sk-test");
});

test("the model reads pick their runtime from the instance setting", async () => {
  const modelsRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const providersRoute = await readFile(new URL("../auth/providers/route.ts", import.meta.url), "utf8");

  // Lite reads never import the extension set; normal reads still do.
  assert.match(modelsRoute, /const lite = readsUseLiteCatalog\(\)/);
  assert.match(modelsRoute, /read\(await createLiteModelRuntime\(\), SettingsManager\.create\(cwd, agentDir\)\)/);
  assert.match(modelsRoute, /withExtensionServices\(/);
  // The cache key carries the mode, so a Lite load cannot serve a normal read.
  assert.match(modelsRoute, /modelsCacheKey\(cwd, lite\)/);

  // The runtime choice itself lives in lib/model-runtime.ts now, so the routes
  // ask for the catalogue instead of naming the setting.
  assert.match(providersRoute, /withCatalogRuntime\(/);
  assert.doesNotMatch(providersRoute, /createLiteModelRuntime\(|createModelRuntimeWithExtensions\(/);
});

test("the enabledModels write path always resolves against the full catalog", async () => {
  const source = await readFile(new URL("./enabled/route.ts", import.meta.url), "utf8");
  const put = source.slice(source.indexOf("export async function PUT"));

  // GET describes the instance's catalog; PUT never does.
  assert.match(source, /withCatalogRuntime\(async \(modelRuntime\) => \{\s*\n\s+return Response\.json\(await buildView\(await loadContext\(resolved\.cwd, modelRuntime\)\)\);/);
  assert.match(put, /if \(!readsUseLiteCatalog\(\)\) return Response\.json\(await buildView\(context\)\)/);
  assert.match(put, /withExtensionRuntime\(async \(modelRuntime\) => \{\s*\n\s+const context = await loadContext\(resolved\.cwd, modelRuntime\)/);
  // The edit is computed from that full context; only the returned view follows
  // the mode, so a Lite panel keeps describing the Lite catalog.
  assert.match(put, /return await withCatalogRuntime\(async \(viewRuntime\) =>/);
  assert.match(put, /withExtensionRuntime\(async \(modelRuntime\) => \{\n\s+const context = await loadContext\(resolved\.cwd, modelRuntime\)/);
});

test("the extension-model switch puts the reads back on the full catalogue", async () => {
  // Normal mode and a Lite instance with the switch on must both load the
  // extensions that register providers; only Lite-without-the-switch does not.
  for (const [lite, extensionModels, expected] of [
    [true, false, ["ModelRuntime.create"]],
    [true, true, ["createAgentSessionServices"]],
    [false, false, ["createAgentSessionServices"]],
  ]) {
    const run = await makeJiti(lite, extensionModels);
    const { GET } = await run.jiti.import(join(process.cwd(), "app/api/auth/providers/route.ts"));
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(run.calls(), expected, `lite=${lite} extensionModels=${extensionModels}`);
  }
});
