import http from "node:http";
import { serveRatChat } from "./chat-http.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip);
const assetCache = new Map();
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
};
const within = (root, file) =>
  file === root || file.startsWith(root + path.sep);
export function createHandler(runtime, distPath, services = {}) {
  return async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader("cache-control", "no-store");
    const json = (code, body) => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(body));
    };
    // Reject unexpected host headers to reduce DNS-rebinding exposure. No CORS.
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? ""))
      return json(403, { error: "loopback host required" });
    let pathname;
    try {
      if (!req.url.startsWith("/")) throw new Error();
      pathname = decodeURIComponent(req.url.split("?")[0]);
      if (
        pathname.includes("\\") ||
        pathname.includes("\0") ||
        pathname.split("/").some((s) => s === ".." || s.startsWith("."))
      )
        throw new Error();
    } catch {
      return json(400, { error: "unsafe request path" });
    }
    if (pathname === "/api/rat-chat") return serveRatChat(req, res, services);
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return json(405, { error: "only the public chat route accepts posts" });
    }
    if (pathname === "/api/work")
      return json(200, {
        artifacts: (await services.publications?.list()) ?? [],
      });
    if (pathname === "/api/market")
      return json(
        200,
        services.market?.status() ?? {
          available: false,
          reason: "market feed not configured",
        },
      );
    if (
      (pathname.startsWith("/work/") ||
        pathname.startsWith("/work-content/")) &&
      services.publications
    ) {
      if (await services.publications.serve(pathname, res)) return;
    }
    if (pathname === "/api/status") return json(200, runtime.status());
    if (pathname === "/api/protocol") return json(200, runtime.protocol());
    if (pathname === "/api/history") return json(200, runtime.history());
    if (pathname === "/api/escape")
      return json(200, {
        verified: !!runtime.state?.escape,
        proof: runtime.state?.escape ?? null,
      });
    if (pathname === "/api/workshop")
      return json(
        200,
        services.workshop?.status() ?? {
          phase: "locked",
          reason: "launch and escape pending",
          projects: [],
          events: [],
        },
      );
    if (pathname === "/api/internet")
      return json(
        200,
        services.internet?.status() ?? {
          phase: "dormant",
          url: null,
          title: null,
          pagesOpened: 0,
          lastObservedAt: null,
          events: [],
          reason: "internet exploration begins after verified launch",
        },
      );
    if (pathname === "/api/economy")
      return json(
        200,
        services.economy?.status() ?? {
          phase: "unconfigured",
          treasury: null,
          balanceEth: null,
          creatorFeesEth: null,
          spendingEnabled: false,
          maxSpendEth: "0",
          events: [],
          reason: "treasury address pending operator configuration",
        },
      );
    if (pathname === "/api/browser-frame") {
      if (!runtime.gate.ok || !services.internet)
        return json(404, { error: "no active browser observation" });
      try {
        const id = new URL(req.url, "http://127.0.0.1").searchParams.get(
          "frame",
        );
        if (id !== null && !/^[a-f0-9]{64}$/.test(id))
          return json(400, { error: "invalid frame identifier" });
        const image = await services.internet.frame(id ?? undefined);
        if (!image) return json(404, { error: "no observed frame" });
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(image);
      } catch {
        return json(404, { error: "frame unavailable" });
      }
    }
    if (pathname.startsWith("/api/"))
      return json(404, { error: "unknown api route" });
    try {
      const root = await realpath(distPath);
      let candidate = path.resolve(
        root,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      if (!within(root, candidate))
        return json(403, { error: "unsafe request path" });
      try {
        candidate = await realpath(candidate);
      } catch (error) {
        if (error.code !== "ENOENT" || path.extname(pathname)) throw error;
        candidate = await realpath(path.join(root, "index.html"));
      }
      if (!within(root, candidate))
        return json(403, { error: "unsafe request path" });
      const info = await stat(candidate);
      if (!info.isFile()) return json(404, { error: "not found" });
      const ext = path.extname(candidate);
      const useGzip =
        /\bgzip\b/.test(req.headers["accept-encoding"] ?? "") &&
        [".js", ".css", ".html", ".json", ".svg"].includes(ext);
      const key = `${candidate}:${info.mtimeMs}:${useGzip}`;
      let content = assetCache.get(key);
      if (!content) {
        content = await readFile(candidate);
        if (useGzip) content = await compress(content);
        if (assetCache.size > 100) assetCache.clear();
        assetCache.set(key, content);
      }
      res.setHeader("vary", "Accept-Encoding");
      if (useGzip) res.setHeader("content-encoding", "gzip");
      if (
        pathname.startsWith("/assets/") &&
        /-[a-zA-Z0-9_-]{8}\./.test(pathname)
      )
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.writeHead(200, {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "content-length": content.length,
      });
      res.end(content);
    } catch {
      json(404, { error: "site build not found; run npm run build" });
    }
  };
}
export function createServer(runtime, distPath, services = {}) {
  const server = http.createServer(createHandler(runtime, distPath, services));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
