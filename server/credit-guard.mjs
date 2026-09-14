export const DEFAULT_CREDIT_POLICY = Object.freeze({
  refillAtUsdMicros: "1000000",
  protectedReserveUsdMicros: "200000",
  maxRequestUsdMicros: "20000",
});
const integer = (v) => {
  if (typeof v !== "string" || !/^\d+$/.test(v))
    throw Error("invalid credit integer");
  return BigInt(v);
};
export function creditPolicy(overrides = {}) {
  for (const k of Object.keys(overrides))
    if (!(k in DEFAULT_CREDIT_POLICY)) throw Error("unknown credit policy");
  const p = { ...DEFAULT_CREDIT_POLICY, ...overrides },
    trigger = integer(p.refillAtUsdMicros),
    reserve = integer(p.protectedReserveUsdMicros),
    request = integer(p.maxRequestUsdMicros);
  if (reserve <= 0n || request <= 0n || trigger < reserve + request)
    throw Error(
      "credit trigger must cover the protected reserve and a request",
    );
  return Object.freeze(p);
}
export function creditAdmission(
  available,
  required = DEFAULT_CREDIT_POLICY.maxRequestUsdMicros,
  policy = DEFAULT_CREDIT_POLICY,
) {
  const p = creditPolicy(policy),
    balance = integer(available),
    cost = integer(required);
  if (cost <= 0n || cost > integer(p.maxRequestUsdMicros))
    throw Error("request exceeds credit policy");
  return {
    ready: balance >= integer(p.protectedReserveUsdMicros) + cost,
    refillNeeded: balance <= integer(p.refillAtUsdMicros),
    availableUsdMicros: balance.toString(),
    requiredUsdMicros: cost.toString(),
    reserveUsdMicros: p.protectedReserveUsdMicros,
    minimumStartUsdMicros: (
      integer(p.protectedReserveUsdMicros) + cost
    ).toString(),
  };
}
export class CreditWaitError extends Error {
  constructor(reason = "waiting for verified AI credits") {
    super(reason);
    this.code = "CREDIT_WAIT";
    this.retryAfterMs = 15000;
  }
}
/** The funding controller, not the model, owns refills. Never infer credit from a
 * submitted payment: admission always uses a freshly read provider balance. */
export class CreditGuard {
  constructor({
    credits,
    refill,
    policy = {},
    now = Date.now,
    pollMs = 10000,
    kickMs = 5000,
  }) {
    this.credits = credits;
    this.refill = refill;
    this.policy = creditPolicy(policy);
    this.now = now;
    this.pollMs = pollMs;
    this.kickMs = kickMs;
    this.inflight = null;
    this.lastKick = -Infinity;
    this.lastPoll = -Infinity;
    this.record = {
      phase: "standby",
      reason: "credit admission has not been checked",
      availableUsdMicros: null,
      checkedAt: null,
      refill: null,
    };
  }
  status() {
    return {
      ...structuredClone(this.record),
      policy: { ...this.policy },
      refillCallActive: !!this.inflight,
    };
  }
  requestRefill() {
    if (this.inflight || this.now() - this.lastKick < this.kickMs) return;
    this.lastKick = this.now();
    this.inflight = Promise.resolve()
      .then(() => this.refill())
      .then((r) => {
        this.record.refill = {
          pending: r?.pending === true,
          state: typeof r?.state === "string" ? r.state : "unknown",
          gate: r?.gate === "closed" ? "closed" : null,
          result: typeof r?.result === "string" ? r.result : null,
        };
      })
      .catch(() => {
        this.record.refill = {
          pending: true,
          state: "unavailable",
          result: "refill service unavailable",
        };
      })
      .finally(() => {
        this.inflight = null;
      });
  }
  async check({
    requiredUsdMicros = this.policy.maxRequestUsdMicros,
    allowRefill = true,
  } = {}) {
    let decision;
    try {
      const c = await this.credits();
      decision = creditAdmission(
        c.availableUsdMicros,
        requiredUsdMicros,
        this.policy,
      );
    } catch {
      this.record = {
        ...this.record,
        phase: "waiting_for_credits",
        reason: "provider credit balance unavailable. work is saved.",
        availableUsdMicros: null,
        checkedAt: new Date(this.now()).toISOString(),
      };
      return { ready: false, reason: this.record.reason, retryAfterMs: 15000 };
    }
    this.record = {
      ...this.record,
      phase: decision.ready
        ? decision.refillNeeded
          ? "refilling"
          : "ready"
        : "waiting_for_credits",
      reason: decision.ready
        ? decision.refillNeeded
          ? "refill requested while a credit buffer remains"
          : "request budget and protected reserve are available"
        : "waiting for refill before starting another paid request",
      availableUsdMicros: decision.availableUsdMicros,
      checkedAt: new Date(this.now()).toISOString(),
    };
    if (allowRefill && decision.refillNeeded) this.requestRefill();
    return { ...decision, reason: this.record.reason, retryAfterMs: 15000 };
  }
  async poll() {
    if (this.now() - this.lastPoll < this.pollMs) return this.status();
    this.lastPoll = this.now();
    await this.check();
    return this.status();
  }
}
