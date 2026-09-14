import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Workshop, validateToolOutput } from "./workshop.mjs";
test("mission does not prescribe a money making activity or require per action approval", async () => {
  const state = new Workshop().status();
  assert.equal(state.approvalMode, "mission");
  assert.equal(state.perActionApproval, false);
  assert.equal(state.executionStatus, "not_connected");
  assert.match(state.mission, /earn income/);
  const source = await readFile(
    new URL("./workshop.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("coin_proposal"), false);
  assert.equal(source.includes("phase='awaiting_review'"), false);
});
test("neutral work products are accepted without inventing transaction execution", () => {
  assert.equal(
    validateToolOutput(
      {
        kind: "work_product",
        summary: "research findings",
        files: [{ name: "research.md", content: "unreviewed research" }],
      },
      "project_draft",
    ).kind,
    "work_product",
  );
  assert.throws(() =>
    validateToolOutput(
      { kind: "broadcast_transaction", summary: "not executed", files: [] },
      "project_draft",
    ),
  );
});
