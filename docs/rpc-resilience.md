# rpc resilience and current activity

## providers

The production operator configuration selects `https://robinhood-rpc.publicnode.com` as the Robinhood Chain primary and `https://rpc.mainnet.chain.robinhood.com` as the fallback. Both appear in the ethereum-lists chain registry for chain 4663; PublicNode is also listed by Chainlist. Before switching, the primary was checked against the existing launch receipt, canonical block hash and deployed token code. This is a provider change, not a new launch or learner reset.

Each RPC pool independently checks its configured chain. Transport/HTTP failures trigger bounded provider cooldowns and honor Retry-After. Logical RPC execution errors are not hidden by provider shopping. Read requests already in flight are shared. An attempted raw transaction broadcast is never automatically repeated across providers; the pre-existing signed-transaction journal remains responsible for reconciliation.

## bounded launch evidence

Launch-only RPC reads are cached for at most 30 seconds, with proactive refresh during the last 10 seconds. Failed refreshes never extend a cache entry. Expired evidence cannot authorize execution, even between worker ticks. Operator enable flags, token identity, source integrity and market freshness are still checked. Financial balance, nonce, gas, allowance and transaction calls do not use the launch cache.

The cache reduces repetitive verification traffic; it does not guarantee uninterrupted access. If supported providers remain unavailable beyond the permitted verification window, the runtime pauses rather than assume authorization. No challenge tokens, proxy rotation or access-control bypass is used.

## state continuity

The saved learner checkpoint, verified escape hash, agent state and financial journals remain outside the public build. A supervised worker restart restores the same escaped state and agent continuation; it does not replay or reset the maze. Sensory-browser counters describe the browser process session, not a lifetime total.

## website activity

The independent sensory browser is not a video of the AI workshop. The page now distinguishes captured frames, frame age and pause/error reasons from the agent's planning, selected tool execution, waiting, errors and actual tool outcomes. Planner intent is explicitly not a verified accomplishment. Workspace inventory is a timestamped, filtered projection, not exposure of raw private files or prompts.

Tests include supported fallback identity, HTTP challenge cooldowns, Retry-After, ambiguous-broadcast behavior, logical RPC errors, fresh financial reads, cache isolation/expiry, proactive refresh, immediate authorization expiry, telemetry state transitions and stale-frame presentation.
