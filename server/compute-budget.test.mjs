import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ComputeBudget,
  ComputeBudgetWaitError,
  usdToMicrosCeil,
} from "./compute-budget.mjs";
import { WalletTransport } from "./wallet-transport.mjs";
import { AgentLoop } from "./agent-loop.mjs";
const NOW = Date.parse("2026-09-15T23:59:00Z"),
  DAY = "2026-09-15";
async function fixture(t, legacyDays = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "prr-compute-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = NOW;
  const now = () => clock;
  const budget = new ComputeBudget({ root, now });
  await budget.initialize({ legacyDays });
  return {
    root,
    budget,
    now,
    advance: () => {
      clock += 120000;
    },
  };
}
const reserve = (b, id, channel = "agent", maximumUsdMicros = "20000") =>
  b.reserve({ id, channel, maximumUsdMicros });

test("integer ceiling conversion, including tiny and scientific costs", () => {
  assert.equal(usdToMicrosCeil("0.000123001"), "124");
  assert.equal(usdToMicrosCeil("1e-9"), "1");
  assert.equal(usdToMicrosCeil(0.02), "20000");
  assert.equal(usdToMicrosCeil("0"), "0");
  assert.throws(() => usdToMicrosCeil("-1"));
});
test("same-instance races enforce chat sublimit, independent agent remainder", async (t) => {
  const { budget } = await fixture(t);
  const r = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => reserve(budget, "c" + i, "chat")),
  );
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 5);
  for (const x of r.filter((x) => x.status === "rejected")) {
    assert.equal(x.reason.code, "COMPUTE_BUDGET_WAIT");
    assert.equal(x.reason.retryAfterMs, 60000);
    assert.equal(x.reason.knownUnspent, true);
  }
  await reserve(budget, "agent");
  assert.equal((await budget.status()).usedUsdMicros, "120000");
});
test("total cap exact boundary cannot be bypassed by chat channel", async (t) => {
  const { budget } = await fixture(t, {
    [DAY]: { costUsd: 0.73, requests: 10 },
  });
  await reserve(budget, "edge", "chat");
  assert.equal((await budget.status()).availableUsdMicros, "0");
  await assert.rejects(reserve(budget, "no", "agent", "1"), {
    code: "COMPUTE_BUDGET_WAIT",
  });
  await assert.rejects(reserve(budget, "nochat", "chat", "1"), {
    code: "COMPUTE_BUDGET_WAIT",
  });
});
test("one micro chat boundary and strict request bounds", async (t) => {
  const { budget } = await fixture(t);
  for (let i = 0; i < 4; i++) await reserve(budget, "full" + i, "chat");
  await reserve(budget, "almost", "chat", "19999");
  await reserve(budget, "last", "chat", "1");
  await assert.rejects(reserve(budget, "over", "chat", "1"), {
    code: "COMPUTE_BUDGET_WAIT",
  });
  for (const n of ["0", "20001", "1.2", "-1", 20000])
    await assert.rejects(reserve(budget, "bad" + String(n), "agent", n));
});
test("settlement releases difference; same settlement idempotent and binding strict", async (t) => {
  const { budget } = await fixture(t);
  const r = await reserve(budget, "settle", "chat");
  await assert.rejects(
    budget.settle({ ...r, channel: "agent" }, { actualUsdMicros: "123" }),
  );
  await budget.settle(r, { actualUsdMicros: "123" });
  await budget.settle(r, { actualUsdMicros: "123" });
  await assert.rejects(budget.settle(r, { actualUsdMicros: "1" }));
  assert.equal((await budget.status()).chatUsedUsdMicros, "123");
});
test("ambiguous failure retains full reserve; only known-unspent refunds", async (t) => {
  const { budget } = await fixture(t);
  const a = await reserve(budget, "ambiguous"),
    b = await reserve(budget, "unsubmitted");
  await budget.fail(a, { knownUnspent: false });
  await budget.fail(b, { knownUnspent: true });
  await budget.fail(b, { knownUnspent: true });
  await assert.rejects(budget.fail(a, { knownUnspent: true }));
  assert.equal((await budget.status()).usedUsdMicros, "20000");
});
test("new UTC day resets availability without deleting old reservations or IDs", async (t) => {
  const { budget, advance } = await fixture(t);
  const r = await reserve(budget, "old", "chat");
  advance();
  assert.equal((await budget.status()).usedUsdMicros, "0");
  await budget.settle(r, { actualUsdMicros: "123" });
  assert.equal((await budget.status()).usedUsdMicros, "0");
  await assert.rejects(reserve(budget, "old"), { code: "COMPUTE_DUPLICATE" });
  assert.equal((await budget.status()).day, "2026-09-16");
});
test("restart retains in-flight and released tombstones; migration only once", async (t) => {
  const { budget, root, now } = await fixture(t, {
    [DAY]: { costUsd: 0.12, requests: 3 },
  });
  await reserve(budget, "pending");
  const r = await reserve(budget, "released");
  await budget.fail(r, { knownUnspent: true });
  const again = new ComputeBudget({ root, now });
  await again.initialize({
    legacyDays: { [DAY]: { costUsd: 0.7, requests: 99 } },
  });
  assert.equal((await again.status()).usedUsdMicros, "140000");
  assert.equal((await again.status()).requests, 4);
  for (const id of ["pending", "released"])
    await assert.rejects(reserve(again, id), { code: "COMPUTE_DUPLICATE" });
});
test("separate instances use exclusive disk lock, stale or malformed locks fail closed", async (t) => {
  const { budget, root, now } = await fixture(t);
  const other = await new ComputeBudget({ root, now }).initialize();
  const r = await Promise.allSettled([
    reserve(budget, "a"),
    reserve(other, "b"),
  ]);
  assert.ok(r.some((x) => x.status === "fulfilled"));
  assert.ok(
    r.every((x) => x.status === "fulfilled" || /locked/.test(x.reason.message)),
  );
  assert.equal(
    (await budget.status()).usedUsdMicros,
    String(r.filter((x) => x.status === "fulfilled").length * 20000),
  );
  await writeFile(
    path.join(root, "compute-budget.lock"),
    "dead or malformed owner",
  );
  await assert.rejects(reserve(other, "blocked"), /locked/);
  assert.equal(
    await readFile(path.join(root, "compute-budget.lock"), "utf8"),
    "dead or malformed owner",
  );
});
test("malformed ledger, checksum corruption and missing initialized ledger never reset", async (t) => {
  const { root, now, budget } = await fixture(t);
  const file = path.join(root, "compute-budget.json"),
    original = await readFile(file, "utf8");
  await writeFile(file, "{broken");
  await assert.rejects(budget.status(), /corrupt/);
  await assert.rejects(
    new ComputeBudget({ root, now }).initialize(),
    /corrupt/,
  );
  const e = JSON.parse(original);
  e.state.records = [{ id: "bad" }];
  e.hash = createHash("sha256").update(JSON.stringify(e.state)).digest("hex");
  await writeFile(file, JSON.stringify(e));
  await assert.rejects(budget.status(), /corrupt/);
  await writeFile(file, original.replace('"version":1', '"version":2'));
  await assert.rejects(budget.status(), /corrupt/);
  await unlink(file);
  await assert.rejects(
    new ComputeBudget({ root, now }).initialize(),
    /missing after initialization/,
  );
});
test("invalid migration is rejected, public status excludes record IDs", async (t) => {
  const { root, budget, now } = await fixture(t);
  await reserve(budget, "private-id");
  assert.deepEqual(
    Object.keys(await budget.status()).sort(),
    [
      "day",
      "totalCapUsdMicros",
      "chatCapUsdMicros",
      "usedUsdMicros",
      "chatUsedUsdMicros",
      "availableUsdMicros",
      "chatAvailableUsdMicros",
      "requests",
    ].sort(),
  );
  const bad = new ComputeBudget({ root: path.join(root, "bad"), now });
  await assert.rejects(
    bad.initialize({ legacyDays: { bad: { costUsd: 0.1, requests: 1 } } }),
  );
  await assert.rejects(
    bad.initialize({ legacyDays: { [DAY]: { costUsd: -0.1, requests: 1 } } }),
  );
});

