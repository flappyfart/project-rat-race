import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarketSource,
  normalizeMarketPayload,
  verifyMarketObservation,
  NATIVE_ETH,
  canonical,
  sha256,
} from "./market-source.mjs";

// Deliberately synthetic offline fixtures; not production market evidence.
export const config = {
  assetContract: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
  identityProvenance: "operator-approved exact PLTR contract; synthetic tests",
  maxAgeMs: 1000,
};
export const at = "2026-09-13T00:00:00.000Z";
export function pair(overrides = {}) {
  return {
    chainId: "robinhood",
    dexId: "uniswap",
    labels: ["v4"],
    pairAddress: "0x" + "a".repeat(64),
    baseToken: { address: config.assetContract, symbol: "PLTR" },
    quoteToken: { address: NATIVE_ETH, symbol: "ETH" },
    priceNative: "0.06",
    priceUsd: "160",
    priceChange: { h24: -2, h6: 1 },
    volume: { h24: 1000 },
    liquidity: { usd: 20000 },
    pairCreatedAt: 1700000000000,
    ...overrides,
  };
}
const raw = () => JSON.stringify([pair()]);
function setup(t, fetch, now = () => Date.parse(at)) {
  return mkdtemp(join(tmpdir(), "rat-market-test-")).then((root) => {
    t.after(() => rm(root, { recursive: true, force: true }));
    return new MarketSource({ root, config, fetch, now });
  });
}

