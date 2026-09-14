import { readFile } from "node:fs/promises";
import { MODEL_VERSION } from "./learner.mjs";

// A real disabled mode, not a simulated Solana implementation. No wallet,
// browser, RPC client, learner state or paid agent is constructed here.
export async function createAwaitingLaunchEngine({ configPath }) {
  let config = {},
    closed = false;
  const load = async () => {
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      config = {};
    }
  };
  const reason = () =>
    closed
      ? "operator stopped the waiting service"
      : config.contract
        ? "solana mint supplied; verification and funding adapters still required"
        : "awaiting solana CA. experiment and paid activity disabled";
  const status = () => ({
    phase: config.enabled ? "verification_pending" : "prelaunch",
    experimentPhase: "sealed",
    reason: reason(),
    chainNamespace: "solana",
    chainId: null,
    quoteAsset: "SOL",
    contract: null,
    launchTx: null,
    startedAt: null,
    episode: 0,
    totalSteps: 0,
    feesReceivedEth: null,
    stateHash: null,
    sourceStatus: "solana market input not configured",
    modelVersion: MODEL_VERSION,
    maze: null,
    escape: null,
    updatedAt: new Date().toISOString(),
  });
  const runtime = {
    state: null,
    gate: { ok: false, phase: "prelaunch", reason: reason() },
    isAuthorized: () => false,
    status,
    history: () => ({ episodes: [] }),
    protocol: () => ({
      launch: status(),
      method: {
        name: "awaiting new solana experiment",
        modelVersion: MODEL_VERSION,
        isWholeBrainModel: false,
        anatomy: "reference only",
        activation:
          "solana mint and launch evidence must be verified using a Solana-specific adapter before activation",
        solanaAdapterReady: false,
        internet: { enabled: false },
        economy: { treasuryConfigured: false, spendingEnabled: false },
        record:
          "the prior robinhood test was archived privately; this run has no checkpoint or work history",
      },
    }),
  };
  const services = {
    market: {
      status: () => ({
        available: false,
        reason: "solana market input awaiting configuration",
      }),
    },
    internet: {
      status: () => ({
        phase: "dormant",
        url: null,
        title: null,
        pagesOpened: 0,
        lastObservedAt: null,
        events: [],
        screenshotUrl: null,
        frameId: null,
        reason: "awaiting solana launch; no browser running",
      }),
      frame: async () => null,
    },
    economy: {
      status: () => ({
        phase: "unconfigured",
        treasury: null,
        balanceEth: null,
        baseEth: null,
        baseUsdc: null,
        creditUsd: null,
        confirmedFundingEth: null,
        creatorFeesEth: null,
        earnedIncomeEth: null,
        spendingEnabled: false,
        maxSpendEth: "0",
        events: [],
        observedAt: null,
        reason:
          "solana funding route not configured. previous wallet funds and financial records remain separate and untouched",
      }),
    },
    workshop: {
      status: () => ({
        phase: "locked",
        reason: reason(),
        escapeVerified: false,
        aiConfigured: false,
        topupsEnabled: false,
        approvalMode: "mission",
        perActionApproval: false,
        executionStatus: "disabled",
        mission: "await verified solana launch configuration",
        projects: [],
        events: [],
        cycles: 0,
        activity: {
          version: 1,
          observedAt: new Date().toISOString(),
          since: null,
          stage: "locked",
          tool: null,
          intent: null,
          nextAt: null,
          workspace: null,
        },
        compute: "disabled",
      }),
    },
  };
  const engine = {
    runtime,
    services,
    initialize: async () => {
      await load();
      runtime.gate.reason = reason();
      return services;
    },
    tick: async () => {
      if (!closed) {
        await load();
        runtime.gate.reason = reason();
      }
    },
    close: async () => {
      closed = true;
      runtime.gate.reason = reason();
    },
  };
  await engine.initialize();
  return engine;
}
