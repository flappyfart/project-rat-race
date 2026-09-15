import { readFile } from "node:fs/promises";
import { MODEL_VERSION } from "./learner.mjs";

// Explicitly disabled presentation mode. No wallet, RPC client, browser,
// learner state or paid agent is constructed for any network.
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
  const network = () =>
    config.launchNetwork === "robinhood"
      ? {
          name: "robinhood chain",
          namespace: "eip155",
          chainId: 4663,
          quote: "ETH",
        }
      : config.launchNetwork === "solana"
        ? { name: "solana", namespace: "solana", chainId: null, quote: "SOL" }
        : {
            name: "unconfigured network",
            namespace: null,
            chainId: null,
            quote: "",
          };
  const reason = () =>
    closed
      ? "operator stopped the waiting service"
      : config.contract
        ? `${network().name} contract supplied; verification, funding and explicit activation still required`
        : `awaiting new ${network().name} CA. experiment and paid activity disabled`;
  const status = () => ({
    phase: config.enabled ? "verification_pending" : "prelaunch",
    experimentPhase: "sealed",
    reason: reason(),
    chainNamespace: network().namespace,
    chainId: network().chainId,
    quoteAsset: network().quote,
    tokenSymbol: config.tokenSymbol ?? null,
    contract: null,
    launchTx: null,
    startedAt: null,
    episode: 0,
    totalSteps: 0,
    feesReceivedEth: null,
    stateHash: null,
    sourceStatus: `${network().name} market input not configured`,
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
        name: `awaiting new ${network().name} experiment`,
        modelVersion: MODEL_VERSION,
        isWholeBrainModel: false,
        anatomy: "reference only",
        activation:
          "the new contract, launch evidence, data source and funding configuration require verification and explicit activation",
        runtimeMode: "awaiting_launch",
        activationEnabled: false,
        ...(network().namespace === "solana"
          ? { solanaAdapterReady: false }
          : {}),
        internet: { enabled: false },
        economy: { treasuryConfigured: false, spendingEnabled: false },
        record:
          "previous runs remain archived separately; this run has no checkpoint or work history",
      },
    }),
  };
  const services = {
    market: {
      status: () => ({
        available: false,
        reason: `${network().name} market input awaiting configuration`,
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
        reason: `awaiting ${network().name} launch; no browser running`,
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
          "funding configuration awaits explicit setup. previous wallet funds and financial records remain separate and untouched",
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
        mission: `await verified ${network().name} launch configuration`,
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
