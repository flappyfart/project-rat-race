import { formatEther, formatUnits } from "ethers";
import { DEFAULT_CREDIT_POLICY } from "./credit-guard.mjs";
import { USDC, usdcAbi } from "../scripts/lib/payment-checks.mjs";
export class MarketCache {
  constructor(source) {
    this.source = source;
    this.current = null;
    this.error = null;
    this.busy = false;
    this.lastAttempt = 0;
  }
  async refresh(force = false) {
    if (this.busy || (!force && Date.now() - this.lastAttempt < 30000)) return;
    this.busy = true;
    this.lastAttempt = Date.now();
    try {
      this.current = await this.source.sample();
      this.error = null;
    } catch (e) {
      this.error = String(e.message).slice(0, 240);
    } finally {
      this.busy = false;
    }
  }
  async get() {
    if (!this.current) throw Error("reference market not available");
    if (Date.now() - Date.parse(this.current.observedAt) > 120000)
      throw Error("reference market stale");
    return this.current;
  }
  status() {
    if (!this.current)
      return {
        available: false,
        reason: this.error ?? "market observation pending",
      };
    const { artifactPath, ...m } = this.current;
    return {
      available: Date.now() - Date.parse(m.observedAt) <= 120000,
      observation: m,
      error: this.error,
    };
  }
}
export class ResourceMonitor {
  constructor(transport, funding) {
    this.transport = transport;
    this.funding = funding;
    this.latest = null;
    this.busy = false;
    this.lastAttempt = 0;
    this.error = null;
    this.active = false;
  }
  async refresh(force = false) {
    if (this.busy || (!force && Date.now() - this.lastAttempt < 20000)) return;
    this.busy = true;
    this.lastAttempt = Date.now();
    try {
      const data = await this.funding.inspect();
      const head = BigInt(await this.transport.rpc(4663, "eth_blockNumber"));
      const confirmed = await this.transport.rpc(4663, "eth_getBalance", [
        this.transport.address,
        "0x" + (head - 11n).toString(16),
      ]);
      const bh = BigInt(await this.transport.rpc(8453, "eth_blockNumber"));
      const cu = await this.transport.rpc(8453, "eth_call", [
        {
          to: USDC,
          data: usdcAbi.encodeFunctionData("balanceOf", [
            this.transport.address,
          ]),
        },
        "0x" + (bh - 11n).toString(16),
      ]);
      this.latest = {
        ...data,
        confirmedBaseUsdc: usdcAbi
          .decodeFunctionResult("balanceOf", cu)[0]
          .toString(),
        confirmedSourceWei: (BigInt(confirmed) < BigInt(data.balances.sourceWei)
          ? BigInt(confirmed)
          : BigInt(data.balances.sourceWei)
        ).toString(),
        observedAt: Date.now(),
      };
      this.error = null;
    } catch (e) {
      this.error = String(e.message).slice(0, 200);
    } finally {
      this.busy = false;
    }
  }
  async startupReady() {
    if (!this.latest || Date.now() - this.latest.observedAt > 90000)
      return false;
    const x = this.latest;
    if (
      BigInt(x.credits.availableUsdMicros) >=
        BigInt(DEFAULT_CREDIT_POLICY.protectedReserveUsdMicros) +
          BigInt(DEFAULT_CREDIT_POLICY.maxRequestUsdMicros) ||
      BigInt(x.confirmedBaseUsdc ?? "0") >= 5000000n
    )
      return true;
    if (BigInt(x.confirmedSourceWei) < 100000000000000n) return false;
    try {
      const q = await this.transport.quoteConversion({
        amountUsdc: "6000000",
        gasTopupUsdMicros:
          BigInt(x.balances.baseWei) < 100000000000000n ? "2000000" : "0",
      });
      return (
        BigInt(q.maximumWei) + 100000000000000n <= BigInt(x.confirmedSourceWei)
      );
    } catch {
      return false;
    }
  }
  status() {
    const x = this.latest,
      fresh = x && Date.now() - x.observedAt <= 90000;
    return {
      phase: !fresh ? "unavailable" : this.active ? "operating" : "standby",
      treasury: this.transport.address,
      balanceEth: fresh ? formatEther(x.balances.sourceWei) : null,
      baseEth: fresh ? formatEther(x.balances.baseWei) : null,
      baseUsdc: fresh ? formatUnits(x.balances.baseUsdc, 6) : null,
      creditUsd: fresh ? Number(x.credits.availableUsdMicros) / 1000000 : null,
      confirmedFundingEth: fresh ? formatEther(x.confirmedSourceWei) : null,
      creatorFeesEth: null,
      earnedIncomeEth: null,
      spendingEnabled: this.active,
      maxSpendEth: "0.004",
      refillState: this.funding.status(),
      events: [],
      observedAt: x ? new Date(x.observedAt).toISOString() : null,
      reason:
        this.error ??
        (this.active
          ? "automatic wallet funded inference. deposits are funding, not earned income."
          : "resources observed. official experiment remains launch gated."),
    };
  }
}
