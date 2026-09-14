import { readFile, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  Wallet,
  keccak256,
  verifyTypedData,
  Interface,
  id,
  zeroPadValue,
} from "ethers";
import { SiweMessage } from "siwe";
import {
  validateRelay,
  validateVeniceRequirement,
  checkNativeBudget,
  usdcAbi,
  USDC,
  NATIVE,
  VENICE_PAYEE,
} from "../scripts/lib/payment-checks.mjs";
import {
  creditAdmission,
  DEFAULT_CREDIT_POLICY,
  CreditWaitError,
} from "./credit-guard.mjs";
import { RpcPool, RH_RPC, RH_RPC_FALLBACK } from "./rpc-pool.mjs";
const RH = "https://rpc.mainnet.chain.robinhood.com",
  BASE = "https://mainnet.base.org",
  VENICE = "https://api.venice.ai";
const stringify = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const moneyMicros = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000000)
    throw Error("invalid credit balance");
  return BigInt(Math.floor(n * 1000000)).toString();
};
async function durable(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp",
    h = await open(tmp, "w", 0o600);
  try {
    await h.writeFile(stringify(data));
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, file);
}
export class WalletTransport {
  #walletValue;
  #queue = Promise.resolve();
  constructor({
    privateRoot = path.join(homedir(), ".local/share/project-rat-race"),
    root,
    model = "qwen3-coder-480b-a35b-instruct-turbo",
    isRehearsal = false,
    rpcUrl = RH_RPC,
    rpcFallbackUrls = [RH_RPC_FALLBACK],
    rpcFetch = fetch,
    canSpend = () => false,
  } = {}) {
    this.privateRoot = privateRoot;
    this.root = root ?? path.join(privateRoot, "finance-v1", "transport");
    this.model = model;
    this.isRehearsal = isRehearsal;
    this.canSpend = canSpend;
    this.address = null;
    this.ready = false;
    this.catalog = null;
    this.catalogAt = 0;
    this.rhRpc = new RpcPool({
      urls: [rpcUrl, ...rpcFallbackUrls],
      chainId: 4663,
      fetchImpl: rpcFetch,
    });
    this.baseRpc = new RpcPool({
      urls: [BASE],
      chainId: 8453,
      fetchImpl: rpcFetch,
    });
  }
  async exclusive(fn) {
    const old = this.#queue;
    let done;
    this.#queue = new Promise((r) => (done = r));
    await old;
    try {
      return await fn();
    } finally {
      done();
    }
  }
  async initialize() {
    if (!this.address) {
      const meta = JSON.parse(
        await readFile(
          path.join(this.privateRoot, "wallet.public.json"),
          "utf8",
        ),
      );
      if (!/^0x[0-9a-f]{40}$/i.test(meta.address))
        throw Error("invalid project wallet identity");
      this.address = meta.address;
    }
    return this;
  }
  async wallet() {
    await this.initialize();
    if (!this.#walletValue) {
      try {
        const r = spawnSync(
          path.join(this.privateRoot, "keychain-helper"),
          ["read"],
          { encoding: "utf8", timeout: 20000, maxBuffer: 8192 },
        );
        if (r.status !== 0) throw Error();
        const w = new Wallet(JSON.parse(r.stdout).privateKey);
        if (w.address.toLowerCase() !== this.address.toLowerCase())
          throw Error();
        this.#walletValue = w;
      } catch {
        throw Error("protected project signing identity unavailable");
      }
    }
    return this.#walletValue;
  }
  async json(url, options = {}) {
    const { timeoutMs = 25000, ...requestOptions } = options;
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      ![
        "api.relay.link",
        "api.venice.ai",
        "rpc.mainnet.chain.robinhood.com",
        "mainnet.base.org",
      ].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      throw Error("unapproved wallet service");
    const r = await fetch(u, {
      ...requestOptions,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reader = r.body.getReader();
    let bytes = 0,
      text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const x = await reader.read();
        if (x.done) break;
        bytes += x.value.length;
        if (bytes > 2000000) throw Error("wallet response too large");
        text += decoder.decode(x.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    let data;
    try {
      data = JSON.parse(text + decoder.decode());
    } catch {
      throw Error("wallet service returned non JSON");
    }
    return { ok: r.ok, status: r.status, data };
  }
  async rpc(chain, method, params = []) {
    const pool =
      chain === 4663 ? this.rhRpc : chain === 8453 ? this.baseRpc : null;
    if (!pool) throw Error("unsupported chain");
    return pool.call(method, params);
  }
  async auth(resource) {
    const w = await this.wallet(),
      now = new Date(),
      message = new SiweMessage({
        domain: "api.venice.ai",
        address: w.address,
        statement: "Sign in to Venice AI",
        uri: VENICE + resource,
        version: "1",
        chainId: 8453,
        nonce: randomBytes(8).toString("hex"),
        issuedAt: now.toISOString(),
        expirationTime: new Date(now.getTime() + 300000).toISOString(),
      }).prepareMessage();
    return Buffer.from(
      JSON.stringify({
        address: w.address,
        message,
        signature: await w.signMessage(message),
        timestamp: now.getTime(),
        chainId: 8453,
      }),
    ).toString("base64");
  }
  async veniceRead(resource) {
    const r = await this.json(VENICE + resource, {
      headers: { "X-Sign-In-With-X": await this.auth(resource) },
    });
    if (!r.ok) throw Error("provider read unavailable");
    const d = r.data.data ?? r.data;
    if (
      d.walletAddress &&
      d.walletAddress.toLowerCase() !== this.address.toLowerCase()
    )
      throw Error("provider wallet identity mismatch");
    return d;
  }
  async balances() {
    await this.initialize();
    const [rhChain, baseChain] = await Promise.all([
      this.rpc(4663, "eth_chainId"),
      this.rpc(8453, "eth_chainId"),
    ]);
    if (BigInt(rhChain) !== 4663n || BigInt(baseChain) !== 8453n)
      throw Error("wallet RPC network mismatch");
    const [rh, pending, base, usdc] = await Promise.all([
      this.rpc(4663, "eth_getBalance", [this.address, "latest"]),
      this.rpc(4663, "eth_getBalance", [this.address, "pending"]),
      this.rpc(8453, "eth_getBalance", [this.address, "latest"]),
      this.rpc(8453, "eth_call", [
        {
          to: USDC,
          data: usdcAbi.encodeFunctionData("balanceOf", [this.address]),
        },
        "latest",
      ]),
    ]);
    return {
      sourceWei: (BigInt(rh) < BigInt(pending)
        ? BigInt(rh)
        : BigInt(pending)
      ).toString(),
      baseWei: BigInt(base).toString(),
      baseUsdc: usdcAbi.decodeFunctionResult("balanceOf", usdc)[0].toString(),
    };
  }
  async credits() {
    return this.exclusive(async () => {
      await this.initialize();
      const d = await this.veniceRead("/api/v1/x402/balance/" + this.address);
      this.ready = true;
      return {
        availableUsdMicros: moneyMicros(d.balanceUsd),
        balanceUsd: Number(d.balanceUsd),
      };
    });
  }
  file(intent) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(intent.id))
      throw Error("invalid financial intent");
    return path.join(this.root, intent.id + ".json");
  }
  async stored(intent) {
    try {
      return JSON.parse(await readFile(this.file(intent), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw Error("financial transport record corrupt");
    }
  }
  async quoteConversion({ amountUsdc, gasTopupUsdMicros }) {
    await this.initialize();
    if (
      amountUsdc !== "6000000" ||
      !["0", "2000000"].includes(gasTopupUsdMicros)
    )
      throw Error("unsupported refill quote");
    const [registry, quote] = await Promise.all([
      this.json("https://api.relay.link/chains"),
      this.json("https://api.relay.link/quote/v2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: this.address,
          recipient: this.address,
          refundTo: this.address,
          originChainId: 4663,
          destinationChainId: 8453,
          originCurrency: NATIVE,
          destinationCurrency: USDC,
          tradeType: "EXACT_OUTPUT",
          amount: amountUsdc,
          slippageTolerance: "50",
          topupGas: gasTopupUsdMicros !== "0",
          includeProtocolData: true,
        }),
      }),
    ]);
    if (!registry.ok || !quote.ok) throw Error("conversion quote unavailable");
    const checked = validateRelay(
        quote.data,
        registry.data.chains,
        this.address,
      ),
      value = BigInt(checked.tx.value),
      estimate = BigInt(
        await this.rpc(4663, "eth_estimateGas", [
          {
            from: this.address,
            to: checked.tx.to,
            data: checked.tx.data,
            value: "0x" + value.toString(16),
          },
        ]),
      ),
      gasLimit = (estimate * 120n + 99n) / 100n,
      gasPrice = BigInt(await this.rpc(4663, "eth_gasPrice")) * 2n,
      b = await this.balances(),
      budget = checkNativeBudget({
        value,
        gasLimit,
        gasPrice,
        inputUsdMicros: checked.inputUsdMicros,
        balance: BigInt(b.sourceWei),
      });
    return {
      maximumWei: budget.maximumWei.toString(),
      maximumUsdMicros: budget.totalUsdMicros.toString(),
      minimumUsdc: checked.minUsdc.toString(),
      gasTopupUsdMicros,
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      createdAt: Date.now(),
      quote: quote.data,
      chains: registry.data.chains,
    };
  }
  async prepareConversion(quote, intent) {
    return this.exclusive(async () => {
      if (!(await this.canSpend()))
        throw Error("financial execution is not authorized");
      const old = await this.stored(intent);
      if (old?.prepared) return old.prepared;
      if (Date.now() - quote.createdAt > 60000)
        throw Error("quote too old to sign");
      await this.initialize();
      const c = validateRelay(quote.quote, quote.chains, this.address),
        b = await this.balances();
      checkNativeBudget({
        value: BigInt(c.tx.value),
        gasLimit: BigInt(quote.gasLimit),
        gasPrice: BigInt(quote.gasPrice),
        inputUsdMicros: c.inputUsdMicros,
        balance: BigInt(b.sourceWei),
      });
      const nonce = Number(
          BigInt(
            await this.rpc(4663, "eth_getTransactionCount", [
              this.address,
              "pending",
            ]),
          ),
        ),
        w = await this.wallet(),
        raw = await w.signTransaction({
          type: 2,
          chainId: 4663,
          nonce,
          to: c.tx.to,
          value: BigInt(c.tx.value),
          data: c.tx.data,
          gasLimit: BigInt(quote.gasLimit),
          maxFeePerGas: BigInt(quote.gasPrice),
          maxPriorityFeePerGas: 0n,
        });
      const prepared = {
        intentId: intent.id,
        rawTransaction: raw,
        transactionHash: keccak256(raw),
      };
      await durable(this.file(intent), {
        intent,
        prepared,
        before: b,
        checkPath: c.checkPath,
        gasTopupUsdMicros: quote.gasTopupUsdMicros,
        preparedAt: Date.now(),
      });
      return prepared;
    });
  }
  async broadcastConversion(prepared) {
    return this.exclusive(async () => {
      if (!(await this.canSpend()))
        throw Error("financial execution is not authorized");
      const r = await this.stored({ id: prepared.intentId });
      if (!r || stringify(r.prepared) !== stringify(prepared))
        throw Error("conversion not journal bound");
      r.submittedAt ??= Date.now();
      await durable(this.file(r.intent), r);
      const hash = await this.rpc(4663, "eth_sendRawTransaction", [
        prepared.rawTransaction,
      ]);
      if (hash.toLowerCase() !== prepared.transactionHash.toLowerCase())
        throw Error("broadcast identity mismatch");
      r.broadcastHash = hash;
      await durable(this.file(r.intent), r);
      return { transactionHash: hash };
    });
  }
  async reconcileConversion(intent) {
    const r = await this.stored(intent);
    if (!r?.prepared)
      return {
        state: "failed",
        safeToRetry: true,
        evidenceId: "no-prepared-transaction:" + intent.id,
      };
    const hash = r.prepared.transactionHash;
    let receipt = await this.rpc(4663, "eth_getTransactionReceipt", [hash]);
    if (!receipt) {
      const tx = await this.rpc(4663, "eth_getTransactionByHash", [hash]);
      if (!tx) await this.broadcastConversion(r.prepared).catch(() => {});
      return { state: "pending" };
    }
    const head = BigInt(await this.rpc(4663, "eth_blockNumber"));
    if (head - BigInt(receipt.blockNumber) < 11n) return { state: "pending" };
    const block = await this.rpc(4663, "eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (block.hash !== receipt.blockHash) return { state: "pending" };
    if (receipt.status !== "0x1")
      return {
        state: "failed",
        safeToRetry: true,
        evidenceId: "reverted:" + hash,
      };
    const [b, status] = await Promise.all([
      this.balances(),
      this.json("https://api.relay.link" + r.checkPath),
    ]);
    r.receipt = receipt;
    r.latestStatus = status.data;
    r.latestBalances = b;
    await durable(this.file(intent), r);
    if (
      BigInt(b.baseUsdc) - BigInt(r.before.baseUsdc) >= 6000000n &&
      (r.gasTopupUsdMicros === "0" ||
        BigInt(b.baseWei) > BigInt(r.before.baseWei))
    ) {
      r.settledAt = Date.now();
      await durable(this.file(intent), r);
      return { state: "settled", evidenceId: hash };
    }
    return { state: "pending" };
  }
  async prepareCreditPayment(intent) {
    return this.exclusive(async () => {
      if (!(await this.canSpend()))
        throw Error("financial execution is not authorized");
      const old = await this.stored(intent);
      if (old?.prepared) return old.prepared;
      await this.initialize();
      if (intent.amountUsdc !== "5000000")
        throw Error("unsupported credit amount");
      const b = await this.balances();
      if (BigInt(b.baseUsdc) < 5000000n) throw Error("base USDC unavailable");
      const challenge = await this.json(VENICE + "/api/v1/x402/top-up", {
        method: "POST",
      });
      if (challenge.status !== 402)
        throw Error("merchant challenge unavailable");
      const req = validateVeniceRequirement(challenge.data),
        w = await this.wallet(),
        now = Math.floor(Date.now() / 1000),
        authorization = {
          from: w.address,
          to: req.payTo,
          value: req.amount,
          validAfter: String(now - 600),
          validBefore: String(now + req.maxTimeoutSeconds),
          nonce: "0x" + randomBytes(32).toString("hex"),
        };
      const domain = {
          name: "USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: USDC,
        },
        types = {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        signature = await w.signTypedData(domain, types, authorization);
      if (
        verifyTypedData(domain, types, authorization, signature) !== w.address
      )
        throw Error("payment signer mismatch");
      const ledger = await this.veniceRead(
          "/api/v1/x402/transactions/" + this.address + "?limit=50&offset=0",
        ),
        payload = Buffer.from(
          JSON.stringify({
            x402Version: 2,
            scheme: "exact",
            network: "base",
            payload: { signature, authorization },
          }),
        ).toString("base64"),
        prepared = {
          intentId: intent.id,
          authorization: {
            intentId: intent.id,
            amountUsdc: intent.amountUsdc,
            nonce: authorization.nonce,
            expiresAt: Number(authorization.validBefore),
          },
          payload,
        };
      await durable(this.file(intent), {
        intent,
        prepared,
        before: b,
        existingTopups: (ledger.transactions ?? [])
          .filter((x) => x.type === "TOP_UP")
          .map((x) => x.id),
        baseStartBlock: await this.rpc(8453, "eth_blockNumber"),
        preparedAt: Date.now(),
      });
      return prepared;
    });
  }
  async submitCreditPayment(prepared) {
    return this.exclusive(async () => {
      if (!(await this.canSpend()))
        throw Error("financial execution is not authorized");
      const r = await this.stored({ id: prepared.intentId });
      if (!r || stringify(r.prepared) !== stringify(prepared))
        throw Error("credit payment not journal bound");
      if (r.response?.success) return { accepted: true };
      r.submittedAt ??= Date.now();
      await durable(this.file(r.intent), r);
      const paid = await this.json(VENICE + "/api/v1/x402/top-up", {
        method: "POST",
        headers: { "X-402-Payment": prepared.payload },
      });
      r.response = paid.data;
      r.httpStatus = paid.status;
      await durable(this.file(r.intent), r);
      if (!paid.ok)
        throw Error("merchant payment response requires reconciliation");
      return { accepted: true };
    });
  }
  async reconcileCreditPayment(intent) {
    await this.initialize();
    const r = await this.stored(intent);
    if (!r?.prepared)
      return {
        state: "failed",
        safeToRetry: true,
        evidenceId: "no-prepared-credit:" + intent.id,
      };
    const nonce = r.prepared.authorization.nonce,
      result = await this.rpc(8453, "eth_call", [
        {
          to: USDC,
          data: usdcAbi.encodeFunctionData("authorizationState", [
            this.address,
            nonce,
          ]),
        },
        "latest",
      ]),
      used = usdcAbi.decodeFunctionResult("authorizationState", result)[0];
    if (!used) {
      if (Date.now() / 1000 > r.prepared.authorization.expiresAt + 30)
        return {
          state: "failed",
          safeToRetry: true,
          evidenceId: "expired-unused-authorization:" + nonce,
        };
      if (!r.submittedAt)
        await this.submitCreditPayment(r.prepared).catch(() => {});
      return { state: "pending" };
    }
    const ledger = await this.veniceRead(
        "/api/v1/x402/transactions/" + this.address + "?limit=50&offset=0",
      ),
      topup = (ledger.transactions ?? []).find(
        (x) =>
          x.type === "TOP_UP" &&
          Number(x.amount) === 5 &&
          !r.existingTopups.includes(x.id) &&
          Date.parse(x.createdAt) >= r.preparedAt - 5000,
      );
    if (!topup) return { state: "pending" };
    const iface = new Interface([
      "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
      "event Transfer(address indexed from,address indexed to,uint256 value)",
    ]);
    const logs = await this.rpc(8453, "eth_getLogs", [
      {
        address: USDC,
        fromBlock: r.baseStartBlock,
        toBlock: "latest",
        topics: [
          iface.getEvent("AuthorizationUsed").topicHash,
          zeroPadValue(this.address, 32),
          nonce,
        ],
      },
    ]);
    if (!logs.length) return { state: "pending" };
    const receipt = await this.rpc(8453, "eth_getTransactionReceipt", [
      logs[0].transactionHash,
    ]);
    if (
      receipt?.status !== "0x1" ||
      !receipt.logs.some((l) => {
        try {
          const p = iface.parseLog(l);
          return (
            l.address.toLowerCase() === USDC &&
            p?.name === "Transfer" &&
            p.args.from.toLowerCase() === this.address.toLowerCase() &&
            p.args.to.toLowerCase() === VENICE_PAYEE &&
            p.args.value === 5000000n
          );
        } catch {
          return false;
        }
      })
    )
      throw Error("merchant transfer identity not verified");
    const latest = BigInt(await this.rpc(8453, "eth_blockNumber"));
    if (latest - BigInt(receipt.blockNumber) < 11n) return { state: "pending" };
    const canonical = await this.rpc(8453, "eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (canonical.hash !== receipt.blockHash) return { state: "pending" };
    r.creditedAt = Date.now();
    r.creditEvidence = {
      ledgerId: topup.id,
      transactionHash: receipt.transactionHash,
    };
    await durable(this.file(intent), r);
    return { state: "credited", evidenceId: receipt.transactionHash };
  }
  async preflight({
    requiredUsdMicros = DEFAULT_CREDIT_POLICY.maxRequestUsdMicros,
  } = {}) {
    if (!(await this.canSpend())) throw Error("paid inference not authorized");
    if (this.creditGuard) return this.creditGuard.check({ requiredUsdMicros });
    try {
      const c = await this.credits();
      return {
        ...creditAdmission(c.availableUsdMicros, requiredUsdMicros),
        reason: "waiting for verified AI credit reserve",
        retryAfterMs: 15000,
      };
    } catch {
      return {
        ready: false,
        reason: "provider credit balance unavailable",
        retryAfterMs: 15000,
      };
    }
  }
  async complete({
    messages,
    maxTokens = 3500,
    responseFormat = { type: "json_object" },
    requestId,
  }) {
    const admission = await this.preflight();
    if (!admission.ready) throw new CreditWaitError(admission.reason);
    return this.exclusive(async () => {
      if (!(await this.canSpend()))
        throw Error("paid inference not authorized");
      await this.initialize();
      if (
        !Array.isArray(messages) ||
        JSON.stringify(messages).length > 130000 ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 4000
      )
        throw Error("AI request bounds exceeded");
      if (!this.catalog || Date.now() - this.catalogAt > 300000) {
        const r = await this.json(VENICE + "/api/v1/models?type=text");
        this.catalog = r.data.data;
        this.catalogAt = Date.now();
      }
      const m = this.catalog?.find(
        (m) => m.id === this.model && !m.model_spec?.offline,
      );
      if (
        !m ||
        Number(m.model_spec?.pricing?.input?.usd) > 0.5 ||
        Number(m.model_spec?.pricing?.output?.usd) > 2
      )
        throw Error("configured model unavailable or above rate ceiling");
      const upperCost =
        ((Buffer.byteLength(JSON.stringify(messages)) + 1024) *
          Number(m.model_spec.pricing.input.usd) +
          maxTokens * Number(m.model_spec.pricing.output.usd)) /
        1000000;
      if (upperCost > 0.02) throw Error("request upper cost exceeds allowance");
      const balance = await this.veniceRead(
        "/api/v1/x402/balance/" + this.address,
      );
      const checked = creditAdmission(
        moneyMicros(balance.balanceUsd),
        DEFAULT_CREDIT_POLICY.maxRequestUsdMicros,
        this.creditGuard?.policy ?? DEFAULT_CREDIT_POLICY,
      );
      if (checked.refillNeeded) this.creditGuard?.requestRefill();
      if (!checked.ready)
        throw new CreditWaitError(
          "waiting for verified refill before starting another paid request",
        );
      const resource = "/api/v1/chat/completions",
        r = await this.json(VENICE + resource, {
          timeoutMs: 180000,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Sign-In-With-X": await this.auth(resource),
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            max_tokens: maxTokens,
            response_format: responseFormat,
            temperature: 0.3,
            venice_parameters: {
              include_venice_system_prompt: false,
              disable_thinking: true,
              strip_thinking_response: true,
            },
          }),
        });
      if (r.status === 402) {
        this.creditGuard?.requestRefill();
        throw new CreditWaitError(
          "provider declined available credit. work is saved while funding is checked",
        );
      }
      if (!r.ok) throw Error("AI request failed with HTTP " + r.status);
      const response = r.data;
      if (
        response.choices?.[0]?.finish_reason !== "stop" ||
        typeof response.choices?.[0]?.message?.content !== "string"
      )
        throw Error("AI output incomplete");
      let charge;
      for (let n = 0; n < 4; n++) {
        const ledger = await this.veniceRead(
          "/api/v1/x402/transactions/" + this.address + "?limit=50&offset=0",
        );
        charge = ledger.transactions?.find(
          (x) => x.type === "CHARGE" && x.requestId === response.id,
        );
        if (charge) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (
        !charge ||
        !Number.isFinite(Number(charge.amount)) ||
        Number(charge.amount) >= 0 ||
        Math.abs(Number(charge.amount)) > 0.02
      )
        throw Error("AI billing confirmation unavailable or above ceiling");
      this.ready = true;
      await durable(
        path.join(
          this.root,
          "inference",
          String(requestId ?? response.id).replace(/[^a-zA-Z0-9-]/g, "") +
            ".json",
        ),
        {
          at: Date.now(),
          requestId: response.id,
          model: response.model,
          usage: response.usage,
          costUsd: Math.abs(Number(charge.amount)),
          ledgerId: charge.id,
        },
      );
      return {
        text: response.choices[0].message.content,
        usage: response.usage,
        costUsd: Math.abs(Number(charge.amount)),
        requestId: response.id,
        model: response.model,
      };
    });
  }
}
