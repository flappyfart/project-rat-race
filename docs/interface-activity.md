# truthful activity interface

source-only change. existing loaded production modules and served dist are intentionally untouched. no restart, build of production dist, funding request, configuration change, state reset or publication is part of this work.

## contract

`AgentLoop.status()` adds `activity.version = 1`, `observedAt`, phase `since`, selected `tool`, separately labeled planner `intent`, eligible `nextAt`, and last observed workspace inventory. `cycles` is the durable completed decision/tool cycle count, including tool failures and intentional waits; it does not mean successful projects or income. inference failures do not increment it.

- `checking_credits`: admission check, not paid inference.
- `thinking`: inference pending, no completed action implied.
- `working`: selected tool executing, name shown; planner summary is intent only.
- `resting`: cycle finished or daily budget ceiling; next eligible attempt/check is shown, not guaranteed execution.
- `waiting_for_credits`: exact admission reason and scheduled retry.
- `paused` / `locked`: launch gate reason or maze lock; no executable next action promised.
- `error`: actual inference/tool error or unsuccessful execution/verification; persists through the retry delay.

recent events are projections of tool results. stdout and planner summaries never establish verification. `verify_node` must explicitly return `verified: true`; process exit zero is only process completion. interrupted results remain unknown. workspace count/names are timestamped observations from the latest successful list/write result, not a fresh filesystem scan. write results expose only the recently written names, labeled partial. only allowlisted basenames are shown; hidden/absolute/traversal/sensitive-looking names are suppressed. tool payloads, file contents, stdout/stderr, model memory, raw responses and arguments are omitted. public free text redacts URL/path and common secret-token forms; normal gate/error reasons are retained.

## frontend integrity

workshop polls remain read-only. the UI preserves the last record on network failure and marks it unavailable; records older than 20 seconds are stale even if a fetch hangs. legacy workers without the versioned projection explicitly show detailed telemetry unavailable and do not promote their old planner text into results.

wikipedia frames are independent sensory observations, not evidence of AI research or work. the exact identity URL remains the image source and React identity. paused/offline/unavailable or older-than-45-second frames receive an opaque overlay with the reason, original capture timestamp and ticking age. internet polling failures preserve the last frame with an unavailable marker. a new frame identity can recover a failed image. the frame is a recorded snapshot, never video.

## isolated verification

from the repository root:

```sh
node --test server/agent-telemetry.test.mjs server/activity-interface-telemetry.test.mjs
./node_modules/.bin/tsc --noEmit
node --check server/agent-loop.mjs
```

backend fixtures use unique temporary directories, an injected clock and synthetic transport/tool responses. interface tests transform source in memory with Vite middleware mode (no listener, watcher, HMR or production proxy/config), then render real React components. they assert active/waiting/error/legacy/stale states, outcome-vs-intent labels and paused browser overlay identity, exact reason and age. no test reaches production APIs or paid services. type checking emits nothing. these checks do not constitute production deployment or interactive browser visual QA.
