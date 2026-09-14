import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getOrderId, verifyRelayOrder } from "./relay-order.mjs";
const f = JSON.parse(
  readFileSync(
    new URL("./fixtures/relay/unsigned-quote.json", import.meta.url),
  ),
);
const clone = () => structuredClone(f.quote.protocol.v2.orderData);
const hex = (n) => "0x" + randomBytes(n).toString("hex");
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/relay/official-hash-vectors.json", import.meta.url),
  ),
).vectors;
test("fresh unsigned actual quote: recorded orderId and independently recovered canonical solver", () => {
  const p = f.quote.protocol.v2;
  assert.equal(getOrderId(p.orderData), p.orderId);
  const base = f.chains.find((c) => c.id === 8453);
  assert.equal(
    verifyRelayOrder(p, base.solverAddresses).signer.toLowerCase(),
    p.orderData.solver,
  );
  assert.equal(
    f.chains.find((c) => c.id === 4663).protocol.v2.depository.toLowerCase(),
    "0x4cd00e387622c35bddb9b4c962c136462338bc31",
  );
});
test("500 recorded independent official SDK hash vectors remain reproducible", () => {
  assert.equal(vectors.length, 500);
  for (const v of vectors) assert.equal(getOrderId(v.order), v.expected);
});
test("reject schema/VM/scope and malformed encoding instead of silently hashing ignored fields", () => {
  const mutations = [
    (o) => (o.version = "v2"),
    (o) => (o.solverChainId = "ethereum"),
    (o) => (o.unknown = true),
    (o) => o.inputs.push(o.inputs[0]),
    (o) => o.fees.push({}),
    (o) => o.output.calls.push("0x"),
    (o) => (o.output.extraData = "0x1234"),
    (o) => (o.output.payments[0].currency = o.inputs[0].payment.currency),
    (o) => (o.inputs[0].payment.weight = "2"),
    (o) => (o.inputs[0].payment.amount = -1),
    (o) => (o.salt = Number.MAX_SAFE_INTEGER + 1),
    (o) => (o.output.deadline = "4294967296"),
    (o) => (o.output.payments[0].recipient = "0x12"),
    (o) => (o.inputs[0].refunds[0].chainId = "solana"),
    (o) => (o.inputs[0].refunds[0].recipient = hex(20)),
    (o) => (o.output.payments[0].minimumAmount = "1.5"),
  ];
  for (const mutate of mutations) {
    const o = clone();
    mutate(o);
    assert.throws(() => getOrderId(o));
  }
  assert.throws(() =>
    getOrderId(clone(), { robinhood: "solana-vm", base: "ethereum-vm" }),
  );
  const p = structuredClone(f.quote.protocol.v2);
  p.orderData.salt = "1";
  assert.throws(() => verifyRelayOrder(p, f.chains[1].solverAddresses));
  assert.throws(() => verifyRelayOrder(f.quote.protocol.v2, []));
});
