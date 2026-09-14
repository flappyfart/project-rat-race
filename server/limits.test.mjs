import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { permittedDestination } from "./internet.mjs";
import { Workshop, budgetCheck } from "./workshop.mjs";
import { createLearner, stepLearner } from "./learner.mjs";
const policy = {
  enabled: true,
  revision: "offline-test",
  allowMazeAdvice: false,
  provider: {
    enabled: true,
    accountSpendingCapVerified: true,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "offline-fixture",
    apiKeyEnv: "RAT_FIXTURE",
    maxOutputTokens: 100,
  },
  budget: {
    dailyRequests: 2,
    dailyReserveMicros: "200",
    lifetimeReserveMicros: "200",
    perRequestReserveMicros: "100",
  },
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rat-limits-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = path.join(root, "policy.json");
  await writeFile(p, JSON.stringify(policy));
  let state = createLearner();
  for (const a of [1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1]) {
    state.action = a;
    stepLearner(state, { priceEth: 0.02, timestamp: "2026-09-14T00:00:00Z" });
  }
  return {
    root: path.join(root, "workshop"),
    policyPath: p,
    runtime: { gate: { ok: true }, state },
  };
}
test("developer documentation requires a real escape and never allows checkout pages", () => {
  const u = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
  assert.equal(permittedDestination(u), false);
  assert.equal(permittedDestination(u, { escaped: true }), true);
  assert.equal(
    permittedDestination("https://openrouter.ai/credits", { escaped: true }),
    false,
  );
  assert.equal(
    permittedDestination("https://docs.python.org/3/library/json.html", {
      escaped: true,
    }),
    true,
  );
});
test("negative persisted budget cannot mint allowance", () => {
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(
    budgetCheck(
      policy,
      {
        days: { [day]: { requests: 0, reservedMicros: "-100" } },
        lifetimeReservedMicros: "0",
      },
      Date.now(),
    ).ok,
    false,
  );
});
test("an existing request lock prevents requests and is not removed by another worker", async (t) => {
  const f = await fixture(t);
  await mkdir(f.root);
  await writeFile(path.join(f.root, "request.lock"), "offline fixture lease");
  let calls = 0;
  const w = new Workshop({
    ...f,
    env: { RAT_FIXTURE: "offline" },
    request: () => {
      calls++;
    },
  });
  await w.tick(f.runtime);
  assert.equal(calls, 0);
  assert.match(w.status().reason, /lock/);
  assert.equal(
    await readFile(path.join(f.root, "request.lock"), "utf8"),
    "offline fixture lease",
  );
});
test("reported provider cost overrun persists a halt instead of silently raising budget", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "project_draft",
                summary: "offline fixture",
                files: [],
              }),
            },
          },
        ],
        usage: { cost: 1 },
      }),
      { status: 200 },
    );
  };
  const options = { ...f, env: { RAT_FIXTURE: "offline" }, request };
  await new Workshop(options).tick(f.runtime);
  const ledger = JSON.parse(
    await readFile(path.join(f.root, "budget.json"), "utf8"),
  );
  assert.equal(ledger.halted, true);
  assert.equal(ledger.lifetimeReservedMicros, "1000000");
  await new Workshop(options).tick(f.runtime);
  assert.equal(calls, 1);
});
