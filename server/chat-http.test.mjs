import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./http.mjs";
import { onRequest } from "../functions/[[path]].js";
const SECRET = "a".repeat(64),
  CLIENT = "b".repeat(64),
  payload = {
    requestId: "42345678-1234-4234-8234-123456789abc",
    message: "hello",
    history: [],
  };
async function server(t) {
  let calls = 0;
  const chat = {
      status: async () => ({ available: true, readOnly: true }),
      respond: async (body, identity) => {
        calls++;
        assert.deepEqual(body, payload);
        assert.equal(identity.clientKey, CLIENT);
        return { reply: "hello", mode: "read_only" };
      },
    },
    s = createServer({ status: () => ({ phase: "live" }) }, ".", {
      chat,
      chatGatewaySecret: SECRET,
    });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(r);
      }),
  );
  return { url: "http://127.0.0.1:" + s.address().port, calls: () => calls };
}
test("chat post requires gateway auth and client identity; other posts remain blocked", async (t) => {
  const s = await server(t);
  for (const headers of [
    {},
    { "x-rat-chat-gateway": "f".repeat(64) },
    { "x-rat-chat-gateway": "é".repeat(64) },
    { "x-rat-chat-gateway": SECRET, "x-rat-chat-client": "spoof" },
  ]) {
    const r = await fetch(s.url + "/api/rat-chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 403);
  }
  assert.equal(s.calls(), 0);
  assert.equal(
    (await fetch(s.url + "/api/status", { method: "POST" })).status,
    405,
  );
});
test("bounded authenticated chat reaches the service without adding cors or exposing the secret", async (t) => {
  const s = await server(t),
    headers = {
      "content-type": "application/json",
      "x-rat-chat-gateway": SECRET,
      "x-rat-chat-client": CLIENT,
    };
  let r = await fetch(s.url + "/api/rat-chat", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal((await r.json()).reply, "hello");
  assert.equal(s.calls(), 1);
  r = await fetch(s.url + "/api/rat-chat", {
    method: "POST",
    headers,
    body: "x".repeat(19000),
  });
  assert.equal(r.status, 413);
  assert.equal(s.calls(), 1);
  r = await fetch(s.url + "/api/rat-chat");
  assert.equal((await r.json()).readOnly, true);
});
function request(body = payload, headers = {}) {
  return new Request("https://projectratrace.org/api/rat-chat", {
    method: "POST",
    headers: {
      origin: "https://projectratrace.org",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.4",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test("website proxy refuses cross origin, missing secrets, invalid content type and oversized bodies before fetch", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw Error("must not fetch");
  };
  try {
    for (const [req, env, status] of [
      [
        request({}, { origin: "https://attacker.invalid" }),
        { RAT_CHAT_GATEWAY_SECRET: SECRET },
        403,
      ],
      [request(), {}, 503],
      [
        request({}, { "content-type": "text/plain" }),
        { RAT_CHAT_GATEWAY_SECRET: SECRET },
        415,
      ],
      [
        request({ message: "x".repeat(19000) }),
        { RAT_CHAT_GATEWAY_SECRET: SECRET },
        413,
      ],
    ])
      assert.equal((await onRequest({ request: req, env })).status, status);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("website proxy hashes the actual connecting ip and replaces client supplied auth headers", async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, ...options };
    return Response.json(
      { reply: "hello", mode: "read_only" },
      { headers: { "set-cookie": "private=1" } },
    );
  };
  try {
    const r = await onRequest({
      request: request(payload, {
        "x-rat-chat-gateway": "forged",
        "x-rat-chat-client": "forged",
      }),
      env: { RAT_CHAT_GATEWAY_SECRET: SECRET },
    });
    assert.equal(r.status, 200);
    assert.equal(sent.headers["x-rat-chat-gateway"], SECRET);
    assert.match(sent.headers["x-rat-chat-client"], /^[a-f0-9]{64}$/);
    assert.notEqual(sent.headers["x-rat-chat-client"], "203.0.113.4");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("x-rat-chat-gateway"), null);
    assert.equal(sent.url, "https://api.projectratrace.org/api/rat-chat");
  } finally {
    globalThis.fetch = original;
  }
});
