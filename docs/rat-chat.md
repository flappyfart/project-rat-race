# public rat chat

The talk section is a read-only AI voice for the experiment. It is not the navigation learner speaking, a biological mind, or an operator console. It cannot invoke tools, change the controller or mission, write to the agent's memory/workspace, or sign transactions.

## grounding and privacy

Each reply receives a reconstructed public snapshot of phase, recorded steps/escape, model identity, cycle counts and safe outcome/file summaries. Raw agent memory, prompts, configuration, private financial balances, credentials and provider errors are excluded. Intentions, failed checks and completed work remain distinct.

Browser history is bounded and tab-scoped in sessionStorage. Messages are sent to the model provider. The origin has only a short-lived bounded response cache, not a transcript archive. Durable budget entries and existing inference receipts contain request identifiers and accounting metadata, not message text. Visitor history is never fed into the autonomous run.

## endpoint and gateway

GET `/api/rat-chat` returns availability and limits. POST takes exactly a UUID requestId, a message up to 1200 characters, and at most six prior user/assistant entries. Model replies are plain text; the interface does not render model HTML.

The website worker permits this POST only with matching Origin, JSON content type, bounded body and Cloudflare client identity. It HMACs the connecting IP and adds a server-only gateway secret. Caller-supplied authorization headers are replaced, not forwarded. The origin checks the secret and opaque client digest. Other public mutation routes remain blocked. Do not put the gateway secret in client code or commit it.

Configure the same secret in the operator's protected gateway file and the Pages production secret `RAT_CHAT_GATEWAY_SECRET`. Public source previews remain safe without it; they do not acquire the operator's payment authority.

## resource boundaries

The autonomous agent and chat share one durable daily compute ledger. The total daily ceiling remains 75 cents, and chat has a 10 cent sublimit inside that total. Prior agent usage is imported once from its verified checkpoint. Admission reserves the full request allowance before provider submission; confirmed charges settle it, ambiguous failures retain the reservation, and duplicate ids cannot pay again after restart. Ledger corruption or abandoned locks fail closed and need operator review.

Chat is single-flight and yields availability to the autonomous agent. There are per-client/global rate limits and bounded caches. Unknown credits or closed runtime authorization block paid replies. Public text cannot override these controls. A timeout is not permission to pay again; explicit retries preserve the same id/payload.

## verification

Run `npm test` and `npm run build`. Tests cover migration, concurrency, exact allowance boundaries, duplicate requests, provider failures, context filtering, strict payloads, gateway authentication, origin checks and plaintext output. Exercise a real bounded provider reply separately, verify billed accounting, and compare the live escape/checkpoint/agent state before and after rollout. Never reset the experiment for chat QA.
