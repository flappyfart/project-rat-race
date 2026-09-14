import test from "node:test";
import assert from "node:assert/strict";
import {
  generateMaze,
  verifyMaze,
  canMove,
  reachable,
} from "./market-maze.mjs";
import {
  normalizeMarketPayload,
  NATIVE_ETH,
  canonical,
  sha256,
} from "./market-source.mjs";
function market(overrides = {}) {
  return normalizeMarketPayload(
    JSON.stringify([
      {
        chainId: "robinhood",
        dexId: "uniswap",
        labels: ["v4"],
        pairAddress: "0x" + "a".repeat(64),
        baseToken: { address: "0x" + "b".repeat(40) },
        quoteToken: { address: NATIVE_ETH },
        priceNative: "0.1",
        priceUsd: "250",
        priceChange: { h24: 3 },
        volume: { h24: 10000 },
        liquidity: { usd: 20000 },
        ...overrides,
      },
    ]),
    {
      config: {
        assetContract: "0x" + "b".repeat(40),
        identityProvenance: "synthetic offline fixture",
      },
      observedAt: "2026-09-13T00:00:00.000Z",
    },
  );
}
test("same seed episode observation and position reproduce exact walls and hash through JSON", () => {
  const args = { seed: 4663, episode: 1, market: market() };
  const a = generateMaze(args);
  assert.deepEqual(generateMaze(JSON.parse(JSON.stringify(args))), a);
  assert.ok(verifyMaze(a));
  assert.deepEqual(generateMaze(a.inputs), a);
  assert.equal(a.size, 7);
  const corrupt = structuredClone(a);
  corrupt.walls.pop();
  assert.equal(verifyMaze(corrupt), false);
  assert.equal(verifyMaze({ ...a, hash: "a".repeat(64) }), false);
});
test("price, price-change/volatility proxy, volume, liquidity and episode really change walls", () => {
  const args = { seed: 42, episode: 3, market: market() };
  const walls = generateMaze(args).walls;
  for (const change of [
    { priceNative: "0.2" },
    { priceChange: { h24: -20 } },
    { volume: { h24: 100000 } },
    { liquidity: { usd: 100000 } },
  ])
    assert.notDeepEqual(
      generateMaze({ ...args, market: market(change) }).walls,
      walls,
    );
  assert.notDeepEqual(generateMaze({ ...args, episode: 4 }).walls, walls);
});
test("all 49 starts remain exit-reachable over 40 seeds and changing market extremes", () => {
  for (let seed = 0; seed < 40; seed++)
    for (let x = 0; x < 7; x++)
      for (let z = 0; z < 7; z++) {
        const maze = generateMaze({
          seed,
          episode: seed,
          market: market({
            priceChange: { h24: seed % 2 ? -100 : 1000 },
            volume: { h24: seed * 10000000 },
          }),
          start: [x, z],
        });
        assert.ok(reachable(maze.walls, [x, z], [6, 6]));
        assert.ok(verifyMaze(maze));
      }
});
test("actions and boundary walls match learner coordinates, including long/reversed wall segments", () => {
  const walls = [
    [3, 0, 3, 2],
    [3, 7, 3, 3],
    [5, 1, 5, 5],
  ];
  assert.equal(canMove(walls, 2, 0, 0), false);
  assert.equal(canMove(walls, 3, 0, 2), false);
  assert.equal(canMove(walls, 2, 2, 0), true);
  assert.equal(canMove(walls, 4, 2, 0), false);
  assert.equal(canMove(walls, 0, 0, 2), false);
  assert.equal(canMove(walls, 0, 0, 3), false);
  assert.equal(canMove(walls, 6, 6, 0), false);
  assert.equal(canMove(walls, 6, 6, 1), false);
  assert.equal(canMove(walls, 1, 1, 4), false);
  assert.equal(reachable(walls, [-1, 0]), false);
});
test("local re-observation does not churn topology; observation hash still changes", () => {
  const m = market(),
    next = { ...m, observedAt: "2026-09-13T00:00:01.000Z" };
  const { observationHash, ...body } = next;
  next.observationHash = sha256(canonical(body));
  const a = generateMaze({ seed: 1, episode: 1, market: m }),
    b = generateMaze({ seed: 1, episode: 1, market: next });
  assert.deepEqual(a.walls, b.walls);
  assert.notEqual(a.hash, b.hash);
  // Rehashed walls alone are not a valid replay: generation must agree too.
  const changed = structuredClone(a);
  changed.walls.pop();
  const { hash, ...snapshot } = changed;
  changed.hash = sha256(canonical(snapshot));
  assert.equal(verifyMaze(changed), false);
});
test("rejects unvalidated, tampered or missing observation; invalid seeds and positions", () => {
  const args = { seed: 1, episode: 1, market: market() };
  for (const change of [
    { market: { priceEth: 1 } },
    { market: { ...market(), priceEth: 2 } },
    { seed: NaN },
    { episode: -1 },
    { start: [7, 0] },
    { start: [0.5, 0] },
  ])
    assert.throws(() => generateMaze({ ...args, ...change }));
});
