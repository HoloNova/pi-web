# 0006 — A soft memory target that only Lite mode acts on

## Status

Accepted.

## Context

Pi-Web runs under a systemd unit with a soft limit (MemoryHigh) and a hard limit
(MemoryMax). Those are the real guardrail, but they give an operator no way to
say "keep Pi-Web's own footprint lower than this, and close idle sessions
before systemd has to throttle". The Lite mode work already had a per-session
reclaim path (closing an idle session no page is viewing), so the missing half
was a number to judge the service's own footprint against.

Constraints that shaped the decision:

- Pi-Web must not write into pi's files (`settings.json`, `models.json`,
  `agents/settings.json`) or any plugin config; those belong to other runtimes.
- No privileges, no writing to a cgroup or to systemd.
- No new server timer that keeps an otherwise idle Pi-Web busy: the monitor's
  timer is unref'd and its quiet path only reads a configuration file and one
  cgroup counter.
- Normal mode must not change: an idle session stays warm while its page is
  open, and no target-driven close is expected there.

## Decision

**The target is a Lite-mode setting**, stored in the instance's own
`pi-web-settings.json` as `lite.memoryTargetMiB` (256–16384, default 1800). 1800
MiB is a starting point rather than a tuned value: above an ordinary working
set, below a small host's limit. It is explicitly *soft* — the systemd limits
are untouched, nothing is killed, and on a systemd host the operator should keep
it under the unit's `MemoryHigh`.

**Measurement is read-only and prefers the cgroup.** `lib/service-memory.ts`
follows `/proc/self/cgroup`'s unified path to `memory.current`, tolerating a
renamed unit and nested slices, with fixed `pi-web.service` paths as fallbacks
and `PI_WEB_MEMORY_CGROUP_PATH` for a non-standard host. When no cgroup file is
readable it falls back to Node RSS plus direct children RSS and flags the result
`approximate`, which the UI labels.

**Reading observes; the server owns the policy.** `GET /api/memory` reports the
target, the reading and the state — nothing else. It does not count what a pass
could close, because that would mean walking sessions and delegated trees on
every poll; a status read stays cheap and free of side effects.

The policy that acts is a server-side monitor
(`lib/lite-memory-monitor.ts`), started once per process from the Node
instrumentation hook. Every 15 seconds it reads the Lite configuration, reads
`memory.current` and compares the two; a quiet reading stops there. At or above
90% of the target it runs one reclaim pass. The policy therefore does not depend
on a browser being open, and there is no endpoint that a page could call to
close a session: the old `POST /api/memory/reclaim` and its settings button are
gone with the browser-driven design.

**A pass reclaims the oldest one.** `planIdleReclaim` orders live sessions
oldest-first by last real activity, and skips any session that is running, has
delegated work in flight, or is held by another tab/device (presence lease or
SSE stream). One pass closes at most one session: the caller polls, so the next
pass takes the next-oldest, and a single pressure reading never drops a page's
whole working set. When nothing is reclaimable the service stays under pressure
until the next tick — there is no escalation and no process kill.

**Pressure is reported where it is noticed.** The settings control and the chat
composer show "near" (from 90% of the target) and "over" states, both driven by
the same shared status read: a 10 s poll, paused while the tab is hidden, that
every surface in the tab shares. The UI is display-only — it shows what the
server is doing, it never asks the server to do it. The monitor logs the passes
that actually close something, so its effect is visible in the service log.

**Normal mode has no target at all.** `GET /api/memory` reports the explicit
inactive shape (`{ active: false }`), and the monitor's tick returns without
measuring anything: the clock is not even read against the cgroup. The stored
number stays on disk so the operator's value survives, but it is inert and
invisible while Lite mode is off: no ceiling, no reclaim, and nothing that can
close a normal-mode session.
