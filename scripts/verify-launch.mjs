import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../server/runtime.mjs";
import { verifyLaunch } from "../server/gate.mjs";
// Verification only: no runtime import side effects, no config writes, no learner creation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length > 2) {
  console.error(
    "verification takes no flags; edit operator configuration explicitly, never auto-enable",
  );
  process.exitCode = 2;
} else {
  const config = await readConfig(path.join(root, "config/launch.json"));
  const result = await verifyLaunch(config);
  console.log(
    JSON.stringify(
      {
        ...result,
        action:
          "verification only; configuration unchanged; experiment not started",
      },
      null,
      2,
    ),
  );
  process.exitCode = result.ok ? 0 : 1;
}
