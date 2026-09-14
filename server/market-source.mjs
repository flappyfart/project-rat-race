import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";

export const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
export const MARKET_SCHEMA = "rhc-market-observation-v1";
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const PAIR = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX = /^[0-9a-f]{64}$/;
const API = "https://api.dexscreener.com/token-pairs/v1/robinhood/";
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const digest = (value) => sha256(canonical(value));
function options(config) {
  if (
    !config ||
    !ADDRESS.test(config.assetContract) ||
    config.assetContract.toLowerCase() === NATIVE_ETH ||
    typeof config.identityProvenance !== "string" ||
    !config.identityProvenance.trim()
  )
    throw Error(
      "explicit reference asset contract and identityProvenance required",
    );
  if (config.chainId !== undefined && config.chainId !== 4663)
    throw Error("reference chain must be 4663");
  const maxAgeMs = config.maxAgeMs ?? 120000,
    minLiquidityUsd = config.minLiquidityUsd ?? 1,
    timeoutMs = config.timeoutMs ?? 15000;
  if (
    ![maxAgeMs, timeoutMs].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= 2147483647,
    ) ||
    !Number.isFinite(minLiquidityUsd) ||
    minLiquidityUsd <= 0
  )
    throw Error("invalid market source limits");
  return {
    assetContract: config.assetContract.toLowerCase(),
    identityProvenance: config.identityProvenance,
    chainId: 4663,
    maxAgeMs,
    minLiquidityUsd,
    timeoutMs,
  };
}
function number(value, min, max = 1e15) {
  if (
    typeof value !== "number" &&
    !(
      typeof value === "string" &&
      /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
    )
  )
    throw Error("invalid numeric market field");
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw Error("invalid numeric market field");
  return n;
}
function time(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw Error("invalid observation time");
  return value;
}
/** Only native ETH (zero-address currency) in Uniswap v4 is supported in v1.
 * A WETH ticker is never sufficient identity. No USD/non-ETH conversion is guessed.
 */
export function normalizeMarketPayload(rawPayload, { config, observedAt }) {
  const c = options(config);
  time(observedAt);
  if (typeof rawPayload !== "string" || Buffer.byteLength(rawPayload) > 2000000)
    throw Error("invalid market payload size");
  const payload = JSON.parse(rawPayload);
  if (!Array.isArray(payload)) throw Error("expected token-pairs array");
  const eligible = [];
  for (const p of payload) {
    try {
      if (
        p?.chainId !== "robinhood" ||
        p.baseToken?.address?.toLowerCase() !== c.assetContract ||
        p.quoteToken?.address?.toLowerCase() !== NATIVE_ETH ||
        p.dexId !== "uniswap" ||
        !Array.isArray(p.labels) ||
        !p.labels.includes("v4") ||
        !PAIR.test(p.pairAddress)
      )
        continue;
      const priceEth = number(p.priceNative, Number.MIN_VALUE, 1e9),
        priceUsd = number(p.priceUsd, Number.MIN_VALUE),
        priceChange = number(p.priceChange?.h24, -100, 1e9),
        volume = number(p.volume?.h24, 0),
        liquidity = number(p.liquidity?.usd, c.minLiquidityUsd);
      eligible.push({
        pairAddress: p.pairAddress.toLowerCase(),
        priceEth,
        priceUsd,
        priceChange,
        volume,
        liquidity,
      });
    } catch {
      /* malformed candidates do not outrank valid exact-identity pools */
    }
  }
  eligible.sort(
    (a, b) =>
      b.liquidity - a.liquidity ||
      (a.pairAddress < b.pairAddress
        ? -1
        : a.pairAddress > b.pairAddress
          ? 1
          : 0),
  );
  if (!eligible.length)
    throw Error(
      "no eligible exact-contract native ETH pool with finite price/change/volume/liquidity",
    );
  // Duplicate conflicting records would make selection depend on provider array order.
  if (new Set(eligible.map((p) => p.pairAddress)).size !== eligible.length)
    throw Error("duplicate eligible pair identity");
  const selected = eligible[0];
  const observation = {
    schemaVersion: MARKET_SCHEMA,
    kind: "market observation snapshot",
    source: "reference market not RAT price",
    sourceId: `dexscreener:robinhood:${c.assetContract}:${selected.pairAddress}`,
    sourceUrl: API + c.assetContract,
    chainId: 4663,
    assetContract: c.assetContract,
    identityProvenance: c.identityProvenance,
    identityValidation:
      "exact configured base contract + native ETH Uniswap v4 quote + finite fields; not oracle attestation",
    quoteAsset: "ETH",
    quoteContract: NATIVE_ETH,
    conversion: {
      method: "direct native ETH quote; priceNative is ETH",
      dexId: "uniswap",
      protocol: "v4",
    },
    observedAt,
    upstreamTimestamp: null,
    upstreamTimeStatus:
      "not supplied by token-pairs endpoint; fetch time is not market measurement time",
    ...selected,
    priceChangeWindow: "h24",
    volumeWindow: "h24",
    volumeUnit: "USD",
    liquidityUnit: "USD",
    volatility: Math.abs(selected.priceChange),
    volatilityMethod:
      "absolute h24 price change proxy, not realized volatility",
    rawSha256: sha256(rawPayload),
  };
  return { ...observation, observationHash: digest(observation) };
}
/** Integrity/schema check, not an oracle or external authenticity proof. Archive
 * verification additionally re-normalizes the exact raw source response.
 */
