# 0006 — A soft memory target that only Lite mode acts on

## Status

Accepted.

## Context

Pi-Web runs under a systemd unit with `MemoryHigh=1500M` / `MemoryMax=2200M`
(runtime drop-ins). Those are the real guardrail, but they give the operator no
way to say "keep Pi-Web's own footprint lower than this, and reclaim what you
can before systemd throttles or OOMs". Milestone 1 already had a per-session
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
`~/.pi/agent/pi-web-memory.json`** (`{ "version": 1, "targetMiB": 1500 }`),
edited from General → Session lifetime. The default, 1500 MiB, sits on the
service's `MemoryHigh`. It is explicitly a *soft* target; the systemd limits are
untouched and nothing is ever killed.

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

**Normal mode reads nothing and reclaims nothing.** The `reclaim` field is
`null` for a request without the Lite header, and the chat warning banner is
mounted only while Lite mode is on. The *setting* is visible in normal mode
because it belongs to the server, not the tab, but it cannot close a normal-mode
session: the pressure pass is gated on the Lite request header, and normal-mode
viewers additionally hold a `/lease` keep-warm lease, so `viewed` is true for
them anyway.

**No new server timer.** The pass runs only when a visible Lite tab polls
`GET /api/memory` (10 s, paused while hidden), so an idle Pi-Web with no Lite tab
does no extra work. The endpoint is the only status surface; the settings
control reads it once on mount and after a save.

## Consequences

- `AgentSessionWrapper.lastActivityAt()` was added as the LRU key; it is stamped
  by `resetIdleTimer()` (real activity), so keep-warm polling does not count.
- The threshold is a named constant (`MEMORY_NEAR_TARGET_RATIO = 0.9`) shared by
  the server state and the UI chip.
- A normal-mode run longer than the 90 s SSE lease can be marked for reclaim
  after it settles if a Lite tab is polling under pressure; the wrapper is
  recreated transparently on the next request. This is the same class of
  eviction the existing 10-minute idle timeout already performs.
