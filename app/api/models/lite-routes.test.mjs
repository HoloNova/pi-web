import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
 * directory so the real credential store writes there instead of the user's
 * `auth.json`.
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

const LITE_HEADER = { "x-pi-web-lite": "1" };

async function makeJiti() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lite-routes-"));
  const agentDir = join(dir, "agent");
  const stubPath = join(dir, "pi-coding-agent-stub.mjs");
  await writeFile(stubPath, SDK_STUB, "utf8");
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

test("the provider list follows the request's Lite header", async () => {
  const { jiti, calls } = await makeJiti();
  const { GET } = await jiti.import(join(process.cwd(), "app/api/auth/providers/route.ts"));

  const lite = await GET(new Request("http://localhost/api/auth/providers", { headers: LITE_HEADER }));
  assert.equal(lite.status, 200);
  const liteBody = await lite.json();
  // Dual-auth providers appear once in each list (#309), served from the Lite
  // catalog without loading a single extension.
  assert.deepEqual(liteBody.oauthProviders.map((p) => p.id), ["anthropic"]);
  assert.deepEqual(liteBody.apiKeyProviders.map((p) => p.id), ["anthropic", "openai"]);
  assert.deepEqual(calls(), ["ModelRuntime.create"]);

  const normal = await GET(new Request("http://localhost/api/auth/providers"));
  assert.equal(normal.status, 200);
  assert.deepEqual(calls(), ["ModelRuntime.create", "createAgentSessionServices"]);
});

test("API-key login for a built-in provider needs no extension load in Lite mode", async () => {
  const { jiti, agentDir, calls } = await makeJiti();
  const { POST } = await jiti.import(join(process.cwd(), "app/api/auth/api-key/[provider]/route.ts"));

  const response = await POST(new Request("http://localhost/api/auth/api-key/anthropic", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...LITE_HEADER },
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

test("the model reads pick their runtime from the Lite header", async () => {
  const modelsRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const providersRoute = await readFile(new URL("../auth/providers/route.ts", import.meta.url), "utf8");

  // Lite reads never import the extension set; normal reads still do.
  assert.match(modelsRoute, /const lite = isLiteRequest\(req\)/);
  assert.match(modelsRoute, /modelRuntime = await createLiteModelRuntime\(\)/);
  assert.match(modelsRoute, /modelRuntime = services\.modelRuntime/);
  assert.match(modelsRoute, /const services = await createAgentSessionServices\(/);
  // The cache key carries the mode, so a Lite load cannot serve a normal tab.
  assert.match(modelsRoute, /modelsCacheKey\(cwd, lite\)/);

  assert.match(providersRoute, /isLiteRequest\(req\)/);
  assert.match(providersRoute, /await createLiteModelRuntime\(\)/);
  assert.match(providersRoute, /await createModelRuntimeWithExtensions\(\)/);
});

test("the enabledModels write path always resolves against the full catalog", async () => {
  const source = await readFile(new URL("./enabled/route.ts", import.meta.url), "utf8");
  const put = source.slice(source.indexOf("export async function PUT"));

  // GET describes the request's catalog; PUT never does.
  assert.match(source, /buildView\(await loadContext\(resolved\.cwd, isLiteRequest\(req\)\)\)/);
  assert.match(put, /const lite = isLiteRequest\(req\)/);
  assert.match(put, /const context = await loadContext\(resolved\.cwd, false\)/);
  // The edit is computed from that full context; only the returned view follows
  // the mode, so a Lite panel keeps describing the Lite catalog.
  assert.match(put, /const viewContext = lite \? await loadContext\(resolved\.cwd, true\) : context/);
  assert.doesNotMatch(put, /loadContext\(resolved\.cwd, isLiteRequest\(req\)\)/);
});
