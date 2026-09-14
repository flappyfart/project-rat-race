import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./http.mjs";
import { createEngine } from "./engine.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("invalid port");
const engine = await createEngine({
  configPath: path.join(root, "config/launch.json"),
  stateRoot: path.join(root, "server/state"),
});
const server = createServer(
  engine.runtime,
  path.join(root, "dist"),
  engine.services,
);
let shuttingDown = false;
server.listen(port, "127.0.0.1", () =>
  console.log("rat runtime listening on loopback port " + port),
);
void engine
  .initialize()
  .catch((e) =>
    console.error("engine initialization incomplete: " + e.message),
  );
const timer = setInterval(() => {
  if (!shuttingDown)
    void engine.tick().catch((e) => console.error("engine tick: " + e.message));
}, 2000);
server.on("error", (e) => {
  clearInterval(timer);
  console.error(e.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    await engine.close();
    server.close();
  });
