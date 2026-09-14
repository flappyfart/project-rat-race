import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { keccak256 } from "ethers";
export const DEFAULT_FUNDING_POLICY = Object.freeze({
  minCreditsUsdMicros: "1000000",
  refillUsdc: "5000000",
  conversionUsdc: "6000000",
  gasTopupUsdMicros: "2000000",
  maxConversionUsdMicros: "10000000",
  maxConversionWei: "4000000000000000",
  sourceReserveWei: "100000000000000",
  baseReserveWei: "100000000000000",
});
const num = (v) => {
  if (typeof v !== "string" || !/^\d+$/.test(v))
    throw Error("Expected unsigned integer string");
  return BigInt(v);
};
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("Invalid lease");
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    return true;
  }
};
const durable = (file, text, flags = "w") => {
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const syncDir = (dir) => {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
/** root MUST be private durable financial storage, outside simulation reset paths. */
export class FundingService {
  #root;
  #transport;
  #policy;
  #now;
  #journal;
  #lease;
  #authorized = () => false;
  constructor({ root, transport, policy = {}, now = Date.now }) {
    if (!path.isAbsolute(root)) throw Error("Absolute financial root required");
    for (const k of Object.keys(policy))
      if (!(k in DEFAULT_FUNDING_POLICY)) throw Error("Unknown funding policy");
    this.#policy = { ...DEFAULT_FUNDING_POLICY, ...policy };
    for (const v of Object.values(this.#policy)) num(v);
    if (
      num(this.#policy.refillUsdc) === 0n ||
      num(this.#policy.conversionUsdc) < num(this.#policy.refillUsdc)
    )
      throw Error("Invalid refill policy");
    this.#root = root;
    this.#transport = transport;
    this.#now = now;
    this.#journal = path.join(root, "funding-journal.jsonl");
    this.#lease = path.join(root, "funding-lease.json");
  }
  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#journal, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { seq: 0, intent: null };
      throw e;
    }
    if (!text.endsWith("\n"))
      throw Error("Incomplete financial journal: manual recovery required");
    let last = { seq: 0, intent: null };
    for (const line of text.trimEnd().split("\n")) {
      const r = JSON.parse(line);
      if (r.seq !== last.seq + 1 || !Object.hasOwn(r, "intent"))
        throw Error("Invalid financial journal");
      last = r;
    }
    return last;
  }
  #save(state, event) {
    const r = { ...state, seq: state.seq + 1, at: this.#now(), event };
    durable(this.#journal, JSON.stringify(r) + "\n", "a");
    syncDir(this.#root);
    return r;
  }
  #public(state) {
    return {
      sequence: state.seq,
      state: state.intent?.stage ?? "idle",
      pending: !!state.intent,
      kind: state.intent?.kind ?? null,
      intentId: state.intent?.id ?? null,
      policy: { ...this.#policy },
      lastCompletion: state.completion ?? null,
    };
  }
  status() {
    return this.#public(this.#read());
  }
  async inspect() {
    const state = this.status();
    const [b, c] = await Promise.all([
      this.#transport.balances(),
      this.#transport.credits(),
    ]);
    return {
      ...state,
      balances: this.#balances(b),
      credits: { availableUsdMicros: num(c.availableUsdMicros).toString() },
      nativeFundsPresent: num(b.sourceWei) > 0n || num(b.baseWei) > 0n,
    };
  }
  #balances(b) {
    return Object.fromEntries(
      ["sourceWei", "baseWei", "baseUsdc"].map((k) => [
        k,
        num(b[k]).toString(),
      ]),
    );
  }
  #lock() {
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const recovery = this.#lease + ".recovery";
    if (fs.existsSync(recovery))
      throw Error("Lease recovery in progress; manual recovery if abandoned");
    try {
      durable(
        this.#lease,
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
        "wx",
      );
      syncDir(this.#root);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const old = JSON.parse(fs.readFileSync(this.#lease, "utf8"));
    if (alive(old.pid)) throw Error("Funding service busy");
    durable(recovery, JSON.stringify({ pid: process.pid }), "wx");
    try {
      const current = JSON.parse(fs.readFileSync(this.#lease, "utf8"));
      if (current.token !== old.token || alive(current.pid))
        throw Error("Lease changed");
      // Validate and record recovery BEFORE reclaiming. Pending intent is preserved.
      const state = this.#read();
      this.#save(state, "dead-process-recovery");
      fs.unlinkSync(this.#lease);
      durable(
        this.#lease,
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
        "wx",
      );
      syncDir(this.#root);
    } finally {
      fs.unlinkSync(recovery);
    }
  }
  async tick({
    authorized = false,
    launchVerified = false,
    hasExperimentState = false,
    isAuthorized = () => authorized && launchVerified && hasExperimentState,
  } = {}) {
    if (
      authorized !== true ||
      launchVerified !== true ||
      hasExperimentState !== true
    )
      return { ...this.status(), gate: "closed" };
    this.#authorized = isAuthorized;
    this.#lock();
    try {
      return await this.#advance();
    } finally {
      fs.unlinkSync(this.#lease);
      syncDir(this.#root);
    }
  }
  async runRehearsal({ isolatedTestGate = false } = {}) {
    if (
      isolatedTestGate !== true ||
      this.#transport.isRehearsal !== true ||
      !path.basename(this.#root).startsWith("funding-rehearsal-")
    )
      throw Error("Explicit isolated rehearsal root and transport required");
    return this.tick({
      authorized: true,
      launchVerified: true,
      hasExperimentState: true,
    });
  }
  async #advance() {
    let s = this.#read();
    const t = this.#transport,
      p = this.#policy;
    const save = (intent, event) => {
      s = this.#save({ ...s, intent }, event);
    };
    let i = s.intent;
    if (i && i.stage !== "conversion-settled") {
      // Even preparing is ambiguous: signer could have completed before process died.
      let result;
      try {
        result = await (i.kind === "conversion"
          ? t.reconcileConversion(structuredClone(i))
          : t.reconcileCreditPayment(structuredClone(i)));
      } catch {
        return { ...this.#public(s), result: "reconciliation-unavailable" };
      }
      const done = i.kind === "conversion" ? "settled" : "credited";
      if (
        result?.state === "failed" &&
        result.safeToRetry === true &&
        typeof result.evidenceId === "string"
      ) {
        s = this.#save(
          {
            ...s,
            intent: null,
            retryAfter: this.#now() + 60000,
            completion: {
              intentId: i.id,
              kind: i.kind,
              evidenceId: result.evidenceId,
              outcome: "confirmed unsuccessful",
            },
          },
          "confirmed-safe-failure",
        );
        return this.#public(s);
      }
      if (
        result?.state === done &&
        typeof result.evidenceId === "string" &&
        result.evidenceId.length
      ) {
        if (i.kind === "conversion")
          save(
            {
              ...i,
              stage: "conversion-settled",
              evidenceId: result.evidenceId,
            },
            "conversion-settled",
          );
        else
          s = this.#save(
            {
              ...s,
              intent: null,
              completion: {
                intentId: i.id,
                kind: i.kind,
                evidenceId: result.evidenceId,
              },
            },
            "credit-confirmed",
          );
      }
      return this.#public(s);
    }
    if (s.retryAfter && this.#now() < s.retryAfter)
      return { ...this.#public(s), result: "retry-backoff" };
    const [raw, c] = await Promise.all([t.balances(), t.credits()]);
    const b = this.#balances(raw);
    if (num(c.availableUsdMicros) > num(p.minCreditsUsdMicros)) {
      if (i) save(null, "credits-healthy-after-settlement");
      return { ...this.#public(s), result: "credits-healthy" };
    }
    if (num(b.baseUsdc) >= num(p.refillUsdc)) {
      // EIP-3009 merchant authorization is gasless for the paying wallet.
      i = {
        id: randomUUID(),
        kind: "credit",
        stage: "preparing",
        amountUsdc: p.refillUsdc,
        createdAt: this.#now(),
      };
      save(i, "credit-intent");
      try {
        if (!this.#authorized()) throw Error("authorization closed");
        const prepared = await t.prepareCreditPayment(structuredClone(i));
        if (
          !prepared?.authorization ||
          num(prepared.authorization.amountUsdc) !== num(i.amountUsdc) ||
          prepared.authorization.intentId !== i.id ||
          !prepared.payload
        )
          throw Error("Unbound credit authorization");
        i = { ...i, stage: "prepared", prepared };
        save(i, "credit-prepared");
        if (!this.#authorized()) throw Error("authorization closed");
        save({ ...i, stage: "submitted" }, "credit-submit-attempt");
        await t.submitCreditPayment(structuredClone(prepared));
      } catch {
        return { ...this.#public(s), result: "reconcile-required" };
      }
      return this.#public(s);
    }
    if (i) return { ...this.#public(s), result: "awaiting-settled-balances" };
    const requestedGas =
      num(b.baseWei) < num(p.baseReserveWei) ? p.gasTopupUsdMicros : "0";
    const quote = await t.quoteConversion({
      amountUsdc: p.conversionUsdc,
      gasTopupUsdMicros: requestedGas,
    });
    const cost = num(quote.maximumWei),
      usd = num(quote.maximumUsdMicros);
    if (
      cost === 0n ||
      usd === 0n ||
      cost > num(p.maxConversionWei) ||
      usd > num(p.maxConversionUsdMicros) ||
      num(quote.minimumUsdc) < num(p.conversionUsdc) ||
      num(quote.gasTopupUsdMicros) !== num(requestedGas) ||
      num(b.sourceWei) < cost + num(p.sourceReserveWei)
    )
      return { ...this.#public(s), result: "conversion-budget-blocked" };
    i = {
      id: randomUUID(),
      kind: "conversion",
      stage: "preparing",
      createdAt: this.#now(),
      amountUsdc: p.conversionUsdc,
      quote,
    };
    save(i, "conversion-intent");
    try {
      if (!this.#authorized()) throw Error("authorization closed");
      const prepared = await t.prepareConversion(
        structuredClone(quote),
        structuredClone(i),
      );
      if (
        typeof prepared?.rawTransaction !== "string" ||
        keccak256(prepared.rawTransaction) !== prepared.transactionHash
      )
        throw Error("Missing bound prepared transaction/hash");
      i = { ...i, stage: "prepared", prepared };
      save(i, "conversion-prepared");
      if (!this.#authorized()) throw Error("authorization closed");
      save({ ...i, stage: "broadcast" }, "conversion-broadcast-attempt");
      await t.broadcastConversion(structuredClone(prepared));
    } catch {
      return { ...this.#public(s), result: "reconcile-required" };
    }
    return this.#public(s);
  }
}
export default FundingService;
