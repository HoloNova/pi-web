import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  MEMORY_TARGET_FILE_NAME,
  getMemoryTargetSettingsPath,
  readMemoryTargetMiB,
  writeMemoryTargetMiB,
} = await jiti.import("./memory-target-settings.ts");
const { DEFAULT_MEMORY_TARGET_MIB } = await jiti.import("./memory-target.ts");

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-memory-"));
  return join(dir, "agent", MEMORY_TARGET_FILE_NAME);
}

test("Pi-Web owns its own file under the agent dir", () => {
  assert.equal(MEMORY_TARGET_FILE_NAME, "pi-web-memory.json");
  assert.equal(getMemoryTargetSettingsPath("/tmp/agent"), join("/tmp/agent", "pi-web-memory.json"));
});

test("a missing file reads the default", () => {
  assert.equal(
    readMemoryTargetMiB(join(tmpdir(), "pi-web-memory-absent", MEMORY_TARGET_FILE_NAME)),
    DEFAULT_MEMORY_TARGET_MIB,
  );
});

test("a written target round-trips and keeps unknown fields", async () => {
  const path = await tempPath();
  writeMemoryTargetMiB(2048, path);
  assert.equal(readMemoryTargetMiB(path), 2048);

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.targetMiB, 2048);

  await writeFile(path, JSON.stringify({ version: 1, targetMiB: 2048, futureKey: "keep" }));
  writeMemoryTargetMiB(1024, path);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.equal(after.futureKey, "keep");
  assert.equal(after.targetMiB, 1024);
  assert.equal(readMemoryTargetMiB(path), 1024);
});

test("out-of-range and non-integer writes are rejected without touching the file", async () => {
  const path = await tempPath();
  for (const invalid of [0, 255, 16385, 1500.5, Number.NaN, "1500", null]) {
    assert.throws(() => writeMemoryTargetMiB(invalid, path), String(invalid));
  }
  assert.equal(readMemoryTargetMiB(path), DEFAULT_MEMORY_TARGET_MIB);
});

test("an out-of-range stored value reads back as the default", async () => {
  const path = await tempPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, targetMiB: 999999 }));
  assert.equal(readMemoryTargetMiB(path), DEFAULT_MEMORY_TARGET_MIB);
});

test("a malformed file reads as the default and is never overwritten by a write", async () => {
  const path = await tempPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json");
  assert.equal(readMemoryTargetMiB(path), DEFAULT_MEMORY_TARGET_MIB);
  assert.throws(() => writeMemoryTargetMiB(2048, path));
  assert.equal(await readFile(path, "utf8"), "not json");
});
