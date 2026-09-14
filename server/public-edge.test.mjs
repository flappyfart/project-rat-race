import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/[[path]].js";
test("public edge is read only and forwards no browser credentials", async () => {
  const old = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, options) => {
    observed = { url: String(url), options };
    return new Response('{"fixture":true}', {
      headers: {
        "content-type": "application/json",
        "set-cookie": "must-not-leave=1",
      },
    });
  };
  try {
    let r = await onRequest({
      env: { PUBLIC_API_ORIGIN: "https://api.projectratrace.org" },
      request: new Request("https://projectratrace.org/api/status", {
        headers: { cookie: "private=1", authorization: "private" },
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(observed.url, "https://api.projectratrace.org/api/status");
    assert.equal(observed.options.headers.cookie, undefined);
    assert.equal(observed.options.headers.authorization, undefined);
    assert.equal(r.headers.get("set-cookie"), null);
    r = await onRequest({
      env: { PUBLIC_API_ORIGIN: "https://api.projectratrace.org" },
      request: new Request("https://projectratrace.org/api/status", {
        method: "POST",
      }),
    });
    assert.equal(r.status, 405);
    r = await onRequest({
      env: { PUBLIC_API_ORIGIN: "https://api.projectratrace.org" },
      request: new Request("https://projectratrace.org/api/private"),
    });
    assert.equal(r.status, 404);
  } finally {
    globalThis.fetch = old;
  }
});
test("edge outage returns unavailable, not fabricated experiment state", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("offline");
  };
  try {
    const r = await onRequest({
      env: { PUBLIC_API_ORIGIN: "https://api.projectratrace.org" },
      request: new Request("https://projectratrace.org/api/status"),
    });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /unavailable/);
  } finally {
    globalThis.fetch = old;
  }
});
