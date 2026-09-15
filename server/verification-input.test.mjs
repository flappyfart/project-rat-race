import test from "node:test";
import assert from "node:assert/strict";
import { verifyWork } from "./work-verifier.mjs";
const files = [
  {
    name: "index.mjs",
    content:
      'export function add(a,b){if(typeof a!=="number"||typeof b!=="number")throw Error("numbers required");return a+b;}',
  },
];
const good = [
  { argsJson: "[1,2]", expectedJson: "3", throws: false },
  { argsJson: "[3,5]", expectedJson: "8", throws: false },
  { argsJson: "[null,2]", expectedJson: "null", throws: true },
];
function request(cases = good, module = "index.mjs") {
  let calls = 0;
  return {
    input: {
      files,
      module,
      exportName: "add",
      cases,
      runner: {
        run: async () => {
          calls++;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "explicit failed harness fixture",
          };
        },
      },
    },
    calls: () => calls,
  };
}
test("a scalar invalid-input case is rejected with its exact field and array correction, before execution", async () => {
  const r = request([
    ...good.slice(0, 2),
    { argsJson: '"invalid syntax("', expectedJson: '""', throws: true },
  ]);
  await assert.rejects(
    verifyWork(r.input),
    (e) =>
      e.code === "VERIFICATION_INPUT" &&
      e.field === "cases[2].argsJson" &&
      /array of function arguments/.test(e.message),
  );
  assert.equal(r.calls(), 0);
});
test("malformed JSON identifies the offending field instead of a generic parse failure", async () => {
  const r = request([
    { ...good[0], expectedJson: '{"broken":' },
    ...good.slice(1),
  ]);
  await assert.rejects(
    verifyWork(r.input),
    (e) =>
      e.code === "VERIFICATION_INPUT" &&
      e.field === "cases[0].expectedJson" &&
      /valid JSON/.test(e.message),
  );
  assert.equal(r.calls(), 0);
});
test("missing module reports the valid workspace modules without a host path", async () => {
  const r = request(good, "missing.mjs");
  await assert.rejects(
    verifyWork(r.input),
    (e) =>
      e.code === "VERIFICATION_INPUT" &&
      e.field === "module" &&
      e.availableModules?.includes("index.mjs"),
  );
  assert.equal(r.calls(), 0);
});
test("whitespace changes do not count as distinct expected results", async () => {
  const r = request([
    { ...good[0], expectedJson: "3" },
    { ...good[1], expectedJson: " 3 " },
    good[2],
  ]);
  await assert.rejects(verifyWork(r.input), /distinct positive results/);
  assert.equal(r.calls(), 0);
});
test("valid encoded arrays reach the verifier without relaxing the failing harness", async () => {
  const r = request(),
    before = JSON.stringify(r.input.cases);
  const result = await verifyWork(r.input);
  assert.equal(result.verified, false);
  assert.equal(r.calls(), 1);
  assert.equal(JSON.stringify(r.input.cases), before);
});
