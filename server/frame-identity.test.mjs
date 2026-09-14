import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { InternetObserver } from "./internet.mjs";
import { createServer } from "./http.mjs";
function pixel(v) {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(v);
  return PNG.sync.write(p);
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "rat-frame-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new InternetObserver({ root });
}
async function publish(o, v) {
  const bytes = pixel(v);
  await o.publishFrame(bytes, {
    ...o.status(),
    phase: "observing",
    url: "https://en.wikipedia.org/wiki/Memory",
    title: "explicit offline unit fixture",
    lastObservedAt: new Date(v * 1000).toISOString(),
  });
  return { bytes, id: o.status().frameId, url: o.status().screenshotUrl };
}
test("recorded frames have distinct URLs and old identifiers retain their original bytes", async (t) => {
  const o = await setup(t),
    a = await publish(o, 20),
    b = await publish(o, 30);
  assert.notEqual(a.url, b.url);
  assert.deepEqual(await o.frame(a.id), a.bytes);
  assert.deepEqual(await o.frame(b.id), b.bytes);
  assert.equal(await o.frame("f".repeat(64)), null);
  assert.equal(await o.frame("../../wallet"), null);
});
test("expired frame identifiers never fall back to a newer image", async (t) => {
  const o = await setup(t),
    first = await publish(o, 10);
  for (let i = 11; i < 20; i++) await publish(o, i);
  assert.equal(o.frames.size, 8);
  assert.equal(await o.frame(first.id), null);
  assert(await o.frame(o.status().frameId));
});
test("frame HTTP endpoint binds requested image identity and remains launch gated", async (t) => {
  const o = await setup(t),
    a = await publish(o, 20),
    b = await publish(o, 30),
    runtime = { gate: { ok: true } };
  const server = createServer(runtime, o.root, { internet: o });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const result = await fetch(base + a.url);
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), a.bytes);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(
    (await fetch(base + "/api/browser-frame?frame=" + "f".repeat(64))).status,
    404,
  );
  assert.equal(
    (await fetch(base + "/api/browser-frame?frame=../../wallet")).status,
    400,
  );
  runtime.gate.ok = false;
  assert.equal((await fetch(base + b.url)).status, 404);
});
