import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyLaunch, receiptLinksToken, validAddress } from "./gate.mjs";
import { Runtime } from "./runtime.mjs";
import { createLearner, stepLearner, validateLearner } from "./learner.mjs";
import { createServer } from "./http.mjs";
import {
  InternetObserver,
  permittedArticle,
  adapterDecision,
  luminanceInput,
} from "./internet.mjs";
import { EconomyObserver, assessIntent, ethFromWei } from "./economy.mjs";
import { PNG } from "pngjs";

// Explicit synthetic, temporary unit fixtures. Never used by the official runtime.
const token = "0x" + "1".repeat(40),
  asset = "0x" + "2".repeat(40),
  tx = "0x" + "a".repeat(64),
  blockHash = "0x" + "b".repeat(64);
const now = Date.parse("2026-09-13T20:00:00Z");
const config = {
  enabled: true,
  chainId: 4663,
  contract: token,
  launchTx: tx,
  rpcUrl: "https://rpc.example.test",
  minConfirmations: 12,
  seed: 4663,
  market: {
    url: "https://feed.example.test/verified",
    assetContract: asset,
    sourceId: "offline-unit-fixture",
    operatorVerified: true,
    maxAgeSeconds: 120,
  },
  internet: { enabled: true, seedUrl: "https://en.wikipedia.org/wiki/Rat" },
};
function deps(overrides = {}) {
  const results = {
    eth_chainId: "0x1237",
    eth_getTransactionReceipt: {
      status: "0x1",
      transactionHash: tx,
      blockNumber: "0x64",
      blockHash,
      contractAddress: token,
      logs: [],
    },
    eth_blockNumber: "0x80",
    eth_getBlockByNumber: {
      hash: blockHash,
      number: "0x64",
      timestamp: "0x" + Math.floor((now - 60000) / 1000).toString(16),
    },
    eth_getCode: "0x6001600055",
    ...overrides,
  };
  return {
    now: () => now,
    rpc: async (m) => structuredClone(results[m]),
    marketFetch: async () => ({
      verified: true,
      chainId: 4663,
      contract: asset,
      quoteAsset: "ETH",
      sourceId: "offline-unit-fixture",
      priceEth: 0.02,
      timestamp: new Date(now - 1000).toISOString(),
    }),
  };
}
async function temporary(t) {
  const p = await mkdtemp(path.join(os.tmpdir(), "rat-race-test-"));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}
