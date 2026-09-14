import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  lstat,
  rename,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const sessionRoot = path.resolve(
  new URL("../../artifacts/prelaunch-validation/sessions/", import.meta.url)
    .pathname,
);
export async function createTestSession() {
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    dir = path.join(sessionRoot, id);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(
    path.join(dir, "test-session.json"),
    JSON.stringify({
      kind: "rat-race-isolated-test",
      id,
      financialStateAllowed: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
  for (const n of ["simulation", "workshop", "browser"])
    await mkdir(path.join(dir, n), { mode: 0o700 });
  return dir;
}
export async function resetTestSession(dir) {
  if (path.dirname(path.resolve(dir)) !== sessionRoot)
    throw new Error("reset is restricted to an isolated test session");
  const canonicalRoot = await realpath(sessionRoot),
    canonical = await realpath(dir);
  if (
    canonicalRoot !== sessionRoot ||
    path.dirname(canonical) !== canonicalRoot ||
    !/^[-0-9a-f]{36}$/.test(path.basename(canonical))
  )
    throw new Error("reset is restricted to an isolated test session");
  if ((await lstat(dir)).isSymbolicLink())
    throw new Error("symlink session rejected");
  const marker = JSON.parse(
    await readFile(path.join(canonical, "test-session.json"), "utf8"),
  );
  if (
    marker.kind !== "rat-race-isolated-test" ||
    marker.id !== path.basename(canonical) ||
    marker.financialStateAllowed !== false
  )
    throw new Error("test session identity mismatch");
  const archive = path.join(canonical, "archive", randomUUID());
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const n of ["simulation", "workshop", "browser"]) {
    const source = path.join(canonical, n);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("symlink or invalid state directory rejected");
  }
  for (const n of ["simulation", "workshop", "browser"]) {
    const source = path.join(canonical, n);
    await rename(source, path.join(archive, n));
    await mkdir(source, { mode: 0o700 });
  }
  const reset = {
    resetAt: new Date().toISOString(),
    archive,
    resetScope: ["simulation", "workshop", "browser"],
    walletAndPayments: "not touched",
  };
  await writeFile(
    path.join(canonical, "last-reset.json"),
    JSON.stringify(reset, null, 2),
    { mode: 0o600 },
  );
  for (const n of reset.resetScope)
    if ((await readdir(path.join(canonical, n))).length)
      throw new Error("reset state is not empty");
  return reset;
}
