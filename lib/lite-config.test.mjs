import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  DEFAULT_LITE_CONFIG,
  LITE_CONFIG_BOUNDS,
  MAX_LITE_IDLE_MINUTES,
  MAX_MEMORY_TARGET_MIB,
  MIN_LITE_IDLE_MINUTES,
  MIN_MEMORY_TARGET_MIB,
  coerceLiteConfig,
  isValidLiteIdleMinutes,
  isValidMemoryTargetMiB,
} = await jiti.import(join(process.cwd(), "lib/lite-config.ts"));
const { LITE_SETTINGS_FILE_NAME, LITE_SETTINGS_VERSION, getLiteSettingsPath, readLiteConfig, readsUseLiteCatalog, writeLiteConfig } =
  await jiti.import(join(process.cwd(), "lib/lite-config-settings.ts"));

const workDir = await mkdtemp(join(tmpdir(), "pi-web-lite-config-"));
after(async () => { await rm(workDir, { recursive: true, force: true }); });

let counter = 0;
function settingsPath(name) {
  counter += 1;
  return join(workDir, `${name}-${counter}.json`);
}

async function writeSettings(path, body) {
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
}

test("the settings file name and path belong to Pi-Web", () => {
  assert.equal(LITE_SETTINGS_FILE_NAME, "pi-web-settings.json");
  assert.equal(getLiteSettingsPath("/somewhere/agent"), join("/somewhere/agent", LITE_SETTINGS_FILE_NAME));
});

test("a missing file reads as the defaults", async () => {
  const config = readLiteConfig(settingsPath("missing"));
  assert.deepEqual(config, DEFAULT_LITE_CONFIG);
  // A fresh install starts disabled, with the documented idle window and target.
  assert.equal(config.enabled, false);
  assert.equal(config.idleMinutes, LITE_CONFIG_BOUNDS.idleMinutes.default);
  assert.equal(config.memoryTargetMiB, LITE_CONFIG_BOUNDS.memoryTargetMiB.default);
});

test("stored values win, anything missing or out of range falls back", async () => {
  const path = settingsPath("partial");
  await writeSettings(path, {
    version: 1,
    lite: { enabled: true, idleMinutes: MAX_LITE_IDLE_MINUTES, memoryTargetMiB: 999999 },
  });
  assert.deepEqual(readLiteConfig(path), {
    enabled: true,
    idleMinutes: MAX_LITE_IDLE_MINUTES,
    memoryTargetMiB: DEFAULT_LITE_CONFIG.memoryTargetMiB,
    extensionModels: false,
  });
});

test("a damaged file never fails a read", async () => {
  const path = settingsPath("damaged");
  await writeSettings(path, "{ not json");
  assert.deepEqual(readLiteConfig(path), DEFAULT_LITE_CONFIG);
});

test("coercion ignores anything that is not a stored configuration", () => {
  assert.deepEqual(coerceLiteConfig(null), DEFAULT_LITE_CONFIG);
  assert.deepEqual(coerceLiteConfig([1, 2]), DEFAULT_LITE_CONFIG);
  assert.deepEqual(coerceLiteConfig({ enabled: "yes", idleMinutes: 2.5 }), DEFAULT_LITE_CONFIG);
  assert.deepEqual(coerceLiteConfig({ enabled: true, idleMinutes: MIN_LITE_IDLE_MINUTES }), {
    enabled: true,
    idleMinutes: MIN_LITE_IDLE_MINUTES,
    memoryTargetMiB: DEFAULT_LITE_CONFIG.memoryTargetMiB,
    extensionModels: false,
  });
});

