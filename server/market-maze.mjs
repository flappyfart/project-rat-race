import {
  canonical,
  sha256,
  verifyMarketObservation,
} from "./market-source.mjs";

export const MODEL_VERSION = "market-topology-kruskal-v1";
export const SIZE = 7;
const MOVES = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const BOUNDARY = [
  [0, 0, 7, 0],
  [7, 0, 7, 7],
  [7, 7, 0, 7],
  [0, 7, 0, 0],
];
const cell = (p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((v) => Number.isInteger(v) && v >= 0 && v < SIZE);
/** Boolean movement permission, using integer cell coordinates and learner
 * actions 0:+x, 1:+z, 2:-x, 3:-z. Does not move or teleport the agent.
 */
export function canMove(walls, x, z, action) {
  if (
    !cell([x, z]) ||
    !Number.isInteger(action) ||
    action < 0 ||
    action > 3 ||
    !Array.isArray(walls)
  )
    return false;
  const [dx, dz] = MOVES[action],
    nx = x + dx,
    nz = z + dz;
  if (!cell([nx, nz])) return false;
  return !walls.some(([x1, z1, x2, z2]) =>
    x1 === x2
      ? dx !== 0 &&
        Math.min(x, nx) + 1 === x1 &&
        z + 0.5 > Math.min(z1, z2) &&
        z + 0.5 < Math.max(z1, z2)
      : dz !== 0 &&
        Math.min(z, nz) + 1 === z1 &&
        x + 0.5 > Math.min(x1, x2) &&
        x + 0.5 < Math.max(x1, x2),
  );
}
export function reachable(walls, start, exit = [6, 6]) {
  if (!cell(start) || !cell(exit)) return false;
  const queue = [start],
    seen = new Set([start.join(",")]);
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i];
    if (x === exit[0] && z === exit[1]) return true;
    for (let a = 0; a < 4; a++)
      if (canMove(walls, x, z, a)) {
        const p = [x + MOVES[a][0], z + MOVES[a][1]],
          key = p.join(",");
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(p);
        }
      }
  }
  return false;
}
const quantize = (n, scale, bound) =>
  Math.round(Math.max(-bound, Math.min(bound, n)) * scale);
export function generateMaze({ seed, episode, market, start = [0, 0] }) {
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(episode) ||
    episode < 0 ||
    !cell(start)
  )
    throw Error("invalid maze seed, episode or start cell");
  if (!verifyMarketObservation(market))
    throw Error(
      "maze requires an integrity-validated normalized market observation",
    );
  // The artifact's local absolute path is not a replay input.
  const { artifactPath, ...observation } = market;
  const quantized = {
    priceNanoEth: quantize(market.priceEth, 1e9, 1e6),
    priceChangeBps: quantize(market.priceChange, 100, 10000),
    volatilityBps: quantize(market.volatility, 100, 10000),
    volumeUsd: quantize(market.volume, 1, 1e12),
    liquidityUsd: quantize(market.liquidity, 1, 1e12),
  };
  const entropy = sha256(
    canonical({
      modelVersion: MODEL_VERSION,
      seed,
      episode,
      sourceId: market.sourceId,
      quantized,
    }),
  );
  // Integer stress proxy: higher absolute daily change/turnover closes more loops.
  // Kruskal's spanning tree remains open regardless of stress: all cells, not just
  // a preselected escape route, remain connected. Learning still chooses actions.
  const turnoverPermille = Math.min(
    1000,
    Math.floor(
      (quantized.volumeUsd * 1000) / Math.max(1, quantized.liquidityUsd),
    ),
  );
  const stress = Math.min(1000, quantized.volatilityBps + turnoverPermille);
  const loopOpenPermille = 550 - Math.floor((stress * 400) / 1000);
  const edges = [];
  for (let z = 0; z < SIZE; z++)
    for (let x = 0; x < SIZE; x++) {
      if (x < SIZE - 1)
        edges.push({
          a: z * SIZE + x,
          b: z * SIZE + x + 1,
          wall: [x + 1, z, x + 1, z + 1],
        });
      if (z < SIZE - 1)
        edges.push({
          a: z * SIZE + x,
          b: (z + 1) * SIZE + x,
          wall: [x, z + 1, x + 1, z + 1],
        });
    }
  edges.forEach((e, i) => {
    e.id = i;
    e.rank = sha256(`${entropy}:edge:${i}`);
  });
  const ranked = [...edges].sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id - b.id,
  );
  const parents = Array.from({ length: SIZE * SIZE }, (_, i) => i),
    opened = new Set();
  function root(i) {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  }
  for (const e of ranked) {
    const a = root(e.a),
      b = root(e.b);
    if (a !== b) {
      parents[a] = b;
      opened.add(e.id);
    }
  }
  for (const e of edges)
    if (
      parseInt(sha256(`${entropy}:loop:${e.id}`).slice(0, 8), 16) % 1000 <
      loopOpenPermille
    )
      opened.add(e.id);
  const walls = [
    ...BOUNDARY.map((w) => [...w]),
    ...edges.filter((e) => !opened.has(e.id)).map((e) => e.wall),
  ];
  const inputs = {
    seed,
    episode,
    market: structuredClone(observation),
    start: [...start],
  };
  const snapshot = {
    size: SIZE,
    walls,
    inputs,
    modelVersion: MODEL_VERSION,
    quantized,
    entropy,
    loopOpenPermille,
  };
  if (!reachable(walls, start))
    throw Error("maze reachability invariant failed");
  return { ...snapshot, hash: sha256(canonical(snapshot)) };
}
/** Reconstruct topology, not merely a user-recomputed hash. Hashes prove content
 * consistency, not who supplied a feed or whether a market price is truthful.
 */
export function verifyMaze(snapshot) {
  try {
    if (snapshot?.modelVersion !== MODEL_VERSION) return false;
    return canonical(generateMaze(snapshot.inputs)) === canonical(snapshot);
  } catch {
    return false;
  }
}
