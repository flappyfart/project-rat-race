import { createHash } from "node:crypto";
import { generateMaze, verifyMaze } from "./market-maze.mjs";
export const MODEL_VERSION = "place-cell-sarsa-market-v3";
export const SIZE = 7;
export const MAX_STEPS = 160;
export const HISTORY_LIMIT = 100;
export const TRAIL_LIMIT = MAX_STEPS + 1;
const MOVES = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
export const WALLS = [
  [0, 0, 7, 0],
  [7, 0, 7, 7],
  [7, 7, 0, 7],
  [0, 7, 0, 0],
  [3, 0, 3, 2],
  [3, 3, 3, 7],
  [5, 1, 5, 5],
];
const CENTERS = [1, 3, 5].flatMap((x) => [1, 3, 5].map((z) => [x, z]));
export function features(x, z) {
  return [
    1,
    ...CENTERS.map(([cx, cz]) =>
      Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / 4),
    ),
  ];
}
function random(s) {
  let x = s.rng >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.rng = x >>> 0;
  return s.rng / 4294967296;
}
function values(s, f) {
  return s.weights.map((w) => w.reduce((sum, v, i) => sum + v * f[i], 0));
}
function action(s, x, z) {
  if (random(s) < 0.15) return Math.floor(random(s) * 4);
  const q = values(s, features(x, z)).map(
    (v, i) => v + (s.internetBias?.[i] ?? 0) + (s.advisoryBias?.[i] ?? 0),
  );
  const best = Math.max(...q);
  const tied = q.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  return tied[Math.floor(random(s) * tied.length)];
}
function move(x, z, a, walls = WALLS) {
  const [dx, dz] = MOVES[a],
    nx = x + dx,
    nz = z + dz;
  if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) return [x, z];
  const blocked = walls.some(([x1, z1, x2, z2]) =>
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
  return blocked ? [x, z] : [nx, nz];
}
export function createLearner(seed = 4663) {
  const s = {
    version: MODEL_VERSION,
    seed,
    escape: null,
    topology: null,
    episodeActions: [],
    rng: seed >>> 0 || 1,
    weights: Array.from({ length: 4 }, () => Array(10).fill(0)),
    x: 0,
    z: 0,
    action: 0,
    episode: 1,
    episodeSteps: 0,
    totalSteps: 0,
    episodeReturn: 0,
    trail: [[0.5, 0.5]],
    episodes: [],
    previousPrice: null,
    rewardScale: 1,
  };
  s.action = action(s, 0, 0);
  return s;
}
export function stepLearner(s, market) {
  if (s.escape) {
    if (!verifyEscape(s.escape)) throw new Error("invalid escape proof");
    return s;
  }
  if (!Number.isFinite(market.priceEth) || market.priceEth <= 0)
    throw new Error("learner requires real verified market price");
  if (s.episodeSteps === 0) {
    if (market.observation)
      s.topology = generateMaze({
        seed: s.seed,
        episode: s.episode,
        market: market.observation,
        start: [s.x, s.z],
      });
    s.rewardScale =
      s.previousPrice === null
        ? 1
        : 1 +
          Math.max(
            -0.5,
            Math.min(
              0.5,
              Math.log(market.priceEth) - Math.log(s.previousPrice),
            ),
          );
    s.previousPrice = market.priceEth;
  }
  s.internetBias =
    Array.isArray(market.sensoryInput) &&
    market.sensoryInput.length === 4 &&
    market.sensoryInput.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
      ? market.sensoryInput.map((v) => (v - 0.5) * 0.03)
      : [0, 0, 0, 0];
  s.advisoryBias =
    Array.isArray(market.advisoryInput) &&
    market.advisoryInput.length === 4 &&
    market.advisoryInput.every((v) => Number.isFinite(v) && v >= -1 && v <= 1)
      ? market.advisoryInput.map((v) => v * 0.025)
      : [0, 0, 0, 0];
  if (s.advisoryBias.some((v) => v !== 0)) s.aiAssisted = true;
  const oldFeatures = features(s.x, s.z),
    a = s.action;
  const [x, z] = move(s.x, s.z, a, s.topology?.walls ?? WALLS);
  const reached = x === 6 && z === 6;
  const terminal = reached || s.episodeSteps + 1 >= MAX_STEPS;
  const reward = reached
    ? s.rewardScale
    : x === s.x && z === s.z
      ? -0.04
      : -0.01;
  const nextAction = terminal ? 0 : action(s, x, z);
  const q = values(s, oldFeatures)[a];
  const nextQ = terminal ? 0 : values(s, features(x, z))[nextAction];
  const delta = reward + 0.95 * nextQ - q;
  // Semi-gradient on-policy SARSA(0), fixed radial place-cell-inspired features.
  s.weights[a] = s.weights[a].map((w, i) =>
    Math.max(-100, Math.min(100, w + 0.03 * delta * oldFeatures[i])),
  );
  s.x = x;
  s.z = z;
  s.action = nextAction;
  s.totalSteps++;
  s.episodeSteps++;
  s.episodeReturn += reward;
  s.episodeActions.push(a);
  s.trail.push([x + 0.5, z + 0.5]);
  s.trail = s.trail.slice(-TRAIL_LIMIT);
  if (terminal) {
    s.episodes.push({
      episode: s.episode,
      steps: s.episodeSteps,
      return: s.episodeReturn,
      reachedReward: reached,
      marketTimestamp: market.timestamp,
      priceEth: market.priceEth,
    });
    s.episodes = s.episodes.slice(-HISTORY_LIMIT);
    if (reached) {
      const proof = {
        modelVersion: MODEL_VERSION,
        topology: s.topology ? structuredClone(s.topology) : null,
        aiAssisted: s.aiAssisted === true,
        seed: s.seed,
        episode: s.episode,
        steps: s.episodeSteps,
        totalSteps: s.totalSteps,
        marketTimestamp: market.timestamp,
        route: structuredClone(s.trail),
        actions: [...s.episodeActions],
      };
      s.escape = {
        ...proof,
        hash: createHash("sha256").update(JSON.stringify(proof)).digest("hex"),
      };
    }
    s.episode++;
    s.episodeSteps = 0;
    s.episodeReturn = 0;
    if (!reached) {
      s.x = 0;
      s.z = 0;
      s.trail = [[0.5, 0.5]];
      s.episodeActions = [];
      s.action = action(s, 0, 0);
    }
  }
  validateLearner(s);
  return s;
}
export function verifyEscape(proof) {
  try {
    if (
      !proof ||
      proof.modelVersion !== MODEL_VERSION ||
      !Number.isSafeInteger(proof.steps) ||
      proof.steps < 1 ||
      proof.steps > MAX_STEPS ||
      !Number.isSafeInteger(proof.totalSteps) ||
      proof.totalSteps < proof.steps ||
      !Number.isSafeInteger(proof.episode) ||
      proof.episode < 1 ||
      !Number.isFinite(Date.parse(proof.marketTimestamp))
    )
      return false;
    const { hash, ...payload } = proof;
    if (
      hash !==
      createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    )
      return false;
    if (
      !Array.isArray(proof.route) ||
      proof.route.length !== proof.steps + 1 ||
      !Array.isArray(proof.actions) ||
      proof.actions.length !== proof.steps
    )
      return false;
    if (
      JSON.stringify(proof.route[0]) !== "[0.5,0.5]" ||
      JSON.stringify(proof.route.at(-1)) !== "[6.5,6.5]"
    )
      return false;
    if (
      proof.topology &&
      (!verifyMaze(proof.topology) ||
        proof.topology.inputs.seed !== proof.seed ||
        proof.topology.inputs.episode !== proof.episode)
    )
      return false;
    const walls = proof.topology?.walls ?? WALLS;
    let x = 0,
      z = 0;
    for (let i = 0; i < proof.actions.length; i++) {
      const a = proof.actions[i];
      if (!Number.isInteger(a) || a < 0 || a > 3) return false;
      [x, z] = move(x, z, a, walls);
      if (
        JSON.stringify(proof.route[i + 1]) !==
        JSON.stringify([x + 0.5, z + 0.5])
      )
        return false;
      if (x === 6 && z === 6 && i < proof.actions.length - 1) return false;
    }
    return x === 6 && z === 6;
  } catch {
    return false;
  }
}
export function validateLearner(s) {
  if (
    s.topology &&
    (!verifyMaze(s.topology) ||
      s.topology.inputs.seed !== s.seed ||
      ![s.episode, s.episode - 1].includes(s.topology.inputs.episode))
  )
    throw new Error("invalid market topology checkpoint");
  if (
    s.escape !== null &&
    s.escape !== undefined &&
    (!verifyEscape(s.escape) ||
      s.x !== 6 ||
      s.z !== 6 ||
      s.totalSteps !== s.escape.totalSteps)
  )
    throw new Error("invalid checkpoint escape proof");
  if (
    !Array.isArray(s.episodeActions) ||
    s.episodeActions.length !== (s.escape ? s.escape.steps : s.episodeSteps) ||
    s.episodeActions.some((a) => !Number.isInteger(a) || a < 0 || a > 3)
  )
    throw new Error("invalid checkpoint action history");
  const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  if (
    !s ||
    s.version !== MODEL_VERSION ||
    !integer(s.rng, 1, 4294967295) ||
    !integer(s.x, 0, 6) ||
    !integer(s.z, 0, 6) ||
    !integer(s.action, 0, 3) ||
    !integer(s.episode, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(s.totalSteps, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(s.episodeSteps, 0, MAX_STEPS - 1)
  )
    throw new Error("invalid checkpoint learner state");
  if (
    !Array.isArray(s.weights) ||
    s.weights.length !== 4 ||
    s.weights.some(
      (w) =>
        !Array.isArray(w) ||
        w.length !== 10 ||
        w.some((v) => !Number.isFinite(v) || Math.abs(v) > 100),
    )
  )
    throw new Error("invalid checkpoint weights");
  if (
    !Number.isFinite(s.episodeReturn) ||
    !Number.isFinite(s.rewardScale) ||
    s.rewardScale < 0.5 ||
    s.rewardScale > 1.5 ||
    (s.previousPrice !== null &&
      (!Number.isFinite(s.previousPrice) || s.previousPrice <= 0))
  )
    throw new Error("invalid checkpoint reward");
  if (
    !Array.isArray(s.trail) ||
    s.trail.length < 1 ||
    s.trail.length > TRAIL_LIMIT ||
    s.trail.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((v) => !Number.isFinite(v) || v < 0.5 || v > 6.5),
    )
  )
    throw new Error("invalid checkpoint trail");
  if (
    s.advisoryBias !== undefined &&
    (!Array.isArray(s.advisoryBias) ||
      s.advisoryBias.length !== 4 ||
      s.advisoryBias.some((v) => !Number.isFinite(v) || Math.abs(v) > 0.025))
  )
    throw new Error("invalid advisory bias");
  if (
    s.internetBias !== undefined &&
    (!Array.isArray(s.internetBias) ||
      s.internetBias.length !== 4 ||
      s.internetBias.some((v) => !Number.isFinite(v) || Math.abs(v) > 0.015))
  )
    throw new Error("invalid sensory bias");
  if (
    !Array.isArray(s.episodes) ||
    s.episodes.length > HISTORY_LIMIT ||
    s.episodes.some(
      (e) =>
        !integer(e.episode, 1, s.episode - 1) ||
        !integer(e.steps, 1, MAX_STEPS) ||
        !Number.isFinite(e.return) ||
        typeof e.reachedReward !== "boolean" ||
        !Number.isFinite(e.priceEth) ||
        e.priceEth <= 0 ||
        !Number.isFinite(Date.parse(e.marketTimestamp)),
    )
  )
    throw new Error("invalid checkpoint history");
}
export function mazeView(s) {
  return {
    size: SIZE,
    walls: (s.topology?.walls ?? WALLS).map((w) => [...w]),
    rat: { x: s.x + 0.5, z: s.z + 0.5, heading: (s.action * Math.PI) / 2 },
    reward: { x: 6.5, z: 6.5 },
    trail: s.trail.map((p) => [...p]),
  };
}
