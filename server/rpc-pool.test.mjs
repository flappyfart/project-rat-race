import test from "node:test";
import assert from "node:assert/strict";
import { RpcPool, LAUNCH_CACHE_MS } from "./rpc-pool.mjs";
import { Runtime } from "./runtime.mjs";
const one = "https://primary.example.test/",
  two = "https://secondary.example.test/";
const answer = (body, result) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
    headers: { "content-type": "application/json" },
  });
function fixture(handler) {
  let now = 0;
  const calls = [];
  const pool = new RpcPool({
    urls: [one, two],
    chainId: 4663,
    now: () => now,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, ...body });
      return handler(url, body, calls);
    },
  });
  return {
    pool,
    calls,
    time: (x) => {
      now = x;
    },
  };
}
test("wrong-chain provider cannot supply values; supported fallback is independently checked", async () => {
  const f = fixture((url, b) =>
    answer(
      b,
      b.method === "eth_chainId" ? (url === one ? "0x1" : "0x1237") : "0xaa",
    ),
  );
  assert.equal(
    await f.pool.call("eth_getBalance", ["0xabc", "latest"]),
    "0xaa",
  );
  assert.equal(
    f.calls.filter((x) => x.url === one && x.method === "eth_getBalance")
      .length,
    0,
  );
  assert.equal(f.pool.status().activeProvider, "secondary.example.test");
});
test("HTTP challenge cools the failed provider rather than repeatedly hammering it", async () => {
  const f = fixture((url, b) =>
    url === one
      ? new Response("<html>challenge</html>", { status: 403 })
      : answer(b, b.method === "eth_chainId" ? "0x1237" : "0xaa"),
  );
  await f.pool.call("eth_getBalance", ["0xa", "latest"]);
  await f.pool.call("eth_getBalance", ["0xb", "latest"]);
  assert.equal(f.calls.filter((x) => x.url === one).length, 1);
  assert.equal(f.pool.status().providers[0].coolingDown, true);
});
test("provider Retry-After is respected and errors never expose URL credentials", async () => {
  const f = fixture(
    () =>
      new Response("limit", { status: 429, headers: { "retry-after": "60" } }),
  );
  await assert.rejects(f.pool.call("eth_blockNumber"), /HTTP 429/);
  const n = f.calls.length;
  f.time(59000);
  await assert.rejects(f.pool.call("eth_blockNumber"), /cooling down/);
  assert.equal(f.calls.length, n);
  f.time(60000);
  await assert.rejects(f.pool.call("eth_blockNumber"), /HTTP 429/);
  assert(f.calls.length > n);
  assert.throws(
    () =>
      new RpcPool({
        urls: ["https://name:password@example.test"],
        chainId: 4663,
      }),
    /without embedded credentials/,
  );
});
test("ambiguous transaction broadcast is attempted once, not automatically sent to another provider", async () => {
  const f = fixture((_url, b) => {
    if (b.method === "eth_chainId") return answer(b, "0x1237");
    if (b.method === "eth_sendRawTransaction")
      throw Error("timeout after acceptance");
    return answer(b, "0x1");
  });
  await assert.rejects(
    f.pool.call("eth_sendRawTransaction", ["0x1234"]),
    /unavailable|timed out/,
  );
  assert.equal(
    f.calls.filter((x) => x.method === "eth_sendRawTransaction").length,
    1,
  );
  assert.equal(f.calls.filter((x) => x.url === two).length, 0);
});
test("JSON RPC execution errors are not hidden by provider shopping", async () => {
  const f = fixture((_url, b) =>
    b.method === "eth_chainId"
      ? answer(b, "0x1237")
      : new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: b.id,
            error: { code: -32000, message: "fixture revert" },
          }),
        ),
  );
  await assert.rejects(
    f.pool.call("eth_estimateGas", [{}]),
    /RPC error -32000/,
  );
  assert.equal(f.calls.filter((x) => x.url === two).length, 0);
});
test("same read in flight is shared, while later financial balance reads remain fresh", async () => {
  let release;
  const wait = new Promise((r) => (release = r));
  const f = fixture(async (_url, b) => {
    if (b.method === "eth_chainId") return answer(b, "0x1237");
    await wait;
    return answer(b, "0xaa");
  });
  const a = f.pool.call("eth_getBalance", ["0xa", "latest"]),
    b = f.pool.call("eth_getBalance", ["0xa", "latest"]);
  release();
  assert.deepEqual(await Promise.all([a, b]), ["0xaa", "0xaa"]);
  assert.equal(f.calls.filter((x) => x.method === "eth_getBalance").length, 1);
  await f.pool.call("eth_getBalance", ["0xa", "latest"]);
  assert.equal(f.calls.filter((x) => x.method === "eth_getBalance").length, 2);
  await assert.rejects(
    f.pool.launchRead("eth_getBalance", ["0xa", "latest"]),
    /not available for financial/,
  );
});
test("bounded launch cache returns copies and reduces repeated immutable proof reads", async () => {
  const f = fixture((_url, b) =>
    answer(
      b,
      b.method === "eth_chainId"
        ? "0x1237"
        : { status: "0x1", blockHash: "fixture" },
    ),
  );
  const first = await f.pool.launchRead("eth_getTransactionReceipt", [
    "0xfixture",
  ]);
  first.status = "mutated";
  const second = await f.pool.launchRead("eth_getTransactionReceipt", [
    "0xfixture",
  ]);
  assert.equal(second.status, "0x1");
  assert.equal(
    f.calls.filter((x) => x.method === "eth_getTransactionReceipt").length,
    1,
  );
  assert.equal(f.pool.launchFreshUntil(), LAUNCH_CACHE_MS);
});
test("failed refresh cannot extend verification validity or return expired evidence", async () => {
  let fail = false;
  const f = fixture((_url, b) =>
    fail
      ? new Response("outage", { status: 503 })
      : answer(b, b.method === "eth_chainId" ? "0x1237" : "0x123"),
  );
  await f.pool.launchRead("eth_blockNumber");
  fail = true;
  f.time(25000);
  assert.equal(await f.pool.launchRead("eth_blockNumber"), "0x123");
  await new Promise((r) => setImmediate(r));
  assert.equal(f.pool.launchFreshUntil(), 30000);
  f.time(30000);
  await assert.rejects(f.pool.launchRead("eth_blockNumber"), /unavailable/);
  assert.equal(f.pool.launchFreshUntil(), 0);
});
test("a successful proactive refresh renews evidence before the old deadline", async () => {
  let head = "0x123";
  const f = fixture((_url, b) =>
    answer(b, b.method === "eth_chainId" ? "0x1237" : head),
  );
  await f.pool.launchRead("eth_blockNumber");
  head = "0x124";
  f.time(25000);
  assert.equal(await f.pool.launchRead("eth_blockNumber"), "0x123");
  await new Promise((r) => setImmediate(r));
  assert.equal(await f.pool.launchRead("eth_blockNumber"), "0x124");
  assert.equal(f.pool.launchFreshUntil(), 55000);
});
test("invalid response identity is rejected and never treated as blockchain evidence", async () => {
  const f = fixture(
    (_url, b) =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: b.id + 1, result: "0x1237" }),
      ),
  );
  await assert.rejects(
    f.pool.call("eth_blockNumber"),
    /invalid response identity/,
  );
});
test("expired runtime verification denies authorization immediately even between ticks", () => {
  const r = new Runtime({
    configPath: "/explicit-unit-fixture",
    checkpointPath: "/explicit-unit-fixture",
  });
  r.gate = {
    ok: true,
    phase: "live",
    reason: "verified",
    verificationExpiresAt: Date.now() - 1,
  };
  assert.equal(r.isAuthorized(), false);
  assert.equal(r.status().phase, "verification_pending");
  assert.match(r.status().reason, /refresh pending/);
  r.gate = { ok: true, verificationExpiresAt: Date.now() + 10000 };
  assert.equal(r.isAuthorized(), true);
  r.gate.ok = false;
  assert.equal(r.isAuthorized(), false);
});
