import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, activityOutcome } from "./agent-loop.mjs";
const START = Date.parse("2026-01-01T00:00:00Z");
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const answer = (tool = "list_files", args = {}) => ({
  text: JSON.stringify({
    summary: "i finished everything (synthetic planner claim)",
    memory: "synthetic private memory",
    action: { tool, args },
  }),
  costUsd: 0.001,
  requestId: "synthetic-request",
});
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rr-telemetry-isolated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  const loop = new AgentLoop({
    root,
    now: () => now,
    transport: { complete: async () => answer() },
    tools: {
      definitions: () => [],
      execute: async () => ({ files: [{ name: "analyzer.mjs", bytes: 10 }] }),
    },
    ...options,
  });
  return { loop, advance: (ms) => (now += ms), root };
}
test("in-flight inference and selected execution are distinct from completed waiting; duplicate tick does not execute", async (t) => {
  const entered = deferred(),
    inference = deferred(),
    toolEntered = deferred(),
    execution = deferred();
  let calls = 0;
  const { loop } = await fixture(t, {
    transport: {
      complete: async () => {
        calls++;
        entered.resolve();
        return inference.promise;
      },
    },
    tools: {
      definitions: () => [],
      execute: async () => {
        toolEntered.resolve();
        return execution.promise;
      },
    },
  });
  const work = loop.runCycle({ authorized: true });
  await entered.promise;
  assert.equal(loop.status().phase, "thinking");
  assert.equal(loop.status().activity.tool, null);
  assert.equal(loop.status().cycles, 0);
  await loop.runCycle({ authorized: true });
  assert.equal(calls, 1);
  inference.resolve(answer());
  await toolEntered.promise;
  assert.equal(loop.status().phase, "working");
  assert.equal(loop.status().activity.tool, "list_files");
  assert.match(loop.status().activity.intent, /synthetic planner claim/);
  assert.equal(loop.status().activity.nextAt, null);
  execution.resolve({ files: [{ name: "analyzer.mjs", bytes: 10 }] });
  const done = await work;
  assert.equal(done.phase, "resting");
  assert.equal(done.cycles, 1);
  assert.equal(done.activity.tool, null);
  assert.equal(done.activity.intent, null);
  assert.equal(done.activity.nextAt, new Date(START + 60000).toISOString());
  assert.equal(done.events[0].detail, "1 workspace files listed");
  assert.notEqual(done.events[0].detail, done.events[0].intent);
  assert.deepEqual(done.activity.workspace.names, ["analyzer.mjs"]);
  await loop.runCycle({ authorized: true });
  assert.equal(calls, 1);
});
test("gate closure exposes exact reason, does not call paid transport or write state", async (t) => {
  const { loop, root } = await fixture(t, {
    transport: { complete: () => assert.fail("paid transport called") },
  });
  const runtime = {
    gate: {
      ok: false,
      reason: "RPC HTTP 403; launch verification unavailable",
    },
    state: {},
  };
  const s = await loop.tick(runtime);
  assert.equal(s.phase, "paused");
  assert.equal(s.reason, runtime.gate.reason);
  assert.equal(s.cycles, 0);
  assert.equal(s.activity.since, new Date(START).toISOString());
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(root), []);
});
test("credit admission waiting carries retry timing without invoking inference", async (t) => {
  const { loop } = await fixture(t, {
    transport: {
      preflight: async () => ({
        ready: false,
        reason: "credit balance stale; refill pending",
        retryAfterMs: 15000,
      }),
      complete: () => assert.fail("paid transport called"),
    },
  });
  const s = await loop.runCycle({ authorized: true });
  assert.equal(s.phase, "waiting_for_credits");
  assert.equal(s.reason, "credit balance stale; refill pending");
  assert.equal(s.activity.nextAt, new Date(START + 15000).toISOString());
  assert.equal(s.cycles, 0);
});
test("tool errors persist during backoff; planner is not passed off as success", async (t) => {
  const { loop } = await fixture(t, {
    tools: {
      definitions: () => [],
      execute: async () => {
        throw Error("isolated executor unavailable");
      },
    },
  });
  let s = await loop.runCycle({ authorized: true });
  assert.equal(s.phase, "error");
  assert.equal(s.events[0].outcome, "error");
  assert.equal(s.reason, "isolated executor unavailable");
  s = await loop.runCycle({ authorized: true });
  assert.equal(s.phase, "error");
  assert.equal(s.reason, "isolated executor unavailable");
});
test("inference error records no completed cycle, redacts private paths, keeps retry", async (t) => {
  const { loop } = await fixture(t, {
    transport: {
      complete: async () => {
        throw Error(
          "failed " +
            ["", "Users", "synthetic", "private", "key.json"].join("/") +
            " Bearer testsecret",
        );
      },
    },
  });
  const s = await loop.runCycle({ authorized: true });
  assert.equal(s.phase, "error");
  assert.equal(s.cycles, 0);
  assert.equal(s.events[0].outcome, "error");
  assert.doesNotMatch(JSON.stringify(s), /Users|testsecret|key.json/);
  assert.ok(s.activity.nextAt);
});
test("outcome projection refuses stdout as verification, keeps negative outcomes and hides payloads", () => {
  const project = (tool, result) =>
    activityOutcome({
      at: START,
      summary: "intent only",
      action: { tool, args: { secret: "never-public" } },
      result,
    });
  assert.equal(
    project("run_node", { exitCode: 0, stdout: "all tests passed SECRET" })
      .outcome,
    "completed",
  );
  assert.match(project("run_node", { exitCode: 0 }).detail, /not verification/);
  assert.equal(project("run_node", { exitCode: 1 }).outcome, "failed");
  assert.equal(
    project("verify_node", {
      verified: false,
      reason: "negative control failed",
    }).outcome,
    "failed",
  );
  assert.equal(
    project("verify_node", { verified: true, assertions: 3 }).outcome,
    "verified",
  );
  assert.equal(
    project("write_files", { status: "interrupted" }).outcome,
    "interrupted",
  );
  const serialized = JSON.stringify(
    project("read_file", {
      name: ["", "Users", "synthetic", "private.json"].join("/"),
      content: "SECRET",
    }),
  );
  assert.doesNotMatch(serialized, /SECRET|Users|never-public/);
  assert.deepEqual(
    project("list_files", {
      files: [
        { name: "safe.mjs" },
        { name: "../leak.md" },
        { name: "credentials.json" },
        { name: "/tmp/foo.js" },
      ],
    }).files,
    ["safe.mjs"],
  );
});
test("saved cycles survive restore and wait does not call tools", async (t) => {
  const { loop, root } = await fixture(t, {
    transport: { complete: async () => answer("wait", { seconds: 120 }) },
    tools: {
      definitions: () => [],
      execute: () => assert.fail("wait executed a tool"),
    },
  });
  const s = await loop.runCycle({ authorized: true });
  assert.equal(s.events[0].outcome, "waiting");
  assert.equal(s.activity.nextAt, new Date(START + 120000).toISOString());
  const restored = new AgentLoop({
    root,
    now: () => START + 1000,
    transport: { complete: () => assert.fail("unexpected inference") },
    tools: { definitions: () => [] },
  });
  const r = await restored.runCycle({ authorized: true });
  assert.equal(r.cycles, 1);
  assert.equal(r.phase, "resting");
  assert.equal(r.activity.nextAt, s.activity.nextAt);
});
test("daily admission ceiling unchanged", async (t) => {
  const { loop } = await fixture(t, {
    transport: { complete: () => assert.fail("budget exceeded") },
  });
  assert.equal(loop.maxDailyCostUsd, 0.75);
  await loop.restore();
  loop.state.days["2026-01-01"] = { costUsd: 0.75, requests: 1 };
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    loop.file,
    JSON.stringify({
      state: loop.state,
      hash: createHash("sha256")
        .update(JSON.stringify(loop.state))
        .digest("hex"),
    }),
  );
  const s = await loop.runCycle({ authorized: true });
  assert.equal(s.phase, "resting");
  assert.match(s.reason, /daily compute ceiling/);
  assert.equal(s.cycles, 0);
});
