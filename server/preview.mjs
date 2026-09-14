import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAwaitingLaunchEngine } from "./awaiting-launch.mjs";
import { createServer } from "./http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = await createAwaitingLaunchEngine({
  configPath: path.join(root, "config/launch.example.json"),
});
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("invalid port");
createServer(engine.runtime, path.join(root, "dist"), engine.services).listen(
  port,
  "127.0.0.1",
  () => console.log("sealed source preview: http://127.0.0.1:" + port),
);