test("unconfigured gate is closed without network calls", async () => {
  let calls = 0;
  const out = await verifyLaunch(
    { enabled: false },
    {
      rpc: () => {
        calls++;
      },
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.phase, "prelaunch");
  assert.equal(calls, 0);
});
test("zero, missing, malformed addresses rejected", () => {
  for (const a of [null, "", "0x" + "0".repeat(40), "0x123", token + "x"])
    assert.equal(validAddress(a), false);
});
test("verified launch requires separate exact market identity", async () => {
  assert.equal((await verifyLaunch(config, deps())).ok, true);
  const d = deps();
  d.marketFetch = async () => ({
    verified: true,
    chainId: 4663,
    contract: token,
    quoteAsset: "ETH",
    sourceId: "offline-unit-fixture",
    priceEth: 0.02,
    timestamp: new Date(now - 1000).toISOString(),
  });
  assert.equal((await verifyLaunch(config, d)).ok, false);
});
for (const [name, changes] of [
  ["wrong chain", { eth_chainId: "0x1" }],
  ["missing receipt", { eth_getTransactionReceipt: null }],
  ["no code", { eth_getCode: "0x" }],
  ["too few confirmations", { eth_blockNumber: "0x65" }],
  [
    "wrong block",
    {
      eth_getBlockByNumber: {
        hash: "0x" + "c".repeat(64),
        number: "0x64",
        timestamp: "0x1",
      },
    },
  ],
])
  test("rejects " + name, async () =>
    assert.equal((await verifyLaunch(config, deps(changes))).ok, false),
  );
test("failed or unrelated launch receipt cannot unlock", async () => {
  const d = deps();
  const base = await d.rpc("eth_getTransactionReceipt");
  for (const changes of [
    { status: "0x0" },
    { contractAddress: asset },
    { transactionHash: "0x" + "c".repeat(64) },
  ])
    assert.equal(
      (
        await verifyLaunch(
          config,
          deps({ eth_getTransactionReceipt: { ...base, ...changes } }),
        )
      ).ok,
      false,
    );
});
test("factory receipt requires ABI shaped token mint", () => {
  const receipt = {
    logs: [
      {
        address: token,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x" + "0".repeat(64),
          "0x" + "0".repeat(24) + "2".repeat(40),
        ],
        data: "0x" + "0".repeat(63) + "1",
      },
    ],
  };
  assert.match(receiptLinksToken(receipt, token), /mint/);
  receipt.logs[0].address = asset;
  assert.throws(() => receiptLinksToken(receipt, token));
});
test("stale and future market observations fail closed", async () => {
  for (const delay of [-300000, 1000]) {
    const d = deps(),
      m = await d.marketFetch();
    d.marketFetch = async () => ({
      ...m,
      timestamp: new Date(now + delay).toISOString(),
    });
    assert.equal((await verifyLaunch(config, d)).ok, false);
  }
});
test("repeated ticks and reads cannot create prelaunch state", async (t) => {
  const root = await temporary(t),
    c = path.join(root, "launch.json"),
    cp = path.join(root, "checkpoint.json");
  await writeFile(c, JSON.stringify({ enabled: false }));
  let calls = 0;
  const runtime = await new Runtime({
    configPath: c,
    checkpointPath: cp,
    dependencies: {
      rpc: () => {
        calls++;
      },
    },
  }).initialize();
  for (let i = 0; i < 40; i++) {
    await runtime.tick();
    runtime.status();
    runtime.history();
    runtime.protocol();
  }
  assert.equal(runtime.status().totalSteps, 0);
  assert.equal(runtime.status().maze, null);
  assert.deepEqual(runtime.history(), { episodes: [] });
  assert.equal(calls, 0);
  await assert.rejects(stat(cp), { code: "ENOENT" });
});
test("learner is deterministic, bounded, and has changing real weights", () => {
  let a = createLearner(4663),
    b = createLearner(4663);
  for (let i = 0; i < 800; i++) {
    const m = { priceEth: 0.02, timestamp: new Date(now).toISOString() };
    a = stepLearner(a, m);
    b = stepLearner(b, m);
  }
  assert.deepEqual(a, b);
  assert(a.totalSteps > 0 && a.totalSteps <= 800);
  if (a.escape) assert.equal(a.totalSteps, a.escape.totalSteps);
  assert(a.weights.flat().some((v) => v !== 0));
  assert(a.episodes.length > 0);
  validateLearner(a);
});
test("internet sensor has an explicit bounded motor effect", () => {
  const s = createLearner(88);
  stepLearner(s, {
    priceEth: 0.02,
    timestamp: new Date(now).toISOString(),
    sensoryInput: [0, 1, 0.5, 0.75],
  });
  assert.deepEqual(s.internetBias, [-0.015, 0.015, 0, 0.0075]);
});
test("checkpoint survives restart without an extra step", async (t) => {
  const root = await temporary(t),
    c = path.join(root, "launch.json"),
    cp = path.join(root, "checkpoint.json");
  await writeFile(c, JSON.stringify(config));
  const opts = { configPath: c, checkpointPath: cp, dependencies: deps() };
  const a = await new Runtime(opts).initialize();
  await a.tick();
  await a.tick();
  const before = a.status();
  assert.equal(before.totalSteps, 2);
  const b = await new Runtime(opts).initialize();
  await b.tick({ advance: false });
  assert.equal(b.status().stateHash, before.stateHash);
  assert.equal(b.status().totalSteps, 2);
  await writeFile(cp, "corrupted");
  const bad = await new Runtime(opts).initialize();
  await bad.tick();
  assert.equal(bad.status().phase, "error");
  assert.equal(await readFile(cp, "utf8"), "corrupted");
});
test("browser stays uncreated and unrecorded before launch", async (t) => {
  const root = path.join(await temporary(t), "internet");
  let starts = 0;
  const ob = new InternetObserver({
    root,
    launchBrowser: () => {
      starts++;
      throw new Error("must not run");
    },
  });
  for (let i = 0; i < 20; i++)
    await ob.tick({
      gate: { ok: false },
      state: null,
      config: { internet: { enabled: true } },
    });
  assert.equal(starts, 0);
  assert.equal(ob.status().pagesOpened, 0);
  assert.deepEqual(ob.status().events, []);
  await assert.rejects(stat(root), { code: "ENOENT" });
});
test("web allowlist rejects forms, accounts, offsite, private hosts and special pages", () => {
  assert.equal(permittedArticle("https://en.wikipedia.org/wiki/Rat"), true);
  for (const u of [
    "http://en.wikipedia.org/wiki/Rat",
    "https://en.wikipedia.org/wiki/Special:UserLogin",
    "https://en.wikipedia.org/wiki/Special%3AUserLogin",
    "https://evil.example/wiki/Rat",
    "https://127.0.0.1/wiki/Rat",
    "https://en.wikipedia.org.evil.test/wiki/Rat",
    "https://en.wikipedia.org/wiki/Rat?title=edit",
    "file:///etc/passwd",
    "https://user@en.wikipedia.org/wiki/Rat",
  ])
    assert.equal(permittedArticle(u), false, u);
});
test("sensor measures actual pixels and adapter uses only allowed links", () => {
  const p = new PNG({ width: 16, height: 16 });
  p.data.fill(255);
  const input = luminanceInput(PNG.sync.write(p));
  input.forEach((v) => assert(Math.abs(v - 1) < 1e-8));
  const a = adapterDecision(createLearner().weights, input, [
    "https://evil.test",
    "https://en.wikipedia.org/wiki/Rat",
  ]);
  assert.equal(a.url, "https://en.wikipedia.org/wiki/Rat");
  assert.equal(adapterDecision(createLearner().weights, input, []).url, null);
  assert.throws(() =>
    adapterDecision(createLearner().weights, [NaN, 0, 0, 0], []),
  );
});
test("economy has no rpc activity before gate and no invented fee receipts", async () => {
  let calls = 0;
  const e = new EconomyObserver({
    rpc: async () => {
      calls++;
    },
  });
  await e.tick({ gate: { ok: false }, config: {} });
  assert.equal(calls, 0);
  assert.equal(e.status().creatorFeesEth, null);
  assert.equal(e.status().spendingEnabled, false);
  assert.equal(assessIntent({}, { spendingEnabled: false }).accepted, false);
});
test("money formatting and policy use exact integers", () => {
  assert.equal(ethFromWei("0xde0b6b3a7640001"), "1.000000000000000001");
  const policy = {
    spendingEnabled: true,
    approvedRecipients: [asset],
    maxIntentWei: "100",
  };
  assert.equal(
    assessIntent({ to: asset, wei: "101", chainId: 4663, data: "0x" }, policy)
      .accepted,
    false,
  );
  assert.equal(
    assessIntent({ to: asset, wei: "10", chainId: 4663, data: "0x" }, policy)
      .accepted,
    true,
  );
  assert.equal(
    assessIntent({ to: asset, wei: "10", chainId: 4663, data: "0x123" }, policy)
      .accepted,
    false,
  );
});
test("http is read only, blocks path traversal, ignores activation query", async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, "index.html"), "<html>unit test only</html>");
  const rt = await new Runtime({
    configPath: path.join(root, "absent"),
    checkpointPath: path.join(root, "cp"),
  }).initialize();
  const server = createServer(rt, root);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal(
    (await fetch(url + "/api/start", { method: "POST" })).status,
    405,
  );
  let s = await (
    await fetch(url + "/api/status?enabled=true&contract=" + token)
  ).json();
  assert.equal(s.phase, "prelaunch");
  assert.equal(s.maze, null);
  assert.equal((await fetch(url + "/.env")).status, 400);
  assert.equal((await fetch(url + "/%2e%2e%2fsecret")).status, 400);
  await symlink("/etc/passwd", path.join(root, "escape.txt"));
  assert.equal((await fetch(url + "/escape.txt")).status, 403);
  assert.equal((await fetch(url + "/api/browser-frame")).status, 404);
  assert.equal((await fetch(url + "/api/internet")).status, 200);
});