async function fakeTransport(t, legacyDays = {}) {
  const f = await fixture(t, legacyDays),
    calls = [];
  const transport = new WalletTransport({
    root: path.join(f.root, "fake-transport"),
    privateRoot: f.root,
    canSpend: () => true,
    computeBudget: f.budget,
  });
  transport.initialize = async () => {
    transport.address = "fixture";
    return transport;
  };
  transport.preflight = async () => ({ ready: true });
  transport.catalogAt = Date.now();
  transport.catalog = [
    {
      id: transport.model,
      model_spec: { pricing: { input: { usd: 0.1 }, output: { usd: 0.5 } } },
    },
  ];
  transport.auth = async () => {
    calls.push("auth");
    return "fixture-auth";
  };
  transport.veniceRead = async (resource) => {
    calls.push(resource);
    return resource.includes("balance")
      ? { balanceUsd: 5 }
      : {
          transactions: [
            {
              id: "charge",
              type: "CHARGE",
              requestId: "response",
              amount: "-0.000123001",
            },
          ],
        };
  };
  transport.json = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      data: {
        id: "response",
        model: "fixture",
        usage: {},
        choices: [{ finish_reason: "stop", message: { content: "hello" } }],
      },
    };
  };
  return { ...f, transport, calls };
}
const message = {
  messages: [{ role: "user", content: "hi" }],
  requestId: "request",
};
test("transport reserves inside queue, settles upward, forwards chat timeout", async (t) => {
  const { transport, budget, calls } = await fakeTransport(t);
  const original = transport.json;
  transport.json = async (...args) => {
    assert.equal((await budget.status()).chatUsedUsdMicros, "20000");
    return original(...args);
  };
  const answer = await transport.complete({
    ...message,
    budgetChannel: "chat",
    timeoutMs: 25000,
  });
  assert.equal(answer.text, "hello");
  assert.equal((await budget.status()).chatUsedUsdMicros, "124");
  assert.equal(calls.find((x) => x.options).options.timeoutMs, 25000);
  await assert.rejects(transport.complete(message), {
    code: "COMPUTE_DUPLICATE",
  });
  assert.equal(calls.filter((x) => x.options).length, 1);
});
test("transport shared denial performs no calls after reserve denial and no post", async (t) => {
  const { transport, budget, calls } = await fakeTransport(t, {
    [DAY]: { costUsd: 0.75, requests: 10 },
  });
  const original = budget.reserve.bind(budget);
  let count;
  budget.reserve = async (x) => {
    count = calls.length;
    return original(x);
  };
  await assert.rejects(transport.complete(message), {
    code: "COMPUTE_BUDGET_WAIT",
  });
  assert.equal(calls.length, count);
  assert.equal(calls.filter((x) => x.options).length, 0);
});
test("transport defaults agent/180000, retains ambiguous failures and supports no budget", async (t) => {
  const { transport, budget, calls } = await fakeTransport(t);
  transport.json = async (u, o) => {
    calls.push({ options: o });
    throw Error("timeout after submission");
  };
  await assert.rejects(transport.complete(message), /timeout/);
  assert.equal((await budget.status()).usedUsdMicros, "20000");
  assert.equal((await budget.status()).chatUsedUsdMicros, "0");
  assert.equal(calls.find((x) => x.options).options.timeoutMs, 180000);
  const g = await fakeTransport(t);
  g.transport.computeBudget = undefined;
  assert.equal((await g.transport.complete(message)).text, "hello");
  assert.equal((await g.budget.status()).usedUsdMicros, "0");
});
test("transport validation and auth failures never reserve; timeout bounds reject", async (t) => {
  const { transport, budget } = await fakeTransport(t);
  for (const timeoutMs of [0, 180001, NaN, 2.5])
    await assert.rejects(
      transport.complete({ ...message, timeoutMs }),
      /bounds/,
    );
  transport.auth = async () => {
    throw Error("signing unavailable");
  };
  await assert.rejects(transport.complete(message), /signing unavailable/);
  assert.equal((await budget.status()).usedUsdMicros, "0");
});
test("agent budget wait refunds exact local reservation, does not fabricate cycle or history", async (t) => {
  const { root, now } = await fixture(t);
  const loop = new AgentLoop({
    root: path.join(root, "agent"),
    now,
    transport: {
      preflight: async () => ({ ready: true }),
      complete: async () => {
        throw new ComputeBudgetWaitError(now());
      },
    },
    tools: {
      definitions: () => [],
      execute: () => assert.fail("must not execute"),
    },
  });
  await loop.runCycle({ authorized: true });
  assert.deepEqual(loop.state.days[DAY], { costUsd: 0, requests: 0 });
  assert.equal(loop.state.cycles, 0);
  assert.equal(loop.state.errors, 0);
  assert.equal(loop.state.history.length, 0);
  assert.equal(loop.state.pending, null);
  assert.equal(loop.state.nextAt, now() + 60000);
  const restored = new AgentLoop({ root: path.join(root, "agent"), now });
  await restored.restore();
  assert.deepEqual(restored.state.days[DAY], { costUsd: 0, requests: 0 });
});
test("real child process observes durable IDs and cannot enter another process lock", async (t) => {
  const { root, budget } = await fixture(t);
  await reserve(budget, "child-replay");
  const code = `import {ComputeBudget} from ${JSON.stringify(new URL("./compute-budget.mjs", import.meta.url).href)};const b=new ComputeBudget({root:process.argv[1],now:()=>${NOW}});try{await b.initialize();await b.reserve({id:'child-replay'});process.exitCode=2;}catch(e){console.log(e.code??e.message);}`;
  const run = () =>
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", code, root],
      { timeout: 10000 },
    );
  assert.match((await run()).stdout, /COMPUTE_DUPLICATE/);
  await writeFile(
    path.join(root, "compute-budget.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  assert.match((await run()).stdout, /locked/);
});

test("transport concurrent chat completions cannot exceed shared subcap", async (t) => {
  const { transport, budget, calls } = await fakeTransport(t);
  const read = transport.veniceRead;
  transport.veniceRead = async (p) => {
    const r = await read(p);
    if (r.transactions) r.transactions[0].amount = "-0.02";
    return r;
  };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      transport.complete({
        ...message,
        requestId: "race-" + i,
        budgetChannel: "chat",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(calls.filter((c) => c.options).length, 5);
  assert.equal((await budget.status()).chatUsedUsdMicros, "100000");
});

test("agent ambiguous failures preserve legacy conservative reservation", async (t) => {
  const { root, now } = await fixture(t);
  const loop = new AgentLoop({
    root: path.join(root, "agent"),
    now,
    transport: {
      complete: async () => {
        throw Error("ambiguous");
      },
    },
    tools: { definitions: () => [] },
  });
  await loop.runCycle({ authorized: true });
  assert.deepEqual(loop.state.days[DAY], { costUsd: 0.02, requests: 1 });
  assert.equal(loop.state.cycles, 0);
  assert.equal(loop.state.errors, 1);
});
