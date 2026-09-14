import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, rm, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  createTestSession,
  resetTestSession,
} from "../scripts/lib/test-sessions.mjs";
test("test reset archives old state and creates an empty fresh namespace", async (t) => {
  const s = await createTestSession();
  t.after(() => rm(s, { recursive: true, force: true }));
  await writeFile(
    path.join(s, "simulation/checkpoint.json"),
    JSON.stringify({ steps: 88 }),
  );
  await writeFile(path.join(s, "workshop/fixture.txt"), "offline fixture");
  const r = await resetTestSession(s);
  assert.equal(
    await readFile(path.join(r.archive, "simulation/checkpoint.json"), "utf8"),
    '{"steps":88}',
  );
  await assert.rejects(readFile(path.join(s, "simulation/checkpoint.json")), {
    code: "ENOENT",
  });
  assert.equal(r.walletAndPayments, "not touched");
});
test("reset refuses official project and wallet custody paths", async () => {
  await assert.rejects(resetTestSession(path.resolve(".")), /restricted/);
  await assert.rejects(
    resetTestSession(path.join(homedir(), ".local/share/project-rat-race")),
    /restricted/,
  );
});
test("reset rejects a symlink into protected wallet storage", async (t) => {
  const s = await createTestSession();
  t.after(() => rm(s, { recursive: true, force: true }));
  await rename(path.join(s, "simulation"), path.join(s, "original-simulation"));
  await symlink(
    path.join(homedir(), ".local/share/project-rat-race"),
    path.join(s, "simulation"),
  );
  await assert.rejects(resetTestSession(s), /symlink/);
});
