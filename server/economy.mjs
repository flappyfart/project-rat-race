import { validAddress, rpcClient } from "./gate.mjs";
export function ethFromWei(hex) {
  if (!/^0x[0-9a-f]+$/i.test(hex)) throw new Error("invalid balance");
  const w = BigInt(hex),
    base = 10n ** 18n;
  const fraction = (w % base).toString().padStart(18, "0").replace(/0+$/, "");
  return (w / base).toString() + (fraction ? "." + fraction : "");
}
export function assessIntent(intent, policy) {
  // Pure validation only. No private key, signing library, approval, or transaction submission exists.
  if (policy?.spendingEnabled !== true)
    return { accepted: false, reason: "spending disabled" };
  if (
    !validAddress(intent?.to) ||
    !Array.isArray(policy.approvedRecipients) ||
    !policy.approvedRecipients.some(
      (a) => a.toLowerCase() === intent.to.toLowerCase(),
    )
  )
    return { accepted: false, reason: "recipient not approved" };
  if (
    !/^\d+$/.test(intent.wei ?? "") ||
    !/^\d+$/.test(policy.maxIntentWei ?? "") ||
    BigInt(intent.wei) <= 0n ||
    BigInt(intent.wei) > BigInt(policy.maxIntentWei)
  )
    return { accepted: false, reason: "amount outside approved cap" };
  if (intent.chainId !== 4663 || intent.data !== "0x")
    return { accepted: false, reason: "unsupported chain or call data" };
  return {
    accepted: true,
    reason: "proposal within policy. no transaction submitted.",
  };
}
export class EconomyObserver {
  constructor({ rpc } = {}) {
    this.rpc = rpc;
    this.busy = false;
    this.record = {
      phase: "unconfigured",
      treasury: null,
      balanceEth: null,
      creatorFeesEth: null,
      earnedIncomeEth: null,
      spendingEnabled: false,
      maxSpendEth: "0",
      events: [],
      reason: "treasury address pending operator configuration",
    };
  }
  status() {
    return structuredClone(this.record);
  }
  async tick(runtime) {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = runtime.config.economy;
      this.record.treasury = validAddress(config?.treasury)
        ? config.treasury
        : null;
      if (!runtime.gate.ok || !runtime.state) {
        this.record = {
          ...this.record,
          phase: "dormant",
          balanceEth: null,
          reason: "economy observations begin after verified launch",
        };
        return;
      }
      if (!validAddress(config?.treasury)) {
        this.record.reason = "treasury address pending operator configuration";
        this.record.phase = "unconfigured";
        return;
      }
      const rpc = this.rpc ?? rpcClient(runtime.config.rpcUrl);
      if (Number(BigInt(await rpc("eth_chainId"))) !== 4663)
        throw new Error("wrong chain");
      const balanceEth = ethFromWei(
        await rpc("eth_getBalance", [config.treasury, "latest"]),
      );
      if (!runtime.gate.ok) return;
      this.record = {
        ...this.record,
        phase: "observing",
        treasury: config.treasury,
        balanceEth,
        creatorFeesEth: null,
        reason:
          "native treasury balance observed. deposits are funding, not earned income.",
        updatedAt: new Date().toISOString(),
      };
    } catch {
      this.record = {
        ...this.record,
        phase: "error",
        balanceEth: null,
        reason: "chain balance unavailable. no estimated balance substituted.",
      };
    } finally {
      this.busy = false;
    }
  }
}
