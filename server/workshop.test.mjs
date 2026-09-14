import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  Workshop,
  budgetCheck,
  providerReady,
  validateToolOutput,
} from "./workshop.mjs";
import { createLearner, stepLearner } from "./learner.mjs";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rat-workshop-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function escaped() {
  let s = createLearner(55);
  for (const a of [1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1]) {
    s.action = a;
    stepLearner(s, { priceEth: 0.02, timestamp: "2026-09-14T00:00:00.000Z" });
  }
  return s;
}
const policy = {
  enabled: true,
  revision: "offline-unit-fixture",
  allowMazeAdvice: false,
  provider: {
    enabled: true,
    accountSpendingCapVerified: true,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "fixture-model",
    apiKeyEnv: "RAT_FIXTURE_KEY",
    maxOutputTokens: 100,
  },
  budget: {
    dailyRequests: 1,
    dailyReserveMicros: "100",
    lifetimeReserveMicros: "100",
    perRequestReserveMicros: "100",
  },
};
test("workshop makes no requests or writes before launch", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const w = new Workshop({
    root: path.join(root, "workshop"),
    policyPath: path.join(root, "policy.json"),
    request: () => {
      calls++;
    },
  });
  await w.tick({ gate: { ok: false }, state: null });
  assert.equal(calls, 0);
  await assert.rejects(stat(path.join(root, "workshop")), { code: "ENOENT" });
});
test("a funded policy cannot build projects before escape", async (t) => {
  const root = await fixture(t),
    p = path.join(root, "policy.json");
  await writeFile(p, JSON.stringify(policy));
  let calls = 0;
  const w = new Workshop({
    root: path.join(root, "jobs"),
    policyPath: p,
    request: () => {
      calls++;
    },
  });
  await w.tick({ gate: { ok: true }, state: createLearner() });
  assert.equal(calls, 0);
  assert.equal(w.status().phase, "locked");
});
test("escape without approved compute stays budget blocked", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const w = new Workshop({
    root: path.join(root, "jobs"),
    policyPath: path.join(root, "absent.json"),
    request: () => {
      calls++;
    },
  });
  await w.tick({ gate: { ok: true }, state: escaped() });
  assert.equal(w.status().escapeVerified, true);
  assert.equal(w.status().phase, "awaiting_budget");
  assert.equal(calls, 0);
});
test("only dedicated approved AI endpoints can receive credentials", () => {
  assert.equal(providerReady(policy.provider), true);
  for (const endpoint of [
    "https://evil.test/api/v1/chat/completions",
    "http://127.0.0.1:1234",
    "https://openrouter.ai.evil.test/api/v1/chat/completions",
  ])
    assert.equal(providerReady({ ...policy.provider, endpoint }), false);
  assert.equal(
    providerReady({ ...policy.provider, apiKeyEnv: "OPENAI_API_KEY" }),
    false,
  );
});
test("budget allowance is integer bounded and fail closed", () => {
  const empty = { days: {}, lifetimeReservedMicros: "0" };
  assert.equal(budgetCheck(policy, empty, Date.now()).ok, true);
  assert.equal(
    budgetCheck(
      { ...policy, budget: { ...policy.budget, dailyReserveMicros: "99" } },
      empty,
      Date.now(),
    ).ok,
    false,
  );
  assert.equal(
    budgetCheck(
      { ...policy, budget: { ...policy.budget, dailyRequests: 0 } },
      empty,
      Date.now(),
    ).ok,
    false,
  );
});
test("unsafe artifact names and forged tool actions are rejected", () => {
  for (const name of [
    "../wallet.txt",
    "/etc/passwd.txt",
    ".env",
    "a/../../b.js",
    "a.js/../b.js",
  ])
    assert.throws(() =>
      validateToolOutput(
        {
          kind: "project_draft",
          summary: "fixture",
          files: [{ name, content: "fixture" }],
        },
        "project_draft",
      ),
    );
  assert.throws(() =>
    validateToolOutput(
      { kind: "execute_transaction", summary: "fixture", files: [] },
      "project_draft",
    ),
  );
  assert.throws(() =>
    validateToolOutput(
      {
        kind: "maze_advice",
        summary: "fixture",
        directionScores: [100, 0, 0, 0],
      },
      "maze_advice",
    ),
  );
});
test("offline provider fixture drafts files without execution and enforces restart budget", async (t) => {
  const root = await fixture(t),
    p = path.join(root, "policy.json"),
    jobs = path.join(root, "jobs");
  await writeFile(p, JSON.stringify(policy));
  let calls = 0;
  let time = Date.now();
  const response = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "project_draft",
                summary: "offline fixture draft. not published.",
                files: [
                  {
                    name: "index.html",
                    content: "<h1>offline test fixture</h1>",
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.00001 },
      }),
      { status: 200 },
    );
  };
  const options = {
    root: jobs,
    policyPath: p,
    request: response,
    env: { RAT_FIXTURE_KEY: "offline-fixture-not-a-real-key" },
    now: () => time,
  };
  const w = new Workshop(options),
    runtime = { gate: { ok: true }, state: escaped() };
  await w.tick(runtime);
  assert.equal(calls, 1);
  assert.equal(w.status().projects.length, 1);
  const id = w.status().projects[0].id;
  assert.match(
    await readFile(path.join(jobs, "drafts", id, "index.html"), "utf8"),
    /offline test fixture/,
  );
  assert.equal(
    JSON.stringify(w.status()).includes("offline-fixture-not-a-real-key"),
    false,
  );
  time += 61000;
  const restarted = new Workshop(options);
  await restarted.tick(runtime);
  assert.equal(calls, 1);
  assert.equal(restarted.status().phase, "awaiting_budget");
});
test("uncertain provider failure retains reservation, no blind retry after restart", async (t) => {
  const root = await fixture(t),
    p = path.join(root, "policy.json");
  await writeFile(p, JSON.stringify(policy));
  let calls = 0;
  const options = {
    root: path.join(root, "jobs"),
    policyPath: p,
    request: async () => {
      calls++;
      throw new Error("fixture timeout");
    },
    env: { RAT_FIXTURE_KEY: "fixture" },
  };
  const runtime = { gate: { ok: true }, state: escaped() };
  await new Workshop(options).tick(runtime);
  await new Workshop(options).tick(runtime);
  assert.equal(calls, 1);
  const ledger = JSON.parse(
    await readFile(path.join(root, "jobs/budget.json"), "utf8"),
  );
  assert.equal(ledger.lifetimeReservedMicros, "100");
});
