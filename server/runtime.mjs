import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { verifyLaunch, CHAIN_ID, validAddress } from "./gate.mjs";
import {
  createLearner,
  stepLearner,
  validateLearner,
  mazeView,
  MODEL_VERSION,
  MAX_STEPS,
  HISTORY_LIMIT,
  TRAIL_LIMIT,
} from "./learner.mjs";
export const hashState = (state) =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex");
export async function readConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { enabled: false, contract: null, launchTx: null };
  }
}
async function saveCheckpoint(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ ...data, hash: hashState(data) }));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    if (handle) await handle.close();
    await unlink(temp).catch(() => {});
  }
}
export class Runtime {
  constructor({ configPath, checkpointPath, dependencies = {} }) {
    this.configPath = configPath;
    this.checkpointPath = checkpointPath;
    this.dependencies = dependencies;
    this.config = { enabled: false };
    this.state = null;
    this.identity = null;
    this.gate = {
      ok: false,
      phase: "prelaunch",
      reason: "operator launch disabled",
      sourceStatus: "unavailable",
    };
    this.updatedAt = new Date().toISOString();
    this.busy = false;
    this.fatal = false;
  }
  async initialize() {
    this.config = await readConfig(this.configPath);
    return this;
  }
  isAuthorized() {
    return (
      this.gate.ok === true &&
      (!this.gate.verificationExpiresAt ||
        Date.now() < this.gate.verificationExpiresAt)
    );
  }
  async tick({ advance = true } = {}) {
    if (this.busy || this.fatal) return;
    this.busy = true;
    try {
      this.config = await readConfig(this.configPath);
      if (this.gate.ok && !this.isAuthorized())
        this.gate = {
          ...this.gate,
          ok: false,
          phase: this.state ? "paused" : "verification_pending",
          reason: "chain verification refresh pending",
        };
      this.gate = await verifyLaunch(this.config, this.dependencies);
      if (this.gate.ok && this.dependencies.launchFreshUntil) {
        this.gate.verificationExpiresAt = this.dependencies.launchFreshUntil();
        if (!this.isAuthorized())
          this.gate = {
            ...this.gate,
            ok: false,
            phase: "verification_pending",
            reason: "chain verification expired during refresh",
          };
      }
      this.updatedAt = new Date().toISOString();
      if (!this.gate.ok) {
        if (this.state) this.gate.phase = "paused";
        return;
      }
      const identity = {
        chainId: CHAIN_ID,
        contract: this.gate.contract,
        launchTx: this.gate.launchTx,
        blockHash: this.gate.blockHash,
        startedAt: this.gate.startedAt,
        modelVersion: MODEL_VERSION,
      };
      if (
        this.identity &&
        JSON.stringify(this.identity) !== JSON.stringify(identity)
      )
        throw new Error(
          "launch identity changed; separate operator state migration required",
        );
      if (!this.state) {
        let saved;
        try {
          saved = JSON.parse(await readFile(this.checkpointPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT")
            throw new Error("checkpoint unreadable; refusing reset");
        }
        if (saved) {
          const { hash, ...payload } = saved;
          if (
            hash !== hashState(payload) ||
            JSON.stringify(saved.identity) !== JSON.stringify(identity)
          )
            throw new Error("checkpoint integrity or launch identity mismatch");
          validateLearner(saved.state);
          if (
            this.config.market?.kind === "dex_reference" &&
            !saved.state.topology
          )
            throw new Error("market topology checkpoint missing");
          this.state = saved.state;
        } else if (advance) {
          if (
            this.dependencies.startupReady &&
            !(await this.dependencies.startupReady())
          ) {
            this.gate = {
              ...this.gate,
              ok: false,
              phase: "verification_pending",
              reason: "awaiting confirmed usable funding",
            };
            return;
          }
          if (
            !Number.isInteger(this.config.seed) ||
            this.config.seed < 1 ||
            this.config.seed > 4294967295
          )
            throw new Error("invalid learner seed");
          this.state = createLearner(this.config.seed);
        }
        this.identity = identity;
      }
      if (advance && this.state && !this.state.escape) {
        // Commit first; never publish an unpersisted learner step.
        const next = stepLearner(structuredClone(this.state), {
          ...this.gate.market,
          sensoryInput:
            this.sensoryInput &&
            Date.now() - Date.parse(this.sensoryInput.observedAt) < 60000
              ? this.sensoryInput.values
              : null,
          advisoryInput:
            this.researchAdvice &&
            Date.now() - Date.parse(this.researchAdvice.observedAt) < 300000
              ? this.researchAdvice.scores
              : null,
        });
        await saveCheckpoint(this.checkpointPath, { identity, state: next });
        this.state = next;
      }
    } catch (error) {
      this.fatal = true;
      this.gate = {
        ok: false,
        phase: "error",
        reason: error.message,
        sourceStatus: "unavailable",
      };
    } finally {
      this.busy = false;
    }
  }
  status() {
    const expired = this.gate.ok && !this.isAuthorized();
    return {
      experimentPhase: !this.state
        ? "sealed"
        : this.state.escape
          ? "escaped"
          : "maze",
      escape: this.state?.escape
        ? {
            episode: this.state.escape.episode,
            totalSteps: this.state.escape.totalSteps,
            hash: this.state.escape.hash,
          }
        : null,
      phase: expired
        ? this.state
          ? "paused"
          : "verification_pending"
        : this.gate.phase,
      reason: expired ? "chain verification refresh pending" : this.gate.reason,
      chainId: CHAIN_ID,
      quoteAsset: "ETH",
      contract: validAddress(this.config.contract)
        ? this.config.contract.toLowerCase()
        : null,
      launchTx: /^0x[0-9a-f]{64}$/i.test(this.config.launchTx ?? "")
        ? this.config.launchTx.toLowerCase()
        : null,
      startedAt: this.state ? (this.identity?.startedAt ?? null) : null,
      episode: this.state?.escape?.episode ?? this.state?.episode ?? 0,
      totalSteps: this.state?.totalSteps ?? 0,
      feesReceivedEth: null,
      stateHash: this.state ? hashState(this.state) : null,
      sourceStatus: this.gate.sourceStatus,
      modelVersion: MODEL_VERSION,
      maze: this.state ? mazeView(this.state) : null,
      updatedAt: this.updatedAt,
    };
  }
  history() {
    return { episodes: structuredClone(this.state?.episodes ?? []) };
  }
  protocol() {
    return {
      launch: this.status(),
      method: {
        name: "place-cell-inspired navigation prototype",
        modelVersion: MODEL_VERSION,
        isRatInABox: false,
        isWholeBrainModel: false,
        escapeRule:
          "first mechanically verified complete route; no scheduled timestamp; maze freezes after escape",
        aiTools:
          "wallet-funded external AI agent with persistent memory, restricted research, isolated execution and verification-gated work previews after verified escape",
        experimentalValidation: "not established",
        algorithm: "semi-gradient on-policy sarsa(0)",
        internetAdapter:
          "four measured screenshot quadrant luminances; authored motor bias (luminance - 0.5) * 0.03; 60 second sensor freshness; model weight projections select only allowed article links; no semantic understanding",
        internet: {
          enabled: this.config.internet?.enabled === true,
          permittedByLaunchGate: this.gate.ok && !!this.state,
          allowedHost: "en.wikipedia.org",
          javascriptEnabled: false,
          accounts: false,
          signing: false,
        },
        economy: {
          treasuryConfigured: validAddress(this.config.economy?.treasury),
          spendingEnabled:
            this.config.economy?.spendingEnabled === true &&
            this.gate.ok &&
            !!this.state,
          creatorFeeAttribution:
            "unattributed deposits remain funding, not earned income",
        },
        features: "bias plus nine fixed gaussian spatial features",
        learningRate: 0.03,
        discount: 0.95,
        exploration: 0.15,
        seed: this.config.seed ?? null,
        mazeSize: 7,
        maxEpisodeSteps: MAX_STEPS,
        historyLimit: HISTORY_LIMIT,
        trailLimit: TRAIL_LIMIT,
        marketUse:
          "each attempt generates a reachable topology from a recorded market snapshot, seed and episode. daily price-change and turnover proxies affect passages. full topology and normalized observation are retained for replay. no liquidation or corporate-action feed claim",
        fees: "not ingested; null",
        checkpoint:
          "atomic json with sha256 integrity and launch identity; no prelaunch writes",
        launchTime:
          "canonical launch receipt block timestamp, never local wall clock",
        proofSupport: [
          "direct contractAddress deployment",
          "erc20 Transfer mint from zero emitted by configured token; no guessed pons factory abi",
        ],
        minConfirmations: this.config.minConfirmations ?? null,
        operatorEnabled: this.config.enabled === true,
        marketSourceId: this.config.market?.sourceId ?? null,
        marketOperatorVerified: this.config.market?.operatorVerified === true,
        marketMaxAgeSeconds: this.config.market?.maxAgeSeconds ?? null,
      },
    };
  }
}
