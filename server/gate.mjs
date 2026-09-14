// All authority comes from local operator configuration and independently fetched evidence.
import { verifyMarketObservation } from "./market-source.mjs";
export const CHAIN_ID = 4663;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x" + "0".repeat(40);
const ZERO_WORD = "0x" + "0".repeat(64);
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export function validAddress(value) {
  return (
    typeof value === "string" &&
    ADDRESS.test(value) &&
    value.toLowerCase() !== ZERO
  );
}
function hexInt(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error("invalid chain integer");
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n))
    throw new Error("chain integer exceeds safe bounds");
  return n;
}
export function safeRemoteUrl(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)
      ))
  )
    throw new Error(
      "source must use https or loopback http without embedded credentials",
    );
  return u.href;
}
export async function fetchJson(url, options = {}) {
  const response = await fetch(safeRemoteUrl(url), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("source unavailable");
  // Bound response size, including chunked responses.
  const reader = response.body.getReader();
  let text = "",
    length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error("source response too large");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}
export function rpcClient(url) {
  let id = 0;
  return async (method, params = []) => {
    const requestId = ++id;
    const body = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (
      body.error ||
      body.id !== requestId ||
      body.jsonrpc !== "2.0" ||
      !("result" in body)
    )
      throw new Error("invalid rpc response");
    return body.result;
  };
}
export function receiptLinksToken(receipt, token) {
  if (
    validAddress(receipt.contractAddress) &&
    receipt.contractAddress.toLowerCase() === token
  )
    return "direct contract deployment";
  // ABI-aware ERC-20 Transfer(address indexed from,address indexed to,uint256 value).
  // Supports factory/PONS launches only when the launch receipt actually contains a mint
  // emitted by this token. No guessed factory event topics or arbitrary substring matching.
  for (const log of receipt.logs ?? []) {
    if (
      log.removed === true ||
      log.address?.toLowerCase() !== token ||
      !Array.isArray(log.topics) ||
      log.topics.length !== 3
    )
      continue;
    if (
      log.topics[0]?.toLowerCase() !== TRANSFER ||
      log.topics[1]?.toLowerCase() !== ZERO_WORD
    )
      continue;
    const to = log.topics[2];
    if (
      !/^0x0{24}[0-9a-fA-F]{40}$/.test(to ?? "") ||
      !validAddress("0x" + to.slice(-40))
    )
      continue;
    if (/^0x[0-9a-fA-F]{64}$/.test(log.data ?? "") && BigInt(log.data) > 0n)
      return "erc20 mint emitted by configured token";
  }
  throw new Error("launch receipt does not prove configured token");
}
export async function verifyLaunch(
  config,
  { rpc, marketFetch = fetchJson, now = Date.now } = {},
) {
  const reject = (reason, phase = "verification_pending") => ({
    ok: false,
    phase,
    reason,
    sourceStatus: "unavailable",
  });
  if (config?.enabled !== true)
    return reject("operator launch disabled", "prelaunch");
  if (config.chainId !== CHAIN_ID) return reject("operator chain must be 4663");
  if (!validAddress(config.contract))
    return reject("missing or invalid contract address");
  if (!HASH.test(config.launchTx ?? ""))
    return reject("missing or invalid operator launch transaction");
  if (
    !Number.isInteger(config.minConfirmations) ||
    config.minConfirmations < 2 ||
    config.minConfirmations > 100000
  )
    return reject("invalid confirmation requirement");
  try {
    safeRemoteUrl(config.rpcUrl);
    const call = rpc ?? rpcClient(config.rpcUrl);
    if (hexInt(await call("eth_chainId")) !== CHAIN_ID)
      throw new Error("wrong rpc chain");
    const token = config.contract.toLowerCase();
    const receipt = await call("eth_getTransactionReceipt", [config.launchTx]);
    if (
      !receipt ||
      receipt.status !== "0x1" ||
      receipt.transactionHash?.toLowerCase() !== config.launchTx.toLowerCase()
    )
      throw new Error("missing or failed launch receipt");
    if (!HASH.test(receipt.blockHash ?? ""))
      throw new Error("invalid receipt block hash");
    const height = hexInt(receipt.blockNumber);
    const latest = hexInt(await call("eth_blockNumber"));
    const confirmations = latest - height + 1;
    if (height < 1 || confirmations < config.minConfirmations)
      throw new Error("insufficient launch confirmations");
    const block = await call("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (
      !block ||
      block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      hexInt(block.number) !== height
    )
      throw new Error("receipt not in canonical block");
    const stamp = hexInt(block.timestamp) * 1000;
    const currentTime = now();
    if (
      !Number.isSafeInteger(stamp) ||
      stamp <= 0 ||
      stamp > currentTime ||
      !Number.isFinite(new Date(stamp).getTime())
    )
      throw new Error("invalid launch block timestamp");
    const code = await call("eth_getCode", [token, "latest"]);
    if (
      typeof code !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
      /^0x0+$/.test(code)
    )
      throw new Error("configured token has no executable code");
    const proof = receiptLinksToken(receipt, token);
    const source = config.market;
    if (
      source?.operatorVerified !== true ||
      typeof source.sourceId !== "string" ||
      !source.sourceId.trim() ||
      !Number.isInteger(source.maxAgeSeconds) ||
      source.maxAgeSeconds < 1 ||
      source.maxAgeSeconds > 300
    )
      throw new Error("market source not operator verified");
    safeRemoteUrl(source.url);
    const market = await marketFetch(source.url);
    if (source.kind === "dex_reference") {
      if (
        !verifyMarketObservation(market) ||
        market.assetContract.toLowerCase() !==
          source.assetContract?.toLowerCase() ||
        !market.sourceId.startsWith(source.sourceId + ":") ||
        market.liquidity < (source.minLiquidityUsd ?? 10000)
      )
        throw new Error("reference market integrity or identity mismatch");
      const observed = Date.parse(market.observedAt);
      if (
        observed < stamp ||
        observed > currentTime ||
        currentTime - observed > source.maxAgeSeconds * 1000
      )
        throw new Error("stale local market observation");
      return {
        ok: true,
        phase: "live",
        reason: "launch and recorded reference market verified",
        sourceStatus:
          "fresh fetched market snapshot; upstream measurement time unavailable",
        startedAt: new Date(stamp).toISOString(),
        contract: token,
        launchTx: config.launchTx.toLowerCase(),
        blockHash: receipt.blockHash.toLowerCase(),
        confirmations,
        proof,
        market: {
          priceEth: market.priceEth,
          timestamp: market.observedAt,
          sourceId: market.sourceId,
          observation: market,
        },
      };
    }
    if (
      !validAddress(source.assetContract) ||
      market.chainId !== CHAIN_ID ||
      market.contract?.toLowerCase() !== source.assetContract.toLowerCase() ||
      market.quoteAsset !== "ETH" ||
      market.sourceId !== source.sourceId ||
      market.verified !== true
    )
      throw new Error("market source identity mismatch");
    if (
      typeof market.priceEth !== "number" ||
      !Number.isFinite(market.priceEth) ||
      market.priceEth <= 0
    )
      throw new Error("invalid market price");
    if (
      typeof market.timestamp !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(market.timestamp)
    )
      throw new Error("invalid market timestamp");
    const marketTime = Date.parse(market.timestamp);
    if (
      !Number.isFinite(marketTime) ||
      marketTime < stamp ||
      marketTime > currentTime ||
      currentTime - marketTime > source.maxAgeSeconds * 1000
    )
      throw new Error("stale or invalid market timestamp");
    return {
      ok: true,
      phase: "live",
      reason: "operator launch and timestamped market verified",
      sourceStatus: "verified timestamped market",
      startedAt: new Date(stamp).toISOString(),
      contract: token,
      launchTx: config.launchTx.toLowerCase(),
      blockHash: receipt.blockHash.toLowerCase(),
      confirmations,
      proof,
      market: {
        priceEth: market.priceEth,
        timestamp: market.timestamp,
        sourceId: market.sourceId,
      },
    };
  } catch (error) {
    return reject(error.message);
  }
}
