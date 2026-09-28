import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Read-only measurement of the Pi-Web service footprint. The cgroup total is
// preferred because it is what systemd accounts against MemoryHigh/MemoryMax;
// Node RSS (+ direct children) is the fallback and is always labelled as an
// approximation. Nothing here writes to a cgroup or calls systemd, and no read
// requires privileges.

export type ServiceMemorySource = "cgroup" | "process-rss";

export interface ServiceMemoryReading {
  bytes: number;
  source: ServiceMemorySource;
  /** Path or method the value came from; the UI labels the fallback with it. */
  detail: string;
  /** True when the value is Node RSS (+ children) rather than the cgroup total. */
  approximate: boolean;
}

export interface ServiceMemoryProbe {
  readUtf8(path: string): string | null;
  listDir(path: string): string[] | null;
  /** Resident set size of the current process, in bytes. */
  selfRssBytes(): number;
  pid: number;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

/**
 * Operator/test override for the cgroup memory file. It exists because cgroup
 * paths and hierarchies differ between hosts; the default discovery below is
 * still the normal path.
 */
export const CGROUP_MEMORY_PATH_ENV = "PI_WEB_MEMORY_CGROUP_PATH";

export function defaultServiceMemoryProbe(): ServiceMemoryProbe {
  return {
    readUtf8(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    listDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    selfRssBytes: () => process.memoryUsage().rss,
    pid: process.pid,
  };
}

/**
 * cgroup v2 unified layout: the single line `0::<path>` names this process's
 * cgroup relative to the mount root. Following that path tolerates a renamed
 * unit and nested slices; the fixed unit path is only a fallback for a process
 * that cannot read /proc/self/cgroup.
 */
export function cgroupV2RelativePath(procSelfCgroup: string): string | null {
  for (const line of procSelfCgroup.split("\n")) {
    const match = /^0::(\/.*)$/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

export function parseCgroupBytes(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Candidate memory files, most-specific first: the cgroup this process actually
 * runs in, then the well-known pi-web.service paths for cgroup v2 and cgroup v1.
 */
export function cgroupMemoryFileCandidates(
  relativePath: string | null,
  options: { unit?: string; overridePath?: string | null } = {},
): string[] {
  const unit = options.unit ?? "pi-web.service";
  const candidates: string[] = [];
  if (options.overridePath) candidates.push(options.overridePath);
  if (relativePath) {
    candidates.push(join(CGROUP_ROOT, relativePath, "memory.current"));
    candidates.push(join(CGROUP_ROOT, relativePath, "memory.usage_in_bytes"));
  }
  candidates.push(join(CGROUP_ROOT, "system.slice", unit, "memory.current"));
  candidates.push(join(CGROUP_ROOT, "system.slice", unit, "memory.usage_in_bytes"));
  candidates.push(join(CGROUP_ROOT, "memory", "system.slice", unit, "memory.usage_in_bytes"));
  return [...new Set(candidates)];
}

/**
 * Resident bytes of this process's direct children, read from the kernel's
 * per-thread `children` list and each child's `VmRSS`. Returns 0 on any host
 * without procfs; the fallback then reports Node RSS alone.
 */
function childrenRssBytes(probe: ServiceMemoryProbe): number {
  const taskDir = `/proc/${probe.pid}/task`;
  const tids = probe.listDir(taskDir);
  if (!tids) return 0;
  const childPids = new Set<string>();
  for (const tid of tids) {
    const raw = probe.readUtf8(join(taskDir, tid, "children"));
    if (!raw) continue;
    for (const pid of raw.trim().split(/\s+/)) {
      if (/^\d+$/.test(pid)) childPids.add(pid);
    }
  }
  let total = 0;
  for (const pid of childPids) {
    const status = probe.readUtf8(`/proc/${pid}/status`);
    const match = status ? /^VmRSS:\s+(\d+)\s+kB/m.exec(status) : null;
    if (match) total += Number(match[1]) * 1024;
  }
  return total;
}

export function readServiceMemoryReading(
  probe: ServiceMemoryProbe = defaultServiceMemoryProbe(),
  options: { overridePath?: string | null } = {},
): ServiceMemoryReading {
  const envOverride = process.env[CGROUP_MEMORY_PATH_ENV]?.trim() || null;
  const overridePath = options.overridePath === undefined ? envOverride : options.overridePath;
  const relativePath = (() => {
    const raw = probe.readUtf8("/proc/self/cgroup");
    return raw ? cgroupV2RelativePath(raw) : null;
  })();

  for (const path of cgroupMemoryFileCandidates(relativePath, { overridePath })) {
    const raw = probe.readUtf8(path);
    if (raw === null) continue;
    const bytes = parseCgroupBytes(raw);
    if (bytes === null) continue;
    return { bytes, source: "cgroup", detail: path, approximate: false };
  }

  const children = childrenRssBytes(probe);
  return {
    bytes: probe.selfRssBytes() + children,
    source: "process-rss",
    detail: children > 0 ? "node-rss+children" : "node-rss",
    approximate: true,
  };
}
