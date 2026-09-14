import { Interface, getBytes, verifyMessage } from "ethers";
import { getOrderId } from "../../server/relay-order.mjs";
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
export const VENICE_PAYEE = "0x2670b922ef37c7df47158725c0cc407b5382293f";
export const depositAbi = new Interface([
  "function depositNative(address depositor, bytes32 id)",
]);
export const usdcAbi = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address,bytes32) view returns(bool)",
]);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const assert = (v, m) => {
  if (!v) throw new Error(m);
};
export function usdMicros(value) {
  const s = String(value);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid dollar amount");
  const [a, b = ""] = s.split(".");
  return (
    BigInt(a) * 1000000n +
    BigInt((b + "000000").slice(0, 6)) +
    (b.slice(6).replace(/0/g, "") ? 1n : 0n)
  );
}
export function validateRelay(quote, chains, address, now = Date.now()) {
  const p = quote.protocol?.v2,
    o = p?.orderData;
  assert(o && p.hubType === "onchain", "missing supported protocol order");
  const origin = chains.find((c) => c.id === 4663),
    dest = chains.find((c) => c.id === 8453);
  assert(
    origin && !origin.disabled && dest && !dest.disabled,
    "chain unavailable",
  );
  assert(
    equal(origin.protocol?.v2?.depository, DEPOSITORY),
    "canonical depository changed",
  );
  assert(
    o.inputs?.length === 1 &&
      o.output?.chainId === "base" &&
      o.output.calls?.length === 0 &&
      o.fees?.length === 0,
    "unexpected route scope",
  );
  const input = o.inputs[0].payment;
  assert(
    input.chainId === "robinhood" && equal(input.currency, NATIVE),
    "unexpected input asset",
  );
  assert(
    o.inputs[0].refunds?.length > 0 &&
      o.inputs[0].refunds.every(
        (r) =>
          equal(r.recipient, address) &&
          ["base", "robinhood"].includes(r.chainId),
      ),
    "unexpected refund recipient",
  );
  assert(o.output.deadline > Math.floor(now / 1000) + 30, "order expired");
  assert(o.output.payments?.length === 1, "unexpected output payments");
  const output = o.output.payments[0];
  assert(
    equal(output.recipient, address) &&
      equal(output.currency, USDC) &&
      BigInt(output.minimumAmount) >= 6000000n,
    "output does not guarantee six usdc to owned wallet",
  );
  const computed = getOrderId(o, {
    robinhood: "ethereum-vm",
    base: "ethereum-vm",
  });
  assert(equal(computed, p.orderId), "order hash mismatch");
  const signer = verifyMessage(getBytes(computed), p.orderSignature);
  assert(
    equal(signer, o.solver) &&
      (dest.solverAddresses ?? []).some((s) => equal(s, signer)),
    "unrecognized order signer",
  );
  assert(
    equal(p.paymentDetails?.depository, DEPOSITORY) &&
      p.paymentDetails.chainId === "robinhood" &&
      equal(p.paymentDetails.currency, NATIVE) &&
      BigInt(p.paymentDetails.amount) === BigInt(input.amount),
    "payment detail mismatch",
  );
  const steps = quote.steps ?? [];
  assert(
    steps.length === 1 &&
      steps[0].kind === "transaction" &&
      steps[0].items?.length === 1,
    "unexpected extra actions",
  );
  const item = steps[0].items[0],
    tx = item.data;
  assert(
    tx.chainId === 4663 && equal(tx.from, address) && equal(tx.to, DEPOSITORY),
    "wrong transaction target",
  );
  const decoded = depositAbi.parseTransaction({
    data: tx.data,
    value: tx.value,
  });
  assert(
    decoded?.name === "depositNative" &&
      equal(decoded.args[0], address) &&
      equal(decoded.args[1], computed),
    "transaction not bound to checked order",
  );
  assert(
    BigInt(tx.value) === BigInt(input.amount) && BigInt(tx.value) > 0n,
    "wrong transaction value",
  );
  assert(
    equal(quote.details?.sender, address) &&
      equal(quote.details?.recipient, address),
    "wrong quote ownership",
  );
  assert(
    BigInt(quote.details.currencyIn.amount) === BigInt(tx.value) &&
      quote.details.currencyIn.currency.chainId === 4663,
    "wrong quote amount",
  );
  assert(
    usdMicros(quote.details.currencyIn.amountUsd) > 0n &&
      usdMicros(quote.details.currencyIn.amountUsd) < 10000000n,
    "quote exceeds test cap before gas",
  );
  assert(
    typeof item.check?.endpoint === "string" &&
      /^\/intents\/status\/v3\?requestId=0x[0-9a-f]+$/i.test(
        item.check.endpoint,
      ),
    "unsafe settlement check URL",
  );
  return {
    tx,
    orderId: computed,
    orderData: o,
    checkPath: item.check.endpoint,
    inputUsdMicros: usdMicros(quote.details.currencyIn.amountUsd),
    minUsdc: BigInt(output.minimumAmount),
  };
}
export function validateVeniceRequirement(body) {
  assert(body.x402Version === 2, "unexpected payment protocol");
  const req = body.accepts?.find(
    (r) => r.network === "eip155:8453" && equal(r.asset, USDC),
  );
  assert(
    req && req.scheme === "exact" && equal(req.payTo, VENICE_PAYEE),
    "unapproved payment recipient or asset",
  );
  assert(
    BigInt(req.amount) === 5000000n &&
      req.maxTimeoutSeconds >= 30 &&
      req.maxTimeoutSeconds <= 300,
    "payment outside five dollar test",
  );
  assert(
    req.extra?.name === "USD Coin" && req.extra.version === "2",
    "unexpected usdc domain",
  );
  return req;
}
export function checkNativeBudget({
  value,
  gasLimit,
  gasPrice,
  inputUsdMicros,
  balance,
}) {
  const maximumWei = value + gasLimit * gasPrice;
  const totalUsdMicros = (maximumWei * inputUsdMicros + value - 1n) / value;
  assert(
    totalUsdMicros <= 10000000n,
    "maximum source cost exceeds ten dollar test cap",
  );
  assert(maximumWei <= 4000000000000000n, "absolute native value cap exceeded");
  assert(
    balance >= maximumWei + 100000000000000n,
    "insufficient balance plus source gas reserve",
  );
  return { maximumWei, totalUsdMicros };
}
