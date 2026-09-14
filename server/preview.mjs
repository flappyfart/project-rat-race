import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "./runtime.mjs";
import { createServer } from "./http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await new Runtime({
  configPath: path.join(root, "config/launch.example.json"),
  checkpointPath: path.join(root, "artifacts/preview/unused-checkpoint.json"),
}).initialize();
await runtime.tick({ advance: false });
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("invalid port");
createServer(runtime, path.join(root, "dist")).listen(port, "127.0.0.1", () =>
  console.log("sealed source preview: http://127.0.0.1:" + port),
);
