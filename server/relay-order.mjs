/* SPDX-License-Identifier: MIT
 * Narrow adaptation of @relay-protocol/settlement-sdk 0.0.141,
 * Uneven Labs, dist/order/index.js (ORDER_EIP712_TYPES / getOrderId) and
 * dist/utils.js (ethereum-vm address encoding). Package declares MIT.
 * Source: https://github.com/relayprotocol/settlement-protocol/packages/sdk
 * Protocol envelope v2/onchain currently uses order schema version v1!
 * This is hashStruct(Order), NOT an EIP-712 domain digest or getOrderV2Id.
 */
import { TypedDataEncoder, getBytes, verifyMessage } from "ethers";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const fields = (s) =>
  s.split(" ").map((x) => {
    const [name, type] = x.split(":");
    return { name, type };
  });
const TYPES = {
  Order: fields(
    "version:string solverChainId:string solver:address salt:uint256 inputs:Input[] output:Output fees:Fee[]",
  ),
  Input: fields("payment:InputPayment refunds:InputRefund[]"),
  InputPayment: fields(
    "chainId:string currency:bytes amount:uint256 weight:uint256",
  ),
  InputRefund: fields(
    "chainId:string recipient:bytes currency:bytes minimumAmount:uint256 deadline:uint32 extraData:bytes",
  ),
  Output: fields(
    "chainId:string payments:OutputPayment[] deadline:uint32 calls:bytes[] extraData:bytes",
  ),
  OutputPayment: fields(
    "recipient:bytes currency:bytes minimumAmount:uint256 expectedAmount:uint256",
  ),
  Fee: fields(
    "recipientChainId:string recipient:bytes currencyChainId:string currency:bytes amount:uint256",
  ),
};
const ok = (v, m) => {
  if (!v) throw new Error(`Unsupported Relay order: ${m}`);
};
const eq = (a, b) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function shape(o, type) {
  ok(o && typeof o === "object" && !Array.isArray(o), type);
  const names = TYPES[type].map((f) => f.name);
  ok(
    Object.keys(o).length === names.length &&
      names.every((n) => Object.hasOwn(o, n)),
    `${type} schema`,
  );
}
function uint(v, bits = 256) {
  ok(
    (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) ||
      (typeof v === "number" && Number.isSafeInteger(v)) ||
      typeof v === "bigint",
    "integer encoding",
  );
  const n = BigInt(v);
  ok(n >= 0n && n < 1n << BigInt(bits), "integer range");
  return n;
}
function address(v) {
  ok(typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v), "EVM address");
}
function extra(v) {
  ok(
    v === "0x" || (typeof v === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(v)),
    "extraData: only empty or ABI address metadata",
  );
}
export function getOrderId(
  order,
  config = { robinhood: "ethereum-vm", base: "ethereum-vm" },
) {
  ok(
    config &&
      Object.keys(config).length === 2 &&
      config.robinhood === "ethereum-vm" &&
      config.base === "ethereum-vm",
    "VM configuration",
  );
  shape(order, "Order");
  ok(
    order.version === "v1" && order.solverChainId === "base",
    "version/solver chain",
  );
  address(order.solver);
  uint(order.salt);
  ok(Array.isArray(order.inputs) && order.inputs.length === 1, "one input");
  ok(Array.isArray(order.fees) && order.fees.length === 0, "fees");
  const i = order.inputs[0];
  shape(i, "Input");
  shape(i.payment, "InputPayment");
  ok(
    i.payment.chainId === "robinhood" && eq(i.payment.currency, NATIVE),
    "source asset",
  );
  ok(
    uint(i.payment.amount) > 0n && uint(i.payment.weight) === 1n,
    "input amount/weight",
  );
  const o = order.output;
  shape(o, "Output");
  ok(
    o.chainId === "base" && Array.isArray(o.calls) && o.calls.length === 0,
    "output route/calls",
  );
  uint(o.deadline, 32);
  extra(o.extraData);
  ok(
    Array.isArray(o.payments) && o.payments.length === 1,
    "one output payment",
  );
  const p = o.payments[0];
  shape(p, "OutputPayment");
  address(p.recipient);
  ok(eq(p.currency, USDC), "output currency");
  ok(
    uint(p.minimumAmount) > 0n &&
      uint(p.expectedAmount) >= uint(p.minimumAmount),
    "output amounts",
  );
  ok(
    Array.isArray(i.refunds) && i.refunds.length >= 1 && i.refunds.length <= 2,
    "refunds",
  );
  const seen = new Set();
  for (const r of i.refunds) {
    shape(r, "InputRefund");
    ok(
      ["base", "robinhood"].includes(r.chainId) && !seen.has(r.chainId),
      "refund chain",
    );
    seen.add(r.chainId);
    address(r.recipient);
    ok(eq(r.recipient, p.recipient), "refund ownership");
    ok(eq(r.currency, r.chainId === "base" ? USDC : NATIVE), "refund currency");
    uint(r.minimumAmount);
    uint(r.deadline, 32);
    extra(r.extraData);
  }
  // EVM bytes addresses are exactly their 20 raw bytes (no ABI padding).
  // ethers checks solver checksum; SDK treats case identically, so normalize it.
  return TypedDataEncoder.hashStruct("Order", TYPES, {
    ...order,
    solver: order.solver.toLowerCase(),
  });
}
export function verifyRelayOrder(protocol, solverAddresses) {
  ok(protocol?.hubType === "onchain", "hub");
  const id = getOrderId(protocol.orderData);
  ok(eq(protocol.orderId, id), "hash mismatch");
  const signer = verifyMessage(getBytes(id), protocol.orderSignature);
  ok(
    eq(signer, protocol.orderData.solver) &&
      Array.isArray(solverAddresses) &&
      solverAddresses.some((a) => eq(signer, a)),
    "solver signature",
  );
  return { orderId: id, signer };
}
