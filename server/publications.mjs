import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ID = /^[a-z0-9][a-z0-9-]{2,70}$/;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
};
export class Publications {
  constructor(root) {
    this.root = root;
  }
  async list() {
    let names;
    try {
      names = await readdir(this.root);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const rows = [];
    for (const id of names.filter((x) => ID.test(x)).slice(0, 500)) {
      try {
        const p = await this.record(id);
        if (p.stage === "official") rows.push(p);
      } catch {}
    }
    return rows
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  }
  async record(id) {
    if (!ID.test(id)) throw Error("invalid work identifier");
    const root = await realpath(this.root),
      dir = await realpath(path.join(root, id));
    if (!dir.startsWith(root + path.sep)) throw Error("work path escape");
    const p = JSON.parse(
      await readFile(path.join(dir, "publication.json"), "utf8"),
    );
    if (
      p.id !== id ||
      !id.endsWith(p.sha256?.slice(0, 12)) ||
      !Array.isArray(p.files)
    )
      throw Error("publication identity mismatch");
    return p;
  }
  async serve(pathname, res) {
    const m = /^\/(work|work-content)\/([a-z0-9-]+)(?:\/(.*))?$/.exec(pathname);
    if (!m) return false;
    const [, kind, id, rest = ""] = m;
    try {
      const record = await this.record(id);
      res.setHeader(
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
      );
      if (kind === "work") {
        res.setHeader(
          "content-security-policy",
          "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(record.title)} | project rat race</title><style>body{margin:0;background:#f4f4ee;color:#20231e;font:14px system-ui}header{padding:16px 24px;border-bottom:1px solid #d8dcd0;display:flex;gap:24px;align-items:center}header a{color:inherit}header small{margin-left:auto;color:#61665b}iframe{display:block;border:0;width:100%;height:calc(100dvh - 60px);background:white}</style><header><a href="/">project rat race</a><span>${esc(record.title)}</span><small>agent generated work. isolated preview.</small></header><iframe title="${esc(record.title)}" sandbox="allow-scripts" src="/work-content/${id}/index.html"></iframe></html>`,
        );
        return true;
      }
      const name = rest || "index.html";
      if (!record.files.includes(name) || name.includes(".."))
        throw Error("unpublished file");
      const root = await realpath(path.join(this.root, id)),
        file = await realpath(path.join(root, name));
      if (!file.startsWith(root + path.sep) || (await stat(file)).size > 750000)
        throw Error("invalid public artifact");
      const type = MIME[path.extname(file)];
      if (!type) throw Error("unsupported public artifact");
      res.setHeader("cross-origin-resource-policy", "cross-origin");
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader(
        "content-security-policy",
        "sandbox allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      );
      res.writeHead(200, { "content-type": type });
      res.end(await readFile(file));
      return true;
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("work unavailable");
      return true;
    }
  }
}
