// Operator-configured RPC providers only. No private signing material enters this module.
const READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getBalance",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getTransactionCount",
  "eth_getLogs",
]);
const LAUNCH_READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getCode",
]);
export const RH_RPC = "https://robinhood-rpc.publicnode.com";
export const RH_RPC_FALLBACK = "https://rpc.mainnet.chain.robinhood.com";
export const LAUNCH_CACHE_MS = 30000;
class RpcFailure extends Error {
  constructor(message, { retryable = false, retryMs = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryMs = retryMs;
  }
}
function endpoint(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw Error("RPC requires configured HTTPS without embedded credentials");
  return u.href;
}
export class RpcPool {
  constructor({
    urls,
    chainId,
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = 8000,
  } = {}) {
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.length > 3 ||
      !Number.isSafeInteger(chainId) ||
      chainId < 1
    )
      throw Error("invalid RPC configuration");
    this.chainId = chainId;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.preferred = 0;
    this.pending = new Map();
    this.launchCache = new Map();
    this.launchRefresh = new Map();
    this.providers = [...new Set(urls.map(endpoint))].map((url) => ({
      url,
      host: new URL(url).hostname,
      failures: 0,
      retryAt: 0,
      verifiedUntil: 0,
      lastError: null,
    }));
  }
  async post(provider, method, params) {
    const id = ++this.id;
    let response;
    try {
      response = await this.fetch(provider.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RpcFailure("network unavailable or request timed out", {
        retryable: true,
      });
    }
    if (!response.ok) {
      const header = response.headers.get("retry-after");
      let retryMs = 0;
      if (header) {
        retryMs = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Math.max(0, Date.parse(header) - this.now());
        if (!Number.isFinite(retryMs)) retryMs = 0;
      }
      await response.body?.cancel().catch(() => {});
      throw new RpcFailure("HTTP " + response.status, {
        retryable: true,
        retryMs,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RpcFailure("empty response", { retryable: true });
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2000000)
          throw new RpcFailure("response too large", { retryable: true });
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (e) {
      if (e instanceof RpcFailure) throw e;
      throw new RpcFailure("response interrupted", { retryable: true });
    } finally {
      await reader.cancel().catch(() => {});
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcFailure("non JSON response", { retryable: true });
    }
    if (body?.jsonrpc !== "2.0" || body.id !== id)
      throw new RpcFailure("invalid response identity", { retryable: true });
    if (body.error)
      throw new RpcFailure("RPC error " + String(body.error.code ?? "unknown"));
    if (!Object.hasOwn(body, "result"))
      throw new RpcFailure("result missing", { retryable: true });
    return body.result;
  }
  fail(provider, error) {
    provider.failures++;
    provider.verifiedUntil = 0;
    provider.lastError = error.message;
    provider.retryAt =
      this.now() +
      Math.max(
        Math.min(120000, 10000 * 2 ** Math.min(provider.failures - 1, 4)),
        error.retryMs || 0,
      );
  }
  async ensureChain(provider) {
    if (provider.verifiedUntil > this.now()) return;
    const result = await this.post(provider, "eth_chainId", []);
    if (
      typeof result !== "string" ||
      !/^0x[0-9a-f]+$/i.test(result) ||
      BigInt(result) !== BigInt(this.chainId)
    )
      throw new RpcFailure("chain identity mismatch", {
        retryable: true,
        retryMs: 120000,
      });
    provider.verifiedUntil = this.now() + 30000;
  }
  async perform(method, params) {
    const write = method === "eth_sendRawTransaction";
    let last;
    for (let offset = 0; offset < this.providers.length; offset++) {
      const index = (this.preferred + offset) % this.providers.length,
        provider = this.providers[index];
      if (provider.retryAt > this.now()) continue;
      try {
        await this.ensureChain(provider);
      } catch (error) {
        this.fail(provider, error);
        last = error;
        continue;
      }
      try {
        // Never automatically retry an attempted broadcast. Its persisted transaction journal owns reconciliation.
        const result =
          method === "eth_chainId"
            ? "0x" + this.chainId.toString(16)
            : await this.post(provider, method, params);
        provider.failures = 0;
        provider.retryAt = 0;
        provider.lastError = null;
        this.preferred = index;
        return result;
      } catch (error) {
        last = error;
        if (error.retryable) this.fail(provider, error);
        if (write || !error.retryable)
          throw new Error(
            "chain " +
              this.chainId +
              " RPC " +
              provider.host +
              ": " +
              error.message,
          );
      }
    }
    const retryAt = Math.min(...this.providers.map((p) => p.retryAt));
    const delay = Math.max(0, Math.ceil((retryAt - this.now()) / 1000));
    throw Error(
      "chain " +
        this.chainId +
        " RPC unavailable" +
        (last ? ": " + last.message : "; providers cooling down") +
        (delay ? "; retry in " + delay + " seconds" : ""),
    );
  }
  async call(method, params = []) {
    if (!READS.has(method) && method !== "eth_sendRawTransaction")
      throw Error("RPC method not permitted");
    if (!Array.isArray(params)) throw Error("invalid RPC parameters");
    if (method === "eth_sendRawTransaction")
      return this.perform(method, params);
    const key = JSON.stringify([method, params]);
    if (this.pending.has(key))
      return structuredClone(await this.pending.get(key));
    const task = this.perform(method, params);
    this.pending.set(key, task);
    try {
      return structuredClone(await task);
    } finally {
      this.pending.delete(key);
    }
  }
  async launchRead(method, params = []) {
    if (!LAUNCH_READS.has(method))
      throw Error("launch cache is not available for financial RPC methods");
    const key = JSON.stringify([method, params]),
      cached = this.launchCache.get(key);
    const refresh = () => {
      if (this.launchRefresh.has(key)) return this.launchRefresh.get(key);
      const task = this.call(method, params)
        .then((result) => {
          if (result !== null)
            this.launchCache.set(key, {
              result: structuredClone(result),
              until: this.now() + LAUNCH_CACHE_MS,
            });
          else this.launchCache.delete(key);
          return result;
        })
        .finally(() => this.launchRefresh.delete(key));
      this.launchRefresh.set(key, task);
      return task;
    };
    if (cached && cached.until > this.now()) {
      if (cached.until - this.now() <= 10000) void refresh().catch(() => {});
      return structuredClone(cached.result);
    }
    this.launchCache.delete(key);
    return structuredClone(await refresh());
  }
  launchFreshUntil() {
    if (!this.launchCache.size) return 0;
    return Math.min(...[...this.launchCache.values()].map((x) => x.until));
  }
  status() {
    return {
      chainId: this.chainId,
      activeProvider: this.providers[this.preferred].host,
      providers: this.providers.map((p) => ({
        host: p.host,
        coolingDown: p.retryAt > this.now(),
        retryAt: p.retryAt || null,
        lastError: p.lastError,
      })),
      launchVerificationCacheMs: LAUNCH_CACHE_MS,
    };
  }
}
