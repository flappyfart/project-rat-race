import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CreditGuard,
  creditAdmission,
  creditPolicy,
  CreditWaitError,
} from "./credit-guard.mjs";
import { AgentLoop } from "./agent-loop.mjs";
import { WalletTransport } from "./wallet-transport.mjs";
const flush = () => new Promise((r) => setImmediate(r));
test("refill starts at one dollar and request admission preserves twenty cents including the cost ceiling", () => {
  assert.deepEqual(
    [
      creditAdmission("1000001").refillNeeded,
      creditAdmission("1000000").refillNeeded,
      creditAdmission("999999").refillNeeded,
    ],
    [false, true, true],
  );
  assert.equal(creditAdmission("220000").ready, true);
  assert.equal(creditAdmission("219999").ready, false);
  assert.equal(creditAdmission("0").ready, false);
  assert.throws(() => creditAdmission("5000000", "20001"));
  assert.throws(() => creditPolicy({ refillAtUsdMicros: "210000" }));
});
test("proactive refill does not pause affordable work and simultaneous checks share one refill attempt", async () => {
  let calls = 0,
    release;
  const p = new Promise((r) => (release = r));
  const guard = new CreditGuard({
    credits: async () => ({ availableUsdMicros: "750000" }),
    refill: async () => {
      calls++;
      await p;
      return { state: "submitted", pending: true };
    },
  });
  const r = await Promise.all([guard.check(), guard.check(), guard.check()]);
  await flush();
  assert(r.every((x) => x.ready && x.refillNeeded));
  assert.equal(calls, 1);
  assert.equal(guard.status().refillCallActive, true);
  release();
  await flush();
});
test("unknown balance cannot admit a paid request or cause a blind credit purchase", async () => {
  let calls = 0;
  const g = new CreditGuard({
    credits: async () => {
      throw Error("provider offline");
    },
    refill: async () => calls++,
  });
  assert.equal((await g.check()).ready, false);
  await flush();
  assert.equal(calls, 0);
  assert.equal(g.status().availableUsdMicros, null);
});
test("failed refill keeps a protected waiting state and resumes only on freshly observed credits", async () => {
  let amount = "210000",
    now = 1000,
    calls = 0;
  const g = new CreditGuard({
    now: () => now,
    credits: async () => ({ availableUsdMicros: amount }),
    refill: async () => {
      calls++;
      throw Error("treasury empty");
    },
  });
  assert.equal((await g.check()).ready, false);
  await flush();
  assert.equal(g.status().phase, "waiting_for_credits");
  assert.equal(calls, 1);
  now += 6000;
  amount = "5210000";
  assert.equal((await g.check()).ready, true);
  assert.equal(g.status().phase, "ready");
  assert.equal(calls, 1);
});
test("read-only credit inspection cannot invoke a refill", async () => {
  let calls = 0;
  const g = new CreditGuard({
    credits: async () => ({ availableUsdMicros: "100000" }),
    refill: async () => calls++,
  });
  assert.equal((await g.check({ allowRefill: false })).ready, false);
  await flush();
  assert.equal(calls, 0);
});
test("agent waits before reserving or spending, preserves work through restart, and resumes automatically", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rat-credit-wait-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let funded = false,
    now = 1000,
    requests = 0;
  const transport = {
      preflight: async () => ({
        ready: funded,
        reason: "waiting for refill",
        retryAfterMs: 15000,
      }),
      complete: async () => {
        requests++;
        return {
          text: JSON.stringify({
            summary: "continued saved work",
            memory: "continued memory",
            action: { tool: "wait", args: { seconds: 30 } },
          }),
          costUsd: 0.001,
          requestId: "unit-only",
        };
      },
    },
    tools = {
      definitions: () => [],
      execute: async () => {
        throw Error("unexpected tool");
      },
    };
  const a = new AgentLoop({ root, transport, tools, now: () => now });
  a.state.memory = "unfinished work must survive";
  await a.runCycle({ authorized: true });
  assert.equal(a.status().phase, "waiting_for_credits");
  assert.equal(a.state.cycles, 0);
  assert.equal(requests, 0);
  assert.equal(Object.values(a.state.days)[0].requests, 0);
  assert.equal(Object.values(a.state.days)[0].costUsd, 0);
  const b = new AgentLoop({ root, transport, tools, now: () => now });
  await b.restore();
  assert.equal(b.state.memory, "unfinished work must survive");
  funded = true;
  now += 15000;
  await b.runCycle({ authorized: true });
  assert.equal(requests, 1);
  assert.equal(b.state.cycles, 1);
  assert.equal(b.state.memory, "continued memory");
  assert.equal(b.state.creditWait, undefined);
});
async function fixtureTransport(t, { balance = 0.225, decline = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rat-credit-transport-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tr = new WalletTransport({ root, canSpend: () => true });
  let remaining = balance,
    posts = 0;
  const charges = [];
  tr.address = "0x" + "1".repeat(40);
  tr.initialize = async () => tr;
  tr.auth = async () => "explicit-unit-fixture";
  tr.catalog = [
    {
      id: tr.model,
      model_spec: {
        offline: false,
        pricing: { input: { usd: 0.35 }, output: { usd: 1.5 } },
      },
    },
  ];
  tr.catalogAt = Date.now();
  tr.veniceRead = async (resource) =>
    resource.includes("/balance/")
      ? { balanceUsd: remaining }
      : { transactions: charges };
  tr.json = async (url) => {
    assert(url.endsWith("/chat/completions"));
    posts++;
    if (decline)
      return {
        ok: false,
        status: 402,
        data: { error: "unit insufficient credit" },
      };
    remaining = Number((remaining - 0.01).toFixed(8));
    const id = "fixture-" + posts;
    charges.push({
      type: "CHARGE",
      requestId: id,
      amount: -0.01,
      id: "ledger-" + posts,
    });
    return {
      ok: true,
      status: 200,
      data: {
        id,
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { total_tokens: 10 },
      },
    };
  };
  return {
    tr,
    posts: () => posts,
    balance: () => remaining,
    setBalance: (v) => (remaining = v),
  };
}
test("concurrent paid requests recheck real-time credit under the transport lock", async (t) => {
  const x = await fixtureTransport(t),
    request = {
      messages: [{ role: "user", content: "explicit unit fixture" }],
      maxTokens: 10,
    };
  const r = await Promise.allSettled([
    x.tr.complete({ ...request, requestId: "one" }),
    x.tr.complete({ ...request, requestId: "two" }),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    r.find((x) => x.status === "rejected").reason.code,
    "CREDIT_WAIT",
  );
  assert.equal(x.posts(), 1);
  assert(x.balance() >= 0.2);
});
test(
  "late refill notification does not deadlock the serialized wallet transport",
  { timeout: 3000 },
  async (t) => {
    const x = await fixtureTransport(t, { balance: 1.1 });
    let reads = 0,
      refills = 0;
    const original = x.tr.veniceRead;
    x.tr.veniceRead = async (resource) => {
      if (resource.includes("/balance/") && ++reads === 2) x.setBalance(0.75);
      return original(resource);
    };
    const g = new CreditGuard({
      credits: () => x.tr.credits(),
      refill: () =>
        x.tr.exclusive(async () => {
          refills++;
          return { state: "submitted", pending: true };
        }),
    });
    x.tr.creditGuard = g;
    await x.tr.complete({
      messages: [{ role: "user", content: "fixture" }],
      maxTokens: 10,
    });
    if (g.inflight) await g.inflight;
    assert.equal(x.posts(), 1);
    assert.equal(refills, 1);
  },
);
test("a provider credit decline becomes a resumable credit wait, never a completed action", async (t) => {
  const x = await fixtureTransport(t, { balance: 5, decline: true });
  await assert.rejects(
    x.tr.complete({
      messages: [{ role: "user", content: "fixture" }],
      maxTokens: 10,
    }),
    (e) => e.code === "CREDIT_WAIT",
  );
  assert.equal(x.posts(), 1);
});
test("low balance never reaches the paid HTTP endpoint", async (t) => {
  const x = await fixtureTransport(t, { balance: 0.219999 });
  await assert.rejects(
    x.tr.complete({
      messages: [{ role: "user", content: "fixture" }],
      maxTokens: 10,
    }),
    (e) => e.code === "CREDIT_WAIT",
  );
  assert.equal(x.posts(), 0);
});
test("late provider credit wait preserves memory and does not run a tool", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rat-late-credit-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tools = 0;
  const a = new AgentLoop({
    root,
    tools: { definitions: () => [], execute: async () => tools++ },
    transport: {
      preflight: async () => ({ ready: true }),
      complete: async () => {
        throw new CreditWaitError("provider waiting");
      },
    },
  });
  a.state.memory = "unfinished state";
  await a.runCycle({ authorized: true });
  assert.equal(a.status().phase, "waiting_for_credits");
  assert.equal(a.state.memory, "unfinished state");
  assert.equal(a.state.cycles, 0);
  assert.equal(a.state.errors, 0);
  assert.equal(tools, 0);
  assert.equal(a.state.pending, null);
});
