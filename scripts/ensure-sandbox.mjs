import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
const root = path.join(homedir(), ".local/share/project-rat-race"),
  binary = path.join(root, "tools/lima/bin/limactl"),
  env = {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    LIMA_HOME: path.join(root, "lima"),
  };
const r = spawnSync(binary, ["list", "rat-race", "--json"], {
  env,
  encoding: "utf8",
  timeout: 15000,
});
if (r.status !== 0) {
  console.error("sandbox status unavailable");
  process.exit(1);
}
const rows = r.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
if (rows.some((x) => x.name === "rat-race" && x.status === "Running")) {
  console.log("sandbox already running");
  process.exit(0);
}
const start = spawnSync(binary, ["start", "--tty=false", "rat-race"], {
  env,
  stdio: "inherit",
  timeout: 180000,
});
process.exit(start.status ?? 1);