test("the ranges are whole numbers only", () => {
  assert.equal(isValidLiteIdleMinutes(MIN_LITE_IDLE_MINUTES), true);
  assert.equal(isValidLiteIdleMinutes(MAX_LITE_IDLE_MINUTES), true);
  assert.equal(isValidLiteIdleMinutes(MIN_LITE_IDLE_MINUTES - 1), false);
  assert.equal(isValidLiteIdleMinutes(MAX_LITE_IDLE_MINUTES + 1), false);
  assert.equal(isValidLiteIdleMinutes(5.5), false);
  assert.equal(isValidLiteIdleMinutes("5"), false);
  assert.equal(isValidMemoryTargetMiB(MIN_MEMORY_TARGET_MIB), true);
  assert.equal(isValidMemoryTargetMiB(MAX_MEMORY_TARGET_MIB), true);
  assert.equal(isValidMemoryTargetMiB(MIN_MEMORY_TARGET_MIB - 1), false);
  assert.equal(isValidMemoryTargetMiB(MAX_MEMORY_TARGET_MIB + 1), false);
});

test("a write merges into the file and keeps fields it does not own", async () => {
  const path = settingsPath("merge");
  await writeSettings(path, {
    version: 0,
    keepMe: { from: "another writer" },
    lite: { enabled: true, idleMinutes: 30 },
  });

  const written = writeLiteConfig({ idleMinutes: 1 }, path);
  assert.deepEqual(written, {
    enabled: true,
    idleMinutes: 1,
    memoryTargetMiB: DEFAULT_LITE_CONFIG.memoryTargetMiB,
    extensionModels: false,
  });

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.version, LITE_SETTINGS_VERSION);
  assert.deepEqual(stored.keepMe, { from: "another writer" });
  assert.equal(stored.lite.enabled, true, "a field outside the patch is untouched");
  assert.equal(stored.lite.idleMinutes, 1);
  assert.equal(readLiteConfig(path).idleMinutes, 1);
});

test("an out-of-range write is refused and the file stays as it was", async () => {
  const path = settingsPath("refused");
  await writeSettings(path, { version: 1, lite: { enabled: true, idleMinutes: 12 } });
  const before = await readFile(path, "utf8");

  assert.throws(() => writeLiteConfig({ idleMinutes: MAX_LITE_IDLE_MINUTES + 1 }, path), /idleMinutes/);
  assert.throws(() => writeLiteConfig({ memoryTargetMiB: 12 }, path), /memoryTargetMiB/);
  assert.throws(() => writeLiteConfig({ enabled: "on" }, path), /enabled/);
  assert.throws(() => writeLiteConfig({ extensionModels: "on" }, path), /extensionModels/);

  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(readLiteConfig(path).idleMinutes, 12);
});

test("an unreadable file is never overwritten", async () => {
  const path = settingsPath("unreadable");
  await writeSettings(path, "{ half a file");
  assert.throws(() => writeLiteConfig({ enabled: true }, path));
  assert.equal(await readFile(path, "utf8"), "{ half a file");
});

test("the extension-model list is off by default and only a boolean turns it on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lite-config-"));
  const path = join(dir, LITE_SETTINGS_FILE_NAME);

  assert.equal(readLiteConfig(path).extensionModels, false);
  // A stored non-boolean falls back rather than failing the read.
  await writeFile(path, JSON.stringify({ lite: { extensionModels: "yes" } }), "utf8");
  assert.equal(readLiteConfig(path).extensionModels, false);

  const written = writeLiteConfig({ extensionModels: true }, path);
  assert.equal(written.extensionModels, true);
  // Merging keeps the mode and the other settings where they were.
  assert.equal(written.enabled, readLiteConfig(path).enabled);
  assert.equal(JSON.parse(await readFile(path, "utf8")).lite.extensionModels, true);
});

test("the Lite catalogue is used only when the mode is on and extensions are excluded", async () => {
  for (const [enabled, extensionModels, expected] of [
    [false, false, false],
    [false, true, false],
    [true, false, true],
    [true, true, false],
  ]) {
    const path = settingsPath(`catalog-${enabled}-${extensionModels}`);
    await writeSettings(path, { lite: { enabled, extensionModels } });
    assert.equal(readsUseLiteCatalog(path), expected, `enabled=${enabled} extensionModels=${extensionModels}`);
  }
});
