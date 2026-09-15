import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAPTERS,
  clampProgress,
  progressAtScroll,
  sampleCameraRoute,
} from "../src/experience/cameraRoute.ts";
import { buildHardwareModel } from "../src/experience/HardwareModel.ts";

test("camera follows measured chapter anchors and reverses without synthetic clock input", () => {
  const tops = [0, 900, 1800, 2800, 4000, 5200, 6500, 7500];
  assert.equal(progressAtScroll(0, tops), 0);
  assert.equal(progressAtScroll(900, tops), 1);
  assert.equal(progressAtScroll(1350, tops), 1.5);
  assert.equal(progressAtScroll(1800, tops), 2);
  assert.equal(progressAtScroll(1350, tops), 1.5);
  assert.equal(progressAtScroll(0, tops), 0);
  assert.equal(progressAtScroll(20000, tops), CHAPTERS.length - 1);
  assert.equal(clampProgress(NaN), 0);
  assert.equal(clampProgress(-1), 0);
});
test("all poses are finite and reduced motion has one static pose", () => {
  for (let p = 0; p <= 7; p += 0.05)
    for (const mobile of [false, true]) {
      const pose = sampleCameraRoute(p, mobile);
      assert(
        [...pose.position, ...pose.target, pose.explode, pose.opacity].every(
          Number.isFinite,
        ),
      );
      assert(pose.explode >= 0 && pose.explode <= 1);
      assert(pose.opacity >= 0 && pose.opacity <= 1);
      assert.deepEqual(
        sampleCameraRoute(p, mobile, true),
        sampleCameraRoute(0, mobile, true),
      );
    }
});
test("hardware is original renderable geometry and visual movement cannot mutate supplied maze data", () => {
  const maze = {
      size: 7,
      walls: [
        [0, 0, 7, 0],
        [7, 0, 7, 7],
        [7, 7, 0, 7],
        [0, 7, 0, 0],
        [1, 1, 1, 3],
      ],
      rat: { x: 0.5, z: 0.5, heading: 0 },
      reward: { x: 6.5, z: 6.5 },
      trail: [
        [0.5, 0.5],
        [1.5, 0.5],
      ],
    },
    before = JSON.stringify(maze);
  for (const theme of ["light", "dark"]) {
    const model = buildHardwareModel({
      theme,
      maze,
      statusLabel: "explicit unit fixture",
      steps: 2,
    });
    let meshes = 0,
      triangles = 0;
    model.root.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        triangles +=
          (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      }
    });
    assert(meshes > 10 && meshes < 110);
    assert(triangles < 150000);
    for (const p of [-1, 0, 0.5, 1, 2]) model.setExplode(p);
    model.setStatus("explicit unit fixture", 3);
    model.setMaze(maze);
    assert.equal(JSON.stringify(maze), before);
    assert.deepEqual(model.mazeCenter.toArray(), [0, 0.6, 0]);
    model.dispose();
    model.dispose();
  }
});
