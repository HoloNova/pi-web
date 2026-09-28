# 0006 — A soft memory target that only Lite mode acts on

## Status

Accepted.

## Context

Pi-Web runs under a systemd unit with a soft limit (MemoryHigh) and a hard
limit (MemoryMax); the unit's guardrails are the real limit, but they give the
operator no way to say "keep Pi-Web's own footprint lower than this, and reclaim
what you can before systemd throttles". Milestone 1 already had a per-session
reclaim path (`reclaimIdleRpcSession`), driven by Lite-mode presence release and
the idle timer, but nothing connected it to the service's own memory use.

A target had to be added without:

- writing into pi's files (`settings.json`, `models.json`,
  `agents/settings.json`) or any plugin config — those belong to other runtimes
  and are rewritten wholesale by them;
- requiring privileges or writing to a cgroup/systemd;
- adding a server timer that keeps an otherwise idle Pi-Web busy;
- changing normal mode, where an idle session is kept warm while its page is
  open and no target-driven close is expected.

## Decision

**The target is a Pi-Web-owned, service-wide value in
`~/.pi/agent/pi-web-memory.json`** (`{ "version": 1, "targetMiB": 1800 }`),
edited from General → Session lifetime. 1800 MiB is a starting point, not a
tuned value: it is picked to sit above an ordinary working set so a fresh
install does not reclaim constantly, and well below a small host's limit so the
reclaim still has room to act. It is explicitly a *soft* target; the systemd
limits are untouched and nothing is ever killed. On a systemd host the operator
should keep the target under the unit's `MemoryHigh`.

**Measurement is read-only and prefers the cgroup.** `lib/service-memory.ts`
follows `/proc/self/cgroup`'s unified path to `memory.current`, tolerating a
renamed unit and nested slices, with the fixed `pi-web.service` paths (cgroup v2
and v1) as fallbacks and `PI_WEB_MEMORY_CGROUP_PATH` for a non-standard host.
When no cgroup file is readable it falls back to Node RSS plus direct children
RSS, and the result is flagged `approximate` so the UI can label it.

**Reclaim is Lite mode's, and it reuses the milestone-1 path.** A Lite request
to `GET /api/memory` under pressure (≥ 90% of target, or over it) runs one
bounded pass: `planIdleReclaim` orders live wrappers oldest-first by last real
activity, and `runMemoryPressureReclaim` asks the idle, unviewed ones to close.
A running wrapper is never interrupted — it is marked and reclaimed when its run
settles. A wrapper another tab/device is viewing is left completely alone. When
nothing is reclaimable the service simply stays over target and reports that;
there is no escalation and no process kill.

**Normal mode has no target at all.** The target is a Lite-mode-only concept.
A `GET /api/memory` without the Lite header reports the explicit inactive shape
(`{ active: false }`) instead of a target, state, or usage; a `PUT` without the
header is refused; and the settings control is rendered only while Lite mode is
on (the chat warning banner was already Lite-only). The stored value stays on
disk so the operator's number survives, but it is completely inert and
invisible while Lite mode is off, and normal mode keeps its original behaviour:
no ceiling and no reclaim. Nothing here can close a normal-mode session — the
pressure pass is gated on the Lite request header, and normal-mode viewers
additionally hold a `/lease` keep-warm lease, so `viewed` is true for them
anyway.

**The idle window is a device-local, configurable option.** The 5-minute idle
deadline is now the default of a device-local option (1–60 minutes, in
localStorage, synced live across tabs of the same browser profile exactly like
the Lite toggle; see `lib/device-preference.ts`). `lib/lite-lifecycle.ts` takes
the window as a parameter, and `hooks/useLiteSessionLifecycle.ts` reads the
preference live, so changing it re-arms the deadline for the currently selected
session without a reload and without dropping presence. The server-side 90 s
presence-lease TTL and the never-interrupt-a-running-task rule are unchanged;
the option only controls when an idle page releases its session.

**No new server timer.** The pass runs only when a visible Lite tab polls
`GET /api/memory` (10 s, paused while hidden), so an idle Pi-Web with no Lite tab
does no extra work. The endpoint is the only status surface; the settings
control and the chat card share one in-memory status store
(`lib/memory-status-store.ts`) with one poll loop that broadcasts every reading
and every saved target to both surfaces at once.

## Consequences

- `AgentSessionWrapper.lastActivityAt()` was added as the LRU key; it is stamped
  by `resetIdleTimer()` (real activity), so keep-warm polling does not count.
- The threshold is a named constant (`MEMORY_NEAR_TARGET_RATIO = 0.9`) shared by
  the server state and the UI chip.
- A normal-mode run longer than the 90 s SSE lease can be marked for reclaim
  after it settles if a Lite tab is polling under pressure; the wrapper is
  recreated transparently on the next request. This is the same class of
  eviction the existing 10-minute idle timeout already performs.
