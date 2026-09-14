import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, getBytes } from "ethers";
import { getOrderId } from "./relay-order.mjs";
import {
  validateRelay,
  validateVeniceRequirement,
  checkNativeBudget,
  usdMicros,
  depositAbi,
  USDC,
  NATIVE,
  DEPOSITORY,
  VENICE_PAYEE,
} from "../scripts/lib/payment-checks.mjs";
async function fixture() {
  const solver = Wallet.createRandom(),
    payer = "0x" + "1".repeat(40);
  const orderData = {
    version: "v1",
    solverChainId: "base",
    solver: solver.address,
    salt: "0x" + "2".repeat(64),
    inputs: [
      {
        payment: {
          chainId: "robinhood",
          currency: NATIVE,
          amount: "1000000000000000",
          weight: "1",
        },
        refunds: [
          {
            chainId: "robinhood",
            recipient: payer,
            currency: NATIVE,
            minimumAmount: "0",
            deadline: Math.floor(Date.now() / 1000) + 600,
            extraData: "0x",
          },
        ],
      },
    ],
    output: {
      chainId: "base",
      payments: [
        {
          recipient: payer,
          currency: USDC,
          minimumAmount: "6000000",
          expectedAmount: "6000000",
        },
      ],
      calls: [],
      deadline: Math.floor(Date.now() / 1000) + 600,
      extraData: "0x",
    },
    fees: [],
  };
  const id = getOrderId(orderData, {
    robinhood: "ethereum-vm",
    base: "ethereum-vm",
  });
  const quote = {
    protocol: {
      v2: {
        hubType: "onchain",
        orderData,
        orderId: id,
        orderSignature: await solver.signMessage(getBytes(id)),
        paymentDetails: {
          chainId: "robinhood",
          depository: DEPOSITORY,
          currency: NATIVE,
          amount: "1000000000000000",
        },
      },
    },
    details: {
      sender: payer,
      recipient: payer,
      currencyIn: {
        amount: "1000000000000000",
        amountUsd: "2.50",
        currency: { chainId: 4663 },
      },
    },
    steps: [
      {
        kind: "transaction",
        items: [
          {
            data: {
              from: payer,
              to: DEPOSITORY,
              chainId: 4663,
              value: "1000000000000000",
              data: depositAbi.encodeFunctionData("depositNative", [payer, id]),
            },
            check: { endpoint: "/intents/status/v3?requestId=0x1234" },
          },
        ],
      },
    ],
  };
  const chains = [
    { id: 4663, protocol: { v2: { depository: DEPOSITORY } } },
    { id: 8453, solverAddresses: [solver.address] },
  ];
  return { quote, chains, payer };
}
test("offline quote validation binds canonical order to payer and transaction", async () => {
  const { quote, chains, payer } = await fixture();
  assert.equal(validateRelay(quote, chains, payer).minUsdc, 6000000n);
});
test("wrong recipient, wrong depository, extra calls and altered native amount are rejected", async () => {
  const { quote, chains, payer } = await fixture();
  for (const mutate of [
    (q) =>
      (q.protocol.v2.orderData.output.payments[0].recipient =
        "0x" + "3".repeat(40)),
    (q) => (q.steps[0].items[0].data.to = "0x" + "3".repeat(40)),
    (q) => q.protocol.v2.orderData.output.calls.push({}),
    (q) => (q.steps[0].items[0].data.value = "2000000000000000"),
  ]) {
    const q = structuredClone(quote);
    mutate(q);
    assert.throws(() => validateRelay(q, chains, payer));
  }
});
test("only the live five USDC merchant requirement is eligible", () => {
  const q = {
    x402Version: 2,
    accepts: [
      {
        network: "eip155:8453",
        asset: USDC,
        scheme: "exact",
        payTo: VENICE_PAYEE,
        amount: "5000000",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  assert.equal(validateVeniceRequirement(q).amount, "5000000");
  q.accepts[0].amount = "50000000";
  assert.throws(() => validateVeniceRequirement(q));
  q.accepts[0].amount = "5000000";
  q.accepts[0].payTo = "0x" + "3".repeat(40);
  assert.throws(() => validateVeniceRequirement(q));
});
test("native test cost cap includes maximum gas and retains reserve", () => {
  const args = {
    value: 1000000000000000n,
    gasLimit: 30000n,
    gasPrice: 100000000n,
    inputUsdMicros: 2500000n,
    balance: 30000000000000000n,
  };
  assert(checkNativeBudget(args).totalUsdMicros < 10000000n);
  assert.throws(() => checkNativeBudget({ ...args, value: 5000000000000000n }));
  assert.throws(() =>
    checkNativeBudget({ ...args, balance: 1000000000000000n }),
  );
  assert.throws(() =>
    checkNativeBudget({ ...args, gasPrice: 100000000000000n }),
  );
  assert.equal(usdMicros("1.0000001"), 1000001n);
});
