import test from "node:test";
import assert from "node:assert/strict";
import {
  followScroll,
  shouldResizeDrawingBuffer,
} from "../src/experience/mobileMotion.ts";
import { buildHardwareModel } from "../src/experience/HardwareModel.ts";
test("mobile camera follow is stable across refresh rates and does not overshoot on reversal", () => {
  let a = 0,
    b = 0;
  for (let i = 0; i < 60; i++) a = followScroll(a, 3, 1000 / 60, true);
  for (let i = 0; i < 120; i++) b = followScroll(b, 3, 1000 / 120, true);
  assert(Math.abs(a - b) < 0.0003);
  assert(a <= 3 && a > 2.99);
  let old = a;
  for (let i = 0; i < 60; i++) {
    const n = followScroll(old, 0, 1000 / 60, true);
    assert(n >= 0 && n <= old);
    old = n;
  }
  assert(old < 0.001);
  assert.equal(followScroll(0, 1, 0, true), 0);
});
test("mobile toolbar height changes do not reallocate the drawing buffer; width/orientation and large resizes do", () => {
  const before = { width: 390, height: 844 };
  for (const height of [824, 804, 774, 844])
    assert.equal(
      shouldResizeDrawingBuffer(before, { width: 390, height }, true),
      false,
    );
  assert.equal(
    shouldResizeDrawingBuffer(before, { width: 844, height: 390 }, true),
    true,
  );
  assert.equal(
    shouldResizeDrawingBuffer(before, { width: 390, height: 480 }, true),
    true,
  );
  assert.equal(
    shouldResizeDrawingBuffer(before, { width: 390, height: 804 }, false),
    true,
  );
  assert.equal(
    shouldResizeDrawingBuffer(before, { width: 0, height: 0 }, true),
    false,
  );
});
test("compact hardware keeps the coordinate contract with substantially fewer triangles", () => {
  const model = (detail) =>
    buildHardwareModel({
      theme: "light",
      maze: null,
      statusLabel: "explicit unit reference",
      steps: 0,
      detail,
    });
  const full = model("full"),
    compact = model("compact");
  const stats = (root) => {
    let triangles = 0;
    root.traverse((o) => {
      if (o.isMesh)
        triangles +=
          (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
    });
    return triangles;
  };
  const f = stats(full.root),
    c = stats(compact.root);
  assert(c < f * 0.75, JSON.stringify({ full: f, compact: c }));
  assert.deepEqual(compact.mazeCenter.toArray(), full.mazeCenter.toArray());
  for (const m of [full, compact]) {
    m.setExplode(1);
    assert.equal(m.root.userData.explode, 1);
    m.setStatus("explicit unit reference", 0);
    m.dispose();
  }
});
