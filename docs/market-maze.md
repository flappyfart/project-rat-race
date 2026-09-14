# market-driven maze and exact-contract observation collector

## scope and status

these are standalone adapters, not production activation. no learner, gate, runtime, frontend, package manifest, wallet, or launch configuration is changed by this implementation. the project token remains eth-paired. a reference stock-token observation is **not rat's price**, its launch, or its pairing.

`server/market-source.mjs` provides `MarketSource`, `normalizeMarketPayload`, and `verifyMarketObservation`. `server/market-maze.mjs` provides `generateMaze`, `verifyMaze`, `canMove`, and `reachable`. topology version: `market-topology-kruskal-v1`; this is separate from the parent's learner/model version, which must change when integrating dynamic topology.

## collector contract

```js
import { MarketSource } from "../server/market-source.mjs";
import { generateMaze, verifyMaze, canMove } from "../server/market-maze.mjs";

const source = new MarketSource({
  root: "/explicit/isolated/observation-root",
  config: {
    assetContract: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
    identityProvenance:
      "operator-approved official PLTR Robinhood Token contract; reference only",
    minLiquidityUsd: 1000,
    maxAgeMs: 120000,
    timeoutMs: 15000,
  },
});
const market = await source.sample(); // network failure throws; no cache substitution
const maze = generateMaze({ seed: 4663, episode: 1, market, start: [0, 0] });
if (!verifyMaze(maze)) throw Error("invalid topology replay");
const allowed = canMove(maze.walls, 0, 0, 0); // boolean, not next coordinates
```

- constructor performs no network calls or filesystem writes. root must be explicitly selected by the caller. use one writer instance per root/asset; concurrent sampling on that instance is rejected. cross-process writer arbitration is the runtime's responsibility.
- source url is fixed to `https://api.dexscreener.com/token-pairs/v1/robinhood/{exact-contract}`. only https fetches to that source are accepted; redirects fail. symbol and name are not identity checks.
- accept exact `baseToken.address`, exact `chainId: robinhood`, native eth zero-address quote, `dexId: uniswap`, and v4 label. native currency is represented by the zero address in uniswap v4. v1 deliberately does **not** accept an arbitrary weth ticker or an unverified wrapped-native address. it does not reinterpret usdg, spy, or other quote prices as eth. no usd-to-eth conversion is used.
- only finite positive price/native and price/usd, finite h24 percentage change, nonnegative h24 usd volume, and positive usd liquidity above the configured threshold qualify. missing numbers are not zero-filled. highest-liquidity eligible pool wins, with lexicographic pool id as the stable tie-breaker. conflicting duplicate eligible pair ids fail closed.
- `assetContract` and its operator approval reference (`identityProvenance`) are mandatory. there is no default contract and no ticker search. an arbitrary explicitly approved reference contract works only if it has an eligible native-eth pool. default minimum liquidity is one usd for schema validity, not an economic liquidity endorsement; operators should explicitly raise it.
- returned fields include `source: 'reference market not RAT price'`, `kind: 'market observation snapshot'`, `sourceId`, `chainId: 4663`, `assetContract`, `quoteAsset: 'ETH'`, `pairAddress`, `priceEth`, `priceUsd`, `priceChange`, `volume`, `liquidity`, and provenance/hash fields.
- `observedAt` is the **local response observation time**. `upstreamTimestamp` is null: this endpoint supplies no market measurement timestamp. pool creation time, http date and fetch time are not substituted. source `priceChange.h24` is preserved as a provider-supplied percentage, not asserted to be an independently computed eth-denominated return.
- `volatility` is explicitly an **absolute h24 price-change proxy**, not realized volatility or a high-frequency return series. the method is carried in every observation. do not describe it as measured realized volatility. a real rolling-volatility estimator requires a separately versioned observation-series implementation.
- no `verified: true` is emitted. exact identity matching, finite-field validation and archived https provenance are not an oracle attestation or independent onchain verification of the reported price. approval provenance is supplied by the trusted operator, not discovered from a token's self-description.

## persistence and restart

accepted observations are stored under `<root>/market-observations/<lowercase-contract>/<archive-sha256>.json`; `latest.json` is an atomic pointer to the content hash. each archive includes the exact accepted response **text**, including whitespace, normalized observation, source url, raw response sha256, and canonical archive sha256. transport compression/wire bytes are not claimed to be preserved. observation hashes use canonical sorted-key json. hashes are integrity checks, not signatures.

`sample()` returns the observation plus `artifactPath`. `loadLatest()` returns the same shape or null if no pointer exists. archive reads verify both hashes and re-normalize the archived raw payload under the current configuration; a freshly rehashed but altered observation is rejected when it does not match that payload. a changed identity approval, corrupt archive, missing pointed-to file, malformed pointer, or local clock regression fails closed. stale observations throw rather than being relabeled fresh. sampling can recover with a new network observation after old history has aged out, without modifying that historical archive. a failed network request never silently falls back to the disk snapshot.

freshness means local observation age only. a provider may return old market values in a newly received response; without an upstream timestamp, measurement staleness and upstream timestamp regression cannot be detected. unchanged prices/payloads are not fabricated changes, and polling never claims new upstream measurement. consumers needing tighter market freshness must obtain a timestamped source rather than infer it from fetch time.

## reproducible topology and replay

