import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { Runtime } from "./runtime.mjs";
import { MarketSource } from "./market-source.mjs";
import { MarketCache, ResourceMonitor } from "./engine-services.mjs";
import { WalletTransport } from "./wallet-transport.mjs";
import { FundingService } from "./funding-service.mjs";
import { LimaRunner } from "./lima-runner.mjs";
import { AgentTools } from "./agent-tools.mjs";
import { AgentLoop } from "./agent-loop.mjs";
import { InternetObserver } from "./internet.mjs";
import { Publications } from "./publications.mjs";
import { CreditGuard } from "./credit-guard.mjs";
export async function createEngine({
  configPath,
  stateRoot,
  financialRoot = path.join(
    homedir(),
    ".local/share/project-rat-race/finance-v1",
  ),
  rpc,
  rehearsal = false,
  paymentPolicy = {},
  publicBase = "https://projectratrace.org/work",
  allowRehearsalSpend = () => false,
  agentIntervalMs = 60000,
} = {}) {
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  let runtime;
  let closed = false;
  const source = new MarketSource({
      root: path.join(stateRoot, "sources"),
      config: {
        assetContract: cfg.market.assetContract,
        identityProvenance: cfg.market.identityProvenance,
        minLiquidityUsd: cfg.market.minLiquidityUsd ?? 10000,
      },
    }),
    market = new MarketCache(source);
  const canSpend = async () => {
    if (closed) return false;
    if (rehearsal) return allowRehearsalSpend();
    const current = JSON.parse(await readFile(configPath, "utf8"));
    return (
      current.enabled === true &&
      current.economy?.spendingEnabled === true &&
      runtime?.gate.ok === true &&
      !!runtime.state &&
      current.contract?.toLowerCase() === runtime.identity?.contract
    );
  };
  const transport = await new WalletTransport({
      root: path.join(financialRoot, "transport"),
      isRehearsal: rehearsal,
      canSpend,
    }).initialize(),
    funding = new FundingService({
      root: financialRoot,
      transport,
      policy: paymentPolicy,
    }),
    resources = new ResourceMonitor(transport, funding),
    runner = new LimaRunner();
  if (cfg.economy?.treasury?.toLowerCase() !== transport.address.toLowerCase())
    throw Error("treasury configuration does not match wallet custody");
  const tools = new AgentTools({
      root: path.join(stateRoot, "workspace"),
      publishRoot: path.join(stateRoot, "published"),
      runner,
      publicBase,
    }),
    agent = new AgentLoop({
      root: path.join(stateRoot, "agent"),
      transport,
      tools,
      intervalMs: agentIntervalMs,
    }),
    publications = new Publications(path.join(stateRoot, "published"));
  runtime = await new Runtime({
    configPath,
    checkpointPath: path.join(stateRoot, "checkpoint.json"),
    dependencies: {
      ...(rpc ? { rpc } : {}),
      marketFetch: () => market.get(),
      startupReady: async () => runner.ready && resources.startupReady(),
    },
  }).initialize();
  const internet = new InternetObserver({
    root: path.join(stateRoot, "internet"),
  });
  let fundingTask = null,
    lastFunding = 0,
    lastHealth = 0;
  const driveFunding = (urgent = false) => {
    const permitted = () =>
      !closed && resources.active && runtime.gate.ok && !!runtime.state;
    if (!permitted())
      return Promise.resolve({ ...funding.status(), gate: "closed" });
    if (fundingTask) return fundingTask;
    if (!urgent && Date.now() - lastFunding < 10000)
      return Promise.resolve(funding.status());
    lastFunding = Date.now();
    fundingTask = funding
      .tick({
        authorized: true,
        launchVerified: true,
        hasExperimentState: true,
        isAuthorized: permitted,
      })
      .catch(() => {
        resources.error = "automatic refill service unavailable";
        return {
          state: "unavailable",
          pending: true,
          result: "funding-service-unavailable",
        };
      })
      .finally(() => {
        fundingTask = null;
      });
    return fundingTask;
  };
  const creditGuard = new CreditGuard({
    credits: () => transport.credits(),
    refill: () => driveFunding(true),
    policy: { refillAtUsdMicros: funding.status().policy.minCreditsUsdMicros },
  });
  transport.creditGuard = creditGuard;
  const services = {
    internet,
    economy: resources,
    workshop: {
      status: () => ({
        ...agent.status(),
        aiConfigured: transport.ready,
        topupsEnabled: resources.active,
        executionStatus: runner.ready ? "connected" : "unavailable",
        creditSafety: creditGuard.status(),
      }),
    },
    publications,
    market,
  };
  return {
    runtime,
    source,
    market,
    transport,
    funding,
    creditGuard,
    resources,
    runner,
    tools,
    agent,
    publications,
    internet,
    services,
    async initialize() {
      await Promise.all([
        market.refresh(true),
        resources.refresh(true),
        runner.health().catch(() => {}),
      ]);
      await runtime.tick({ advance: false });
      return services;
    },
    async tick({ advance = true } = {}) {
      if (closed) return;
      void market.refresh();
      void resources.refresh();
      if (Date.now() - lastHealth > 60000) {
        lastHealth = Date.now();
        void runner.health().catch(() => {
          runner.ready = false;
        });
      }
      await runtime.tick({ advance });
      resources.active =
        runtime.gate.ok &&
        !!runtime.state &&
        runtime.config.economy?.spendingEnabled === true;
      void internet.tick(runtime);
      if (resources.active) {
        void driveFunding();
        void creditGuard.poll();
      }
      if (!rehearsal) void agent.tick(runtime, resources.status());
    },
    async close() {
      closed = true;
      resources.active = false;
      runtime.gate = {
        ...runtime.gate,
        ok: false,
        phase: "paused",
        reason: "operator stopped the engine",
      };
      await internet.stop("operator stopped the experiment");
    },
  };
}
