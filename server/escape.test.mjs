import test from "node:test";
import assert from "node:assert/strict";
import {
  createLearner,
  stepLearner,
  validateLearner,
  verifyEscape,
} from "./learner.mjs";
const observation = { priceEth: 0.02, timestamp: "2026-09-14T00:00:00.000Z" };
// Offline test actions only, never injected into the official rat.
const path = [1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1];
function complete() {
  let s = createLearner(33);
  for (const action of path) {
    s.action = action;
    s = stepLearner(s, observation);
  }
  return s;
}
test("only reaching exit creates an escape proof", () => {
  const s = complete();
  assert(s.escape);
  assert.equal(verifyEscape(s.escape), true);
  assert.equal(s.escape.route.length, path.length + 1);
  assert.equal(s.x, 6);
  assert.equal(s.z, 6);
  validateLearner(s);
});
test("escape has no scheduled or wall clock trigger", () => {
  let s = createLearner();
  for (let i = 0; i < 200; i++) {
    s.action = 2;
    s = stepLearner(s, observation);
  }
  assert.equal(s.escape, null);
});
test("escape freezes the maze and preserves learned weights", () => {
  const s = complete(),
    before = JSON.stringify(s);
  for (let i = 0; i < 25; i++) stepLearner(s, observation);
  assert.equal(JSON.stringify(s), before);
});
test("forged path and forged hash cannot unlock workshop", () => {
  const s = complete();
  const proof = structuredClone(s.escape);
  proof.route[1] = [6.5, 6.5];
  assert.equal(verifyEscape(proof), false);
  const bad = structuredClone(s.escape);
  bad.hash = "0".repeat(64);
  assert.equal(verifyEscape(bad), false);
});
