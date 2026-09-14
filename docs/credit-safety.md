# proactive ai credit safety

## configured defaults

refill trigger: provider credit balance at or below 1 dollar.
refill purchase: 5 usdc, through the existing funding controller.
protected credit reserve: 20 cents.
maximum allowance for one paid inference request: 2 cents.

The amount is measured at the AI provider, not inferred from treasury ETH or Base USDC. Native gas reserves and conversion caps remain separate and unchanged.

## enforcement

1. The background funding service monitors credit levels. A paid-request preflight can also wake that same service immediately, sharing a single in-flight controller call.
2. Every paid request obtains fresh provider credit information. Unknown balances do not authorize work and do not justify blind credit purchases.
3. The wallet transport checks the balance again inside its serialized request section. Concurrent callers cannot all spend the same observed allowance.
4. Admission requires enough balance for the request ceiling plus the protected reserve. With current defaults this means at least 220000 USD micro-units before a paid request.
5. Refill work runs outside the inference transport lock. It never waits for that same lock while holding it. Existing financial journals prevent duplicate conversion or credit payment intents.
6. Submitting a refill does not count as receiving credits. Requests depend on fresh provider balances; the funding controller separately reconciles onchain and merchant evidence.

## waiting and resumption

A low or unavailable balance sets `waiting_for_credits` before the agent consumes its daily request allowance or invokes a paid model. Memory, workspace, prior results and progress remain saved. The agent rechecks automatically and resumes when funding is sufficient.

An unexpected provider credit decline is recorded as a resumable credit wait, not a completed action. No tool is executed from a missing model response. A potentially charged request keeps its conservative accounting reservation.

## boundaries

This protection applies to this runtime and its configured per-request limits. It cannot guarantee uninterrupted service through provider/network outages, an empty treasury, account restrictions, external spending from the same account, or provider overcharging. When credits cannot be verified, the safe behavior is to wait before starting another paid request.

Launch authorization remains mandatory. Read-only inspections cannot purchase credits. This change does not activate the official rat, alter DNS, reset a wallet or erase payment records.

## verification

Tests cover trigger equality, protected-reserve boundaries, concurrent request admission, one shared refill attempt, transport lock ordering, unknown balances, failed refills, provider credit declines, restart continuity and automatic resumption. Financial calls in these regression tests are explicit fixtures; they do not move real funds.