`generateMaze({seed, episode, market, start = [0,0]})` requires an integrity-valid normalized observation. seeds are uint32 integers; episodes are nonnegative safe integers; positions are integer cells 0..6. returns `{size: 7, walls, hash, inputs, modelVersion, quantized, entropy, loopOpenPermille}`. `inputs` retains the complete normalized market observation, seed, episode and starting cell; a machine-local archive path is deliberately excluded.

1. quantize price to nano-eth, h24 percent change and its absolute proxy to basis points, volume and liquidity to whole usd. clamp price to one million eth, percentage/proxy magnitude to 10,000, volume/liquidity to one trillion usd before quantization. original values remain in inputs. rounding uses `Math.round`.
2. sha256 of topology version, seed, episode, exact source/pool identity and integer market values ranks grid edges deterministically. neither local fetch time nor unrelated response fields seed the walls; price-only, change-only, volume-only and liquidity-only changes can actually alter topology.
3. randomized kruskal opens a spanning tree across **all 49 cells**. additional loop openings use deterministic integer hashes and a threshold driven by the absolute-change proxy and volume/liquidity turnover. increasing stress reduces that threshold, while the spanning tree always stays open.
4. close remaining edges as unit wall segments and include all four boundaries. every cell stays connected to exit `[6,6]`, including the current rat position. the spanning tree is not a prescribed action route: it does not move the rat, choose actions, force an escape, or supply an escape timer.
5. hash all snapshot contents. `verifyMaze(snapshot)` regenerates the full topology from inputs and compares the canonical result; merely rehashing changed walls does not pass.

`canMove(walls,x,z,action)` returns a boolean with learner actions `0:+x`, `1:+z`, `2:-x`, `3:-z`; it supports the existing learner's long or reversed axis-aligned segments and boundary rules. the caller applies a one-cell move only when allowed. `reachable(walls,start,exit=[6,6])` uses breadth-first traversal without changing state.

parent integration requirements:

- call the collector only behind the existing authorized gate; adapter construction is inert but `sample()` intentionally is not launch-aware.
- validate source archive/freshness at the live boundary before supplying the normalized observation. `verifyMarketObservation` checks schema and hash integrity; it cannot authenticate a caller who fabricates an entirely new self-consistent payload. never accept arbitrary client-supplied normalized objects as live feeds.
- freeze a snapshot for each episode, or record explicit safe checkpoint changes with step index and actual current cell. topology generation itself never resets the agent. keep actions, positions, topology snapshot/hash and observation hash in checkpoint/escape proofs. replay each action using its active snapshot. do not validate a route against whichever walls are current at the end.
- `generateMaze` deliberately does not use the current wall clock: old valid snapshots must remain replayable. live age checks belong to the collector/runtime boundary, not historical route verification.
- update learner model/checkpoint version; migrate/reject old static-wall checkpoints explicitly. hold the learner rather than substituting market values on unavailable feed.
- topology is discrete: below-quantization changes need not change walls; distinct market inputs can also happen to yield equal walls. the complete snapshot hash still binds its exact observation. no promise that every price tick creates a different maze.

## real read-only exercise

executed with the parent-approved official pltr contract and a 1,000 usd minimum eligible liquidity. no broad benchmark contract was independently verified from existing project search; the response's spy token name/address alone was not promoted to an approved contract. the web-search service was unavailable, but direct dexscreener https access succeeded. no invented address, ticker-only match, wallet operation, dns change or publication was used.

local observed time: `2026-09-14T03:06:18.450Z` (not upstream measurement time).

- selected pool: `0x71c75f22871e483dfa16970efb42564462b1878112acb0d09e3f318bcd59c353`
- eth price: `0.06584`; usd price: `163.36`
- provider h24 change: `-0.35%`; h24 usd volume: `717.81`; usd liquidity: `24866.39`
- raw sha256: `8d7bc8d91214f5ffa84ca84c9e480ab106299e2357a1cc378bbb8d6995f7e3a2`
- observation hash: `86104494ecb1c6477bf7d98f0c7a8b1fb87c0ce34192cddcd24c35b7b29aeda0`
- seed 4663 / episode 1 topology hash: `3e75a27ef787b1fb58e16f056eb805575b4a9afc8d793cebcffe0fb119ce5bfd`
- real execution: 18 wall segments, `verifyMaze: true`, exit reachable, restarted source returned matching observation hash.

accepted raw payload and normalized evidence artifact (temporary isolated root, not production state):

```
/var/folders/l_/2c1d1v1n4lg9ml_lx40w41gw0000gn/T/rat-rhc-live-market-xCc0CI/market-observations/0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a/d737269e6948f8c77c19c1e1070249739cfd543e2fb8afec8a53be82b0d7559f.json
```

this particular direct-eth pool is modestly traded; the larger pltr/usdg and pltr/spy pools are intentionally excluded rather than converting their native prices incorrectly. this source choice is visible reference metadata, not a pltr-paired project rebrand. temp artifacts can be cleaned by the operating system; retain the file in an explicitly approved evidence store if permanent custody is needed.

## tests

```sh
node --test server/market-*.test.mjs
```

offline fixtures are explicitly synthetic. tests cover deterministic reconstruction and actual topology sensitivity, reachability from all 49 starts across 40 seeds, learner movement compatibility, observation/schema integrity, corrupt and rehashed archive rejection, exact base/chain/quote selection, missing fields, stable selection, duplicate ids, stale/restart/clock handling, http failure and no fallback. the live exercise above is separate from the offline tests and does not supply fake expected api results.
