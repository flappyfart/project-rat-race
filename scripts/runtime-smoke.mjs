import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { Runtime, readConfig } from "../server/runtime.mjs";
import { createServer } from "../server/http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config/launch.json");
assert.equal(
  (await readConfig(configPath)).enabled,
  false,
  "smoke refuses enabled operator config",
);
const checkpointPath = path.join(root, "server/state/checkpoint.json");
const existed = await access(checkpointPath).then(
  () => true,
  () => false,
);
const runtime = await new Runtime({ configPath, checkpointPath }).initialize();
const server = createServer(runtime, path.join(root, "dist"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (
    await fetch(base + "/api/status?enabled=true&contract=0x123&start=1")
  ).json();
  for (let i = 0; i < 5; i++) {
    await runtime.tick();
    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.phase, "prelaunch");
    assert.equal(status.totalSteps, 0);
    assert.equal(status.maze, null);
    assert.equal(status.startedAt, null);
    assert.equal(status.stateHash, null);
  }
  assert.deepEqual(await (await fetch(base + "/api/history")).json(), {
    episodes: [],
  });
  assert.equal(
    (await (await fetch(base + "/api/protocol")).json()).method.isRatInABox,
    false,
  );
  assert.equal(
    await access(checkpointPath).then(
      () => true,
      () => false,
    ),
    existed,
  );
  console.log(JSON.stringify(initial, null, 2));
  console.log(
    "smoke passed: real loopback http, spoofed query ignored, repeated ticks remain idle, no checkpoint created",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