test("normalizes exact native ETH identity without claiming upstream measurement time or oracle verification", () => {
  const m = normalizeMarketPayload(raw(), { config, observedAt: at });
  assert.equal(m.quoteAsset, "ETH");
  assert.equal(m.chainId, 4663);
  assert.equal(m.priceEth, 0.06);
  assert.equal(m.source, "reference market not RAT price");
  assert.equal(m.upstreamTimestamp, null);
  assert.equal(
    m.volatilityMethod,
    "absolute h24 price change proxy, not realized volatility",
  );
  assert.equal(m.verified, undefined);
  assert.ok(verifyMarketObservation(m));
  assert.equal(verifyMarketObservation({ ...m, priceEth: 9 }), false);
});
test("rejects wrong base, inverted, wrong chain, fake ETH/WETH, and non-v4 native quotes", () => {
  for (const change of [
    { baseToken: { address: "0x" + "b".repeat(40), symbol: "PLTR" } },
    { chainId: "ethereum" },
    { quoteToken: { address: "0x" + "b".repeat(40), symbol: "ETH" } },
    { quoteToken: { address: "0x" + "b".repeat(40), symbol: "WETH" } },
    { labels: ["v3"] },
  ])
    assert.throws(
      () =>
        normalizeMarketPayload(JSON.stringify([pair(change)]), {
          config,
          observedAt: at,
        }),
      /eligible/,
    );
});
test("rejects unavailable numbers and selects most liquid eligible pool deterministically", () => {
  for (const change of [
    { priceNative: "NaN" },
    { priceNative: "" },
    { priceNative: "0" },
    { volume: { h24: null } },
    { liquidity: { usd: 0 } },
    { priceChange: {} },
    { priceChange: { h24: Infinity } },
  ])
    assert.throws(
      () =>
        normalizeMarketPayload(JSON.stringify([pair(change)]), {
          config,
          observedAt: at,
        }),
      /eligible/,
    );
  const better = pair({
    pairAddress: "0x" + "b".repeat(64),
    liquidity: { usd: 30000 },
  });
  const m = normalizeMarketPayload(JSON.stringify([pair(), better]), {
    config,
    observedAt: at,
  });
  assert.equal(m.pairAddress, better.pairAddress);
});
test("persists exact accepted body, hashes and observation; restart reads same evidence", async (t) => {
  const body = "\n" + raw() + "\n";
  const s = await setup(t, async () => new Response(body));
  const m = await s.sample();
  const artifact = JSON.parse(await readFile(m.artifactPath, "utf8"));
  assert.equal(artifact.rawPayload, body);
  assert.deepEqual(artifact.observation, (({ artifactPath, ...o }) => o)(m));
  const restart = new MarketSource({
    root: s.root,
    config,
    fetch: async () => {
      throw Error("offline");
    },
    now: () => Date.parse(at) + 1,
  });
  assert.equal((await restart.loadLatest()).observationHash, m.observationHash);
  await assert.rejects(restart.sample(), /offline/); // never silent fallback
});
test("stale cache cannot become a fresh observation; corrupt archive and clock regression fail closed", async (t) => {
  let clock = Date.parse(at);
  const s = await setup(
    t,
    async () => new Response(raw()),
    () => clock,
  );
  const m = await s.sample();
  clock += 1001;
  await assert.rejects(s.loadLatest(), /stale/);
  clock = Date.parse(at) - 1;
  await assert.rejects(s.sample(), /regression/);
  clock = Date.parse(at);
  const record = JSON.parse(await readFile(m.artifactPath, "utf8"));
  record.rawPayload = "[]";
  await writeFile(m.artifactPath, JSON.stringify(record));
  await assert.rejects(s.loadLatest(), /integrity/);
});
test("rehashing altered normalization cannot sever its binding to the raw payload", async (t) => {
  const s = await setup(t, async () => new Response(raw()));
  const m = await s.sample();
  const { sha256: oldHash, ...record } = JSON.parse(
    await readFile(m.artifactPath, "utf8"),
  );
  record.observation.priceEth = 9;
  const { observationHash, ...body } = record.observation;
  record.observation.observationHash = sha256(canonical(body));
  const hash = sha256(canonical(record));
  await writeFile(
    join(s.directory, hash + ".json"),
    JSON.stringify({ ...record, sha256: hash }),
  );
  await writeFile(s.latestPath, JSON.stringify({ sha256: hash }));
  await assert.rejects(s.loadLatest(), /normalization mismatch/);
});
test("fresh fetch recovers from stale history without relabeling history; contract identity changes fail", async (t) => {
  let clock = Date.parse(at);
  const s = await setup(
    t,
    async () => new Response(raw()),
    () => clock,
  );
  const first = await s.sample();
  clock += 1001;
  const second = await s.sample();
  assert.notEqual(first.observedAt, second.observedAt);
  assert.equal(first.rawSha256, second.rawSha256);
  assert.equal(first.upstreamTimestamp, null);
  assert.equal(second.upstreamTimestamp, null);
  assert.equal(
    JSON.parse(await readFile(first.artifactPath, "utf8")).observation
      .observedAt,
    at,
  );
  const restart = new MarketSource({
    root: s.root,
    config: { ...config, identityProvenance: "different approval" },
    now: () => clock,
  });
  await assert.rejects(restart.loadLatest(), /normalization mismatch/);
});
test("selection is order-independent; duplicate identity, invalid config and oversize payload fail", () => {
  const other = pair({ pairAddress: "0x" + "b".repeat(64) });
  const a = normalizeMarketPayload(JSON.stringify([pair(), other]), {
    config,
    observedAt: at,
  });
  const b = normalizeMarketPayload(JSON.stringify([other, pair()]), {
    config,
    observedAt: at,
  });
  assert.equal(a.pairAddress, b.pairAddress);
  assert.throws(
    () =>
      normalizeMarketPayload(JSON.stringify([pair(), pair()]), {
        config,
        observedAt: at,
      }),
    /duplicate/,
  );
  for (const c of [
    {},
    { ...config, chainId: 1 },
    { ...config, maxAgeMs: NaN },
    { ...config, minLiquidityUsd: 0 },
  ])
    assert.throws(() => new MarketSource({ root: tmpdir(), config: c }));
  assert.throws(
    () =>
      normalizeMarketPayload(" ".repeat(2000001), { config, observedAt: at }),
    /size/,
  );
});
test("HTTP failure, malformed body and redirected source do not persist observations", async (t) => {
  for (const fetch of [
    async () => new Response("no", { status: 503 }),
    async () => new Response("{"),
    async () => ({ ok: true, redirected: true, text: async () => raw() }),
  ]) {
    const s = await setup(t, fetch);
    await assert.rejects(s.sample());
    assert.equal(await s.loadLatest(), null);
  }
});
