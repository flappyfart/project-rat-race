# operator setup

Current state: awaiting a new Solana launch. `awaiting-launch.mjs` serves disabled status only and never constructs an RPC client, signing wallet, browser or paid agent. Solana verification and funding integration must be implemented and independently tested before activation. The reference worker details below describe the retained prior EVM implementation.

The safe preview requires no wallet, account credential or VM. The full engine is a separate, explicitly configured operation.

## configuration

Copy `config/launch.example.json` to `config/launch.json`. The local file is ignored by git. Configure your own exact treasury, reference asset and source identity. Keep activation and spending disabled while preparing dependencies.

Never reuse a ticker match as contract identity. Bind an official run to its intended contract and successful canonical launch receipt, with the required confirmation depth.

## protected worker

The reference execution adapter targets a dedicated Lima VM named `rat-race`. Use the supplied VM configuration as a starting point and inspect the resulting configuration before operating it. It must not mount the operator home or credential directories.

The wallet transport expects a protected operator keychain helper and a public wallet identity in the private project data directory under the current user's home. The helper source and explicit wallet-creation script are included for inspection. Wallet setup is not an npm install step. Verify backup/recovery independently before funding a new identity.

The current runtime uses an explicitly approved AI provider and a narrow payment route. Configure and verify provider availability, pricing, funds, gas reserves and recovery paths before authorization.

## workflow

1. Build and test the safe source release.
2. Configure isolated execution and a separate receiving treasury.
3. Verify the public identity against the protected signing identity without printing private material.
4. Exercise a clearly isolated rehearsal with an explicit small spending allowance if real payments are required.
5. Verify funds, provider billing, tool results, interruption behavior and reset boundaries.
6. Configure public hosting and supervision separately. Never expose a signing endpoint.
7. Enable the official run only after its actual launch evidence, resources and dependencies are verified.

## deployment

A static frontend is not a persistent worker. The public reference architecture uses a read-only edge proxy to a private origin. Configure the edge's `PUBLIC_API_ORIGIN` for your own deployment. Cloud credentials, service definitions, account identifiers and domain-specific deployment tools are not shipped in this source release.

A worker hosted on an operator workstation depends on that machine's power, login state and connectivity. The frontend must show unavailable state during worker outages.

## reset and stop

Only marked isolated test-session state can be reset through the provided helper. Wallet keys, provider balances, payment nonces, receipts and financial journals are not resettable simulation state.

Disabling the operator launch configuration prevents new authorized work. Already submitted transactions may still settle. Reconcile them rather than issuing replacements blindly.
