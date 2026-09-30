import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  CGROUP_MEMORY_PATH_ENV,
  cgroupMemoryFileCandidates,
  cgroupV2RelativePath,
  parseCgroupBytes,
  readServiceMemoryReading,
} = await jiti.import("./service-memory.ts");

function makeProbe(files, { rss = 0, pid = 4242, tids = [] } = {}) {
  return {
    readUtf8: (path) => (path in files ? files[path] : null),
    listDir: (path) => (path === `/proc/${pid}/task` ? tids : null),
    selfRssBytes: () => rss,
    pid,
  };
}

test("reads the cgroup v2 path and ignores v1 lines", () => {
  assert.equal(cgroupV2RelativePath("0::/system.slice/pi-web.service\n"), "/system.slice/pi-web.service");
  assert.equal(cgroupV2RelativePath("12:memory:/system.slice/pi-web.service\n"), null);
  assert.equal(cgroupV2RelativePath(""), null);
});

test("candidate paths put the process's own cgroup first, then the unit paths", () => {
  const candidates = cgroupMemoryFileCandidates("/system.slice/pi-web.service");
  assert.equal(candidates[0], "/sys/fs/cgroup/system.slice/pi-web.service/memory.current");
  assert.ok(candidates.includes("/sys/fs/cgroup/memory/system.slice/pi-web.service/memory.usage_in_bytes"));
  assert.equal(new Set(candidates).size, candidates.length);

  const overridden = cgroupMemoryFileCandidates(null, { overridePath: "/tmp/x/memory.current" });
  assert.equal(overridden[0], "/tmp/x/memory.current");
});

test("a readable cgroup memory file is reported as the exact footprint", () => {
  const probe = makeProbe({
    "/proc/self/cgroup": "0::/system.slice/pi-web.service\n",
    "/sys/fs/cgroup/system.slice/pi-web.service/memory.current": "1314287616\n",
  }, { rss: 1000 });
  const reading = readServiceMemoryReading(probe, { overridePath: null });
  assert.deepEqual(reading, {
    bytes: 1314287616,
    source: "cgroup",
    detail: "/sys/fs/cgroup/system.slice/pi-web.service/memory.current",
    approximate: false,
  });
});

test("without a cgroup file the Node RSS fallback is clearly marked approximate", () => {
  const probe = makeProbe({ "/proc/self/cgroup": "" }, { rss: 250_000_000 });
  const reading = readServiceMemoryReading(probe, { overridePath: null });
  assert.deepEqual(reading, {
    bytes: 250_000_000,
    source: "process-rss",
    detail: "node-rss",
    approximate: true,
  });
});

test("the fallback adds direct children when their RSS is readable", () => {
  const probe = makeProbe({
    "/proc/self/cgroup": "",
    "/proc/4242/task/4242/children": "777 778\n",
    "/proc/777/status": "Name:\tnode\nVmRSS:\t1024 kB\n",
    "/proc/778/status": "Name:\tnode\nVmRSS:\t512 kB\n",
  }, { rss: 1000, tids: ["4242"] });
  const reading = readServiceMemoryReading(probe, { overridePath: null });
  assert.equal(reading.bytes, 1000 + (1024 + 512) * 1024);
  assert.equal(reading.source, "process-rss");
  assert.equal(reading.detail, "node-rss+children");
  assert.equal(reading.approximate, true);
});

test("the env override is the first cgroup candidate", () => {
  const probe = makeProbe({
    "/proc/self/cgroup": "0::/system.slice/pi-web.service\n",
    "/tmp/override-memory.current": "42\n",
  });
  const reading = readServiceMemoryReading(probe, { overridePath: "/tmp/override-memory.current" });
  assert.deepEqual(reading, {
    bytes: 42,
    source: "cgroup",
    detail: "/tmp/override-memory.current",
    approximate: false,
  });
  assert.equal(CGROUP_MEMORY_PATH_ENV, "PI_WEB_MEMORY_CGROUP_PATH");
});

test("a non-numeric cgroup value is skipped instead of reported", () => {
  assert.equal(parseCgroupBytes("12345\n"), 12345);
  assert.equal(parseCgroupBytes("garbage"), null);
  const probe = makeProbe({
    "/proc/self/cgroup": "0::/system.slice/pi-web.service\n",
    "/sys/fs/cgroup/system.slice/pi-web.service/memory.current": "garbage",
  }, { rss: 900 });
  const reading = readServiceMemoryReading(probe, { overridePath: null });
  assert.equal(reading.source, "process-rss");
  assert.equal(reading.bytes, 900);
});