export function verifyMarketObservation(m) {
  try {
    const { observationHash, artifactPath, ...body } = m;
    if (
      !HEX.test(observationHash) ||
      digest(body) !== observationHash ||
      !HEX.test(m.rawSha256)
    )
      return false;
    const reconstructed = normalizeMarketPayload(
      JSON.stringify([
        {
          chainId: "robinhood",
          dexId: "uniswap",
          labels: ["v4"],
          pairAddress: m.pairAddress,
          baseToken: { address: m.assetContract },
          quoteToken: { address: m.quoteContract },
          priceNative: m.priceEth,
          priceUsd: m.priceUsd,
          priceChange: { h24: m.priceChange },
          volume: { h24: m.volume },
          liquidity: { usd: m.liquidity },
        },
      ]),
      {
        config: {
          assetContract: m.assetContract,
          identityProvenance: m.identityProvenance,
        },
        observedAt: m.observedAt,
      },
    );
    const {
      rawSha256: ignored,
      observationHash: ignoredHash,
      ...expected
    } = reconstructed;
    const { rawSha256: ignoredRaw, ...actual } = body;
    return canonical(expected) === canonical(actual);
  } catch {
    return false;
  }
}
async function atomic(path, text) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export class MarketSource {
  constructor({ root, config, fetch = globalThis.fetch, now = Date.now }) {
    if (
      typeof root !== "string" ||
      !root ||
      typeof fetch !== "function" ||
      typeof now !== "function"
    )
      throw Error("root, fetch and clock required");
    this.root = resolve(root);
    this.config = Object.freeze(options(config));
    this.fetch = fetch;
    this.now = now;
    this.directory = join(
      this.root,
      "market-observations",
      this.config.assetContract,
    );
    this.latestPath = join(this.directory, "latest.json");
    this.busy = false;
  }
  async readLatest({ requireFresh = true } = {}) {
    let pointer;
    try {
      pointer = JSON.parse(await readFile(this.latestPath, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw Error("market archive integrity: invalid latest pointer", {
        cause: e,
      });
    }
    try {
      if (!HEX.test(pointer.sha256)) throw Error("invalid archive hash");
      const artifactPath = join(this.directory, pointer.sha256 + ".json");
      const record = JSON.parse(await readFile(artifactPath, "utf8"));
      const { sha256: hash, ...body } = record;
      if (
        hash !== pointer.sha256 ||
        digest(body) !== hash ||
        record.schemaVersion !== MARKET_SCHEMA ||
        record.rawSha256 !== sha256(record.rawPayload)
      )
        throw Error("hash mismatch");
      const expected = normalizeMarketPayload(record.rawPayload, {
        config: this.config,
        observedAt: record.observation.observedAt,
      });
      if (
        canonical(expected) !== canonical(record.observation) ||
        record.sourceUrl !== expected.sourceUrl
      )
        throw Error("normalization mismatch");
      const age = this.now() - Date.parse(expected.observedAt);
      if (!Number.isFinite(age) || age < 0) throw Error("clock regression");
      if (requireFresh && age > this.config.maxAgeMs)
        throw Error("stale local market observation");
      return { ...expected, artifactPath };
    } catch (e) {
      throw Error("market archive integrity: " + e.message, { cause: e });
    }
  }
  async loadLatest() {
    return this.readLatest();
  }
  async sample() {
    if (this.busy) throw Error("market sample already in progress");
    this.busy = true;
    try {
      // Stale history is useful only for monotonicity, never as a fresh fallback.
      const prior = await this.readLatest({ requireFresh: false });
      const url = API + this.config.assetContract;
      const response = await this.fetch(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url)
      )
        throw Error("market feed HTTP/source failure " + response.status);
      const rawPayload = await response.text();
      const observedAt = new Date(this.now()).toISOString();
      if (prior && Date.parse(observedAt) < Date.parse(prior.observedAt))
        throw Error("market observation clock regression");
      const observation = normalizeMarketPayload(rawPayload, {
        config: this.config,
        observedAt,
      });
      const body = {
        schemaVersion: MARKET_SCHEMA,
        sourceUrl: url,
        rawPayload,
        rawSha256: observation.rawSha256,
        observation,
      };
      const hash = digest(body),
        artifactPath = join(this.directory, hash + ".json");
      await mkdir(this.directory, { recursive: true });
      await atomic(
        artifactPath,
        JSON.stringify({ ...body, sha256: hash }, null, 2) + "\n",
      );
      await atomic(this.latestPath, JSON.stringify({ sha256: hash }) + "\n");
      return { ...observation, artifactPath };
    } finally {
      this.busy = false;
    }
  }
}
