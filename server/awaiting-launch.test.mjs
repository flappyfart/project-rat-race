import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAwaitingLaunchEngine } from "./awaiting-launch.mjs";
import { verifyLaunch } from "./gate.mjs";
async function fixture(t, config = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "prr-solana-wait-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "launch.json");
  await writeFile(
    configPath,
    JSON.stringify({
      launchNetwork: "solana",
      enabled: false,
      contract: null,
      ...config,
    }),
  );
  return {
    root,
    configPath,
    engine: await createAwaitingLaunchEngine({ configPath }),
  };
}
test("solana waiting mode has no former run, browser, workspace or financial activity", async (t) => {
  const { root, engine } = await fixture(t);
  const before = await readdir(root);
  await engine.tick();
  const s = engine.runtime.status();
  assert.equal(s.chainNamespace, "solana");
  assert.equal(s.chainId, null);
  assert.equal(s.quoteAsset, "SOL");
  assert.equal(s.phase, "prelaunch");
  assert.equal(s.totalSteps, 0);
  assert.equal(s.startedAt, null);
  assert.equal(s.contract, null);
  assert.equal(engine.runtime.isAuthorized(), false);
  assert.equal(engine.services.workshop.status().cycles, 0);
  assert.deepEqual(engine.services.workshop.status().projects, []);
  assert.equal(engine.services.internet.status().pagesOpened, 0);
  assert.equal(engine.services.economy.status().spendingEnabled, false);
  assert.equal(engine.services.economy.status().treasury, null);
  assert.deepEqual(await readdir(root), before);
});
test("a supplied mint or accidentally enabled setting cannot invoke an unimplemented solana adapter", async (t) => {
  const { engine } = await fixture(t, {
    enabled: true,
    contract: "synthetic-solana-mint",
  });
  await engine.tick();
  assert.equal(engine.runtime.status().phase, "verification_pending");
  assert.equal(engine.runtime.status().contract, null);
  assert.equal(engine.runtime.isAuthorized(), false);
  assert.equal(engine.runtime.gate.ok, false);
  assert.equal(engine.services.workshop.status().topupsEnabled, false);
  assert.equal(engine.runtime.protocol().method.solanaAdapterReady, false);
});
test("robinhood RACE waiting mode does not reuse either earlier launch or allow paid activity", async (t) => {
  const { root, engine } = await fixture(t, {
    launchNetwork: "robinhood",
    runtimeMode: "awaiting_launch",
    tokenSymbol: "RACE",
    enabled: true,
    contract: "0x" + "1".repeat(40),
    launchTx: "0x" + "2".repeat(64),
  });
  const before = await readdir(root);
  await engine.tick();
  const s = engine.runtime.status();
  assert.equal(s.chainNamespace, "eip155");
  assert.equal(s.chainId, 4663);
  assert.equal(s.quoteAsset, "ETH");
  assert.equal(s.tokenSymbol, "RACE");
  assert.equal(s.phase, "verification_pending");
  assert.equal(s.contract, null);
  assert.equal(s.launchTx, null);
  assert.equal(s.startedAt, null);
  assert.equal(s.totalSteps, 0);
  assert.equal(engine.runtime.isAuthorized(), false);
  assert.equal(engine.services.economy.status().spendingEnabled, false);
  assert.equal(engine.services.internet.status().pagesOpened, 0);
  assert.equal(engine.services.workshop.status().cycles, 0);
  assert.deepEqual(await readdir(root), before);
});
test("the legacy EVM verifier rejects a solana activation instead of trying EVM RPC", async () => {
  let calls = 0;
  const r = await verifyLaunch(
    { enabled: true, launchNetwork: "solana", chainId: 4663 },
    {
      rpc: async () => {
        calls++;
        throw Error("must not call");
      },
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /separate adapter/);
  assert.equal(calls, 0);
});
