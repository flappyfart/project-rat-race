export type Maze = {
  size: number;
  walls: number[][];
  rat: { x: number; z: number; heading: number };
  reward: { x: number; z: number };
  trail: number[][];
};
export type Status = {
  experimentPhase?: "sealed" | "maze" | "escaped";
  escape?: { episode: number; totalSteps: number; hash: string } | null;
  phase: "prelaunch" | "verification_pending" | "live" | "paused" | "error";
  reason: string;
  chainId: number | null;
  chainNamespace?: "eip155" | "solana";
  quoteAsset: string;
  contract: string | null;
  launchTx: string | null;
  startedAt: string | null;
  activatedAt?: string | null;
  episode: number;
  totalSteps: number;
  feesReceivedEth: number | null;
  stateHash: string | null;
  sourceStatus: string;
  modelVersion: string;
  maze: Maze | null;
  updatedAt: string;
};
export const locked: Status = {
  phase: "prelaunch",
  reason: "awaiting new robinhood chain CA",
  chainNamespace: "eip155",
  chainId: 4663,
  quoteAsset: "ETH",
  contract: null,
  launchTx: null,
  startedAt: null,
  episode: 0,
  totalSteps: 0,
  feesReceivedEth: null,
  stateHash: null,
  sourceStatus: "not connected",
  modelVersion: "place-cell-sarsa-market-v3",
  maze: null,
  updatedAt: "",
};
