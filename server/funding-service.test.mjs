import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { keccak256 } from "ethers";
import { FundingService } from "./funding-service.mjs";
const gate = {
  authorized: true,
  launchVerified: true,
  hasExperimentState: true,
};
function setup(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "funding-rehearsal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let b = {
      sourceWei: "30200000000000000",
      baseWei: "805000000000000",
      baseUsdc: "1000000",
    },
    credit = "0",
    conversion = { state: "pending" },
    payment = { state: "pending" };
  const tr = {
    isRehearsal: true,
    balances: async () => ({ ...b, secret: "DO_NOT_EXPOSE" }),
    credits: async () => ({
      availableUsdMicros: credit,
      secret: "DO_NOT_EXPOSE",
    }),
    quoteConversion: async (args) => {
      calls.push(["quote", args]);
      return {
        maximumWei: "3300000000000000",
        maximumUsdMicros: "8200000",
        minimumUsdc: "6000000",
        gasTopupUsdMicros: args.gasTopupUsdMicros,
      };
    },
    prepareConversion: async () => {
      calls.push(["prepareConversion"]);
      return { rawTransaction: "0x1234", transactionHash: keccak256("0x1234") };
    },
    broadcastConversion: async () => {
      calls.push(["broadcast"]);
    },
    reconcileConversion: async () => {
      calls.push(["reconcileConversion"]);
      return conversion;
    },
    prepareCreditPayment: async (i) => {
      calls.push(["prepareCredit"]);
      return {
        authorization: { amountUsdc: i.amountUsdc, intentId: i.id },
        payload: { signature: "DO_NOT_EXPOSE" },
      };
    },
    submitCreditPayment: async () => {
      calls.push(["submit"]);
    },
    reconcileCreditPayment: async () => {
      calls.push(["reconcileCredit"]);
      return payment;
    },
    ...changes,
  };
  const service = () =>
    new FundingService({ root, transport: tr, now: () => 1234 });
  return {
    root,
    tr,
    calls,
    service,
    setBalances: (v) => (b = { ...b, ...v }),
    setCredits: (v) => (credit = v),
    setConversion: (v) => (conversion = v),
    setPayment: (v) => (payment = v),
  };
}
test("read-only inspection and all gates do not create journal or prepare; existing native funds detected", async (t) => {
  const x = setup(t);
  const s = x.service();
  assert.equal(s.status().state, "idle");
  assert.equal((await s.inspect()).nativeFundsPresent, true);
  assert.ok(!JSON.stringify(await s.inspect()).includes("DO_NOT_EXPOSE"));
  for (const k of Object.keys(gate)) {
    await s.tick({ ...gate, [k]: false });
    await s.tick({ ...gate, [k]: "true" });
  }
  assert.deepEqual(x.calls, []);
  assert.deepEqual(fs.readdirSync(x.root), []);
});
test("funding threshold includes equality and cannot purchase twice while a credit intent is pending", async (t) => {
  const x = setup(t);
  x.setCredits("1000000");
  x.setBalances({ baseUsdc: "5000000" });
  await x.service().tick(gate);
  assert.equal(x.service().status().pending, true);
  assert.equal(x.calls.filter((c) => c[0] === "submit").length, 1);
  await x.service().tick(gate);
  await x.service().tick(gate);
  assert.equal(x.calls.filter((c) => c[0] === "submit").length, 1);
});
test("healthy credits never swap; available Base USDC never forces conversion", async (t) => {
  const x = setup(t);
  x.setCredits("5000000");
  assert.equal((await x.service().tick(gate)).result, "credits-healthy");
  assert.equal(x.calls.length, 0);
  x.setCredits("0");
  x.setBalances({ baseUsdc: "5000000" });
  await x.service().tick(gate);
  assert.deepEqual(
    x.calls.map((c) => c[0]),
    ["prepareCredit", "submit"],
  );
  assert.ok(!JSON.stringify(x.service().status()).includes("DO_NOT_EXPOSE"));
});
test("journal records exact authorization before HTTP, and raw transaction/hash before broadcast", async (t) => {
  const x = setup(t);
  x.tr.broadcastConversion = async (p) => {
    const rows = fs
      .readFileSync(path.join(x.root, "funding-journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      rows.at(-1).intent.prepared.transactionHash,
      keccak256(p.rawTransaction),
    );
    assert.equal(rows.at(-2).intent.stage, "prepared");
  };
  await x.service().tick(gate);
  x.setConversion({ state: "settled", evidenceId: "settlement-proof" });
  await x.service().tick(gate);
  assert.equal(
    (await x.service().tick(gate)).result,
    "awaiting-settled-balances",
  );
  x.setBalances({ baseUsdc: "7000000" });
  x.tr.submitCreditPayment = async (p) => {
    const row = JSON.parse(
      fs
        .readFileSync(path.join(x.root, "funding-journal.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1),
    );
    assert.deepEqual(row.intent.prepared, p);
    assert.equal(p.authorization.amountUsdc, "5000000");
  };
  await x.service().tick(gate);
  x.setPayment({ state: "credited", evidenceId: "credit-ledger-proof" });
  await x.service().tick(gate);
  assert.equal(x.service().status().pending, false);
  assert.match(
    fs.readFileSync(path.join(x.root, "funding-journal.jsonl"), "utf8"),
    /settlement-proof/,
  );
});
for (const step of [
  "prepareConversion",
  "broadcastConversion",
  "prepareCreditPayment",
  "submitCreditPayment",
])
  test(`${step} timeout survives restart: reconcile only, never prepare/rebuy`, async (t) => {
    const x = setup(t);
    if (step.includes("Credit")) x.setBalances({ baseUsdc: "6000000" });
    let count = 0;
    x.tr[step] = async () => {
      count++;
      throw Error("secret timeout");
    };
    await x.service().tick(gate);
    for (let n = 0; n < 3; n++) await x.service().tick(gate);
    assert.equal(count, 1);
    assert.equal(x.service().status().pending, true);
    assert.ok(!JSON.stringify(x.service().status()).includes("secret"));
  });
test("pending intent reconciles even if credits healthy; no evidence cannot release it", async (t) => {
  const x = setup(t);
  await x.service().tick(gate);
  x.setCredits("5000000");
  x.setConversion({ state: "settled" });
  await x.service().tick(gate);
  assert.equal(x.service().status().state, "broadcast");
  x.setConversion({ state: "failed", evidenceId: "failed" });
  await x.service().tick(gate);
  assert.equal(x.calls.filter((c) => c[0] === "prepareConversion").length, 1);
});
test("budget guards: total USD/native caps, source gas reserve and gasless merchant payments", async (t) => {
  for (const [field, value] of [
    ["maximumWei", "4000000000000001"],
    ["maximumUsdMicros", "10000001"],
    ["minimumUsdc", "5999999"],
    ["gasTopupUsdMicros", "2000000"],
  ]) {
    const x = setup(t);
    const quote = x.tr.quoteConversion;
    x.tr.quoteConversion = async (a) => ({
      ...(await quote(a)),
      [field]: value,
    });
    assert.equal(
      (await x.service().tick(gate)).result,
      "conversion-budget-blocked",
    );
    assert.equal(x.calls.filter((c) => c[0] === "prepareConversion").length, 0);
  }
  const x = setup(t);
  x.setBalances({ sourceWei: "1" });
  assert.equal(
    (await x.service().tick(gate)).result,
    "conversion-budget-blocked",
  );
  x.setBalances({ baseUsdc: "5000000", baseWei: "0" });
  assert.equal((await x.service().tick(gate)).state, "submitted");
});
test("dead PID lease recovery journals preserved pending intent before reconciliation", async (t) => {
  const x = setup(t);
  await x.service().tick(gate);
  const child = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  const pid = Number(child.stdout.toString());
  fs.writeFileSync(
    path.join(x.root, "funding-lease.json"),
    JSON.stringify({ pid, token: "dead" }),
  );
  await x.service().tick(gate);
  assert.match(
    fs.readFileSync(path.join(x.root, "funding-journal.jsonl"), "utf8"),
    /dead-process-recovery/,
  );
  assert.equal(x.calls.filter((c) => c[0] === "prepareConversion").length, 1);
});
test("active lease excludes concurrent controller, corrupt journal fails closed", async (t) => {
  const x = setup(t);
  let release;
  const wait = new Promise((r) => (release = r));
  x.tr.prepareConversion = async () => {
    await wait;
    throw Error("interrupted");
  };
  const first = x.service().tick(gate);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(x.service().tick(gate), /busy/);
  release();
  await first;
  fs.appendFileSync(path.join(x.root, "funding-journal.jsonl"), "{");
  assert.throws(() => x.service().status(), /Incomplete/);
  await assert.rejects(x.service().tick(gate));
});
test("invalid prepared hash or authorization cannot reach transport submission", async (t) => {
  const x = setup(t);
  x.tr.prepareConversion = async () => ({
    rawTransaction: "0x1234",
    transactionHash: "0x00",
  });
  assert.equal((await x.service().tick(gate)).result, "reconcile-required");
  assert.equal(x.calls.filter((c) => c[0] === "broadcast").length, 0);
  const y = setup(t);
  y.setBalances({ baseUsdc: "5000000" });
  y.tr.prepareCreditPayment = async (i) => ({
    authorization: { intentId: i.id, amountUsdc: "5000001" },
    payload: { signature: "private" },
  });
  await y.service().tick(gate);
  assert.equal(y.calls.filter((c) => c[0] === "submit").length, 0);
  assert.equal(y.service().status().state, "preparing");
});
test("rehearsal requires explicit isolated gate and transport; policy adjustable and validated", async (t) => {
  const x = setup(t);
  await assert.rejects(x.service().runRehearsal());
  await x.service().runRehearsal({ isolatedTestGate: true });
  x.tr.isRehearsal = false;
  await assert.rejects(x.service().runRehearsal({ isolatedTestGate: true }));
  assert.throws(
    () =>
      new FundingService({
        root: x.root,
        transport: x.tr,
        policy: { refillUsdc: "1.5" },
      }),
  );
  assert.throws(
    () =>
      new FundingService({
        root: x.root,
        transport: x.tr,
        policy: { unknown: "1" },
      }),
  );
});
