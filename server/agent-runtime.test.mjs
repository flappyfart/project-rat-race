import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  AgentTools,
  writeWorkspace,
  publicIp,
  publicResearch,
} from "./agent-tools.mjs";
import { AgentLoop } from "./agent-loop.mjs";
async function root(t) {
  const r = await mkdtemp(path.join(tmpdir(), "rat-agent-unit-"));
  t.after(() => rm(r, { recursive: true, force: true }));
  return r;
}
test("workspace writes are bounded and cannot follow symlinks or traverse", async (t) => {
  const r = await root(t);
  await writeWorkspace(r, [
    { name: "index.html", content: "<h1>fixture</h1>" },
  ]);
  await assert.rejects(
    writeWorkspace(r, [{ name: "../private.txt", content: "bad" }]),
  );
  await symlink("/etc", path.join(r, "escape"));
  await assert.rejects(
    writeWorkspace(r, [{ name: "escape/passwd.txt", content: "bad" }]),
  );
});
test("research rejects local, credentialed and mixed public/private DNS targets", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicIp(ip), false);
  await assert.rejects(publicResearch("https://127.0.0.1/"));
  await assert.rejects(publicResearch("https://user:pass@example.com"));
  await assert.rejects(
    publicResearch("https://example.com", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    }),
  );
});
test("agent persists memory and actual tool results across restart; no work before gate", async (t) => {
  const r = await root(t),
    tools = new AgentTools({
      root: path.join(r, "workspace"),
      publishRoot: path.join(r, "published"),
    });
  let n = 0;
  const transport = {
    complete: async () => ({
      text: JSON.stringify({
        summary: "fixture work",
        memory: "remember fixture",
        action: {
          tool: "write_files",
          args: {
            files: [{ name: "index.html", content: "<h1>fixture</h1>" }],
          },
        },
      }),
      costUsd: 0.001,
      usage: { total_tokens: 20 },
      requestId: "fixture-" + ++n,
    }),
  };
  const a = new AgentLoop({
    root: path.join(r, "agent"),
    tools,
    transport,
    intervalMs: 0,
  });
  await a.tick({ gate: { ok: false }, state: null });
  assert.equal(n, 0);
  await a.runCycle({ authorized: true, context: { stage: "unit fixture" } });
  assert.equal(a.state.cycles, 1);
  assert.equal(
    await readFile(path.join(r, "workspace/index.html"), "utf8"),
    "<h1>fixture</h1>",
  );
  const b = new AgentLoop({
    root: path.join(r, "agent"),
    tools,
    transport,
    intervalMs: 0,
  });
  await b.restore();
  assert.equal(b.state.memory, "remember fixture");
  assert.equal(b.state.cycles, 1);
});
test("operator closure after inference prevents tool execution", async (t) => {
  const r = await root(t);
  let permitted = true,
    calls = 0;
  const a = new AgentLoop({
    root: r,
    tools: { definitions: () => [], execute: async () => calls++ },
    transport: {
      complete: async () => {
        permitted = false;
        return {
          text: JSON.stringify({
            summary: "fixture",
            memory: "",
            action: { tool: "write_files", args: {} },
          }),
          costUsd: 0.001,
          requestId: "fixture",
        };
      },
    },
  });
  await a.runCycle({ authorized: true, authorizationCheck: () => permitted });
  assert.equal(calls, 0);
  assert.equal(a.status().phase, "paused");
});
test("active worker lock cannot be removed or overwrite another worker checkpoint", async (t) => {
  const r = await root(t);
  await writeFile(path.join(r, "agent.lock"), String(process.pid));
  const a = new AgentLoop({ root: r, tools: {}, transport: {} });
  await a.runCycle({ authorized: true });
  assert.equal(
    await readFile(path.join(r, "agent.lock"), "utf8"),
    String(process.pid),
  );
  await assert.rejects(readFile(path.join(r, "agent-state.json")));
});
test("static publication uses immutable content identity and no remote forms", async (t) => {
  const r = await root(t),
    tools = new AgentTools({
      root: path.join(r, "workspace"),
      publishRoot: path.join(r, "published"),
    });
  await tools.execute("write_files", {
    files: [
      { name: "index.html", content: "<!doctype html><h1>fixture work</h1>" },
    ],
  });
  const a = await tools.execute(
    "publish_static",
    {
      slug: "fixture-work",
      title: "fixture",
      description: "explicit unit fixture",
    },
    { stage: "unit" },
  );
  assert(a.url.endsWith("/" + a.id + "/"));
  await tools.execute("write_files", {
    files: [
      {
        name: "index.html",
        content: '<form action="https://example.com">bad</form>',
      },
    ],
  });
  await assert.rejects(
    tools.execute("publish_static", {
      slug: "fixture-work",
      title: "fixture",
      description: "fixture",
    }),
  );
});
