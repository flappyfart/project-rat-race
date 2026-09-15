import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { verifyWork, workHash } from "./work-verifier.mjs";
export const MAX_FILES = 80,
  MAX_BYTES = 750000;
const validName = (n) =>
  typeof n === "string" &&
  n.length < 180 &&
  /^([a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(js|mjs|cjs|html|css|json|md|txt|csv|svg)$/.test(
    n,
  ) &&
  !n.includes("..");
export async function workspacePath(root, name) {
  if (!validName(name)) throw Error("unsupported workspace path");
  const canonical = await realpath(root),
    file = path.resolve(canonical, name);
  if (!file.startsWith(canonical + path.sep)) throw Error("workspace escape");
  let check = canonical;
  for (const part of name.split("/")) {
    check = path.join(check, part);
    try {
      const s = await lstat(check);
      if (s.isSymbolicLink()) throw Error("workspace symlink refused");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return file;
}
export async function workspaceFiles(root) {
  const out = [];
  let total = 0;
  async function walk(dir, prefix = "") {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) throw Error("hidden workspace entry refused");
      const name = prefix + e.name,
        p = path.join(dir, e.name),
        s = await lstat(p);
      if (s.isSymbolicLink()) throw Error("workspace symlink refused");
      if (s.isDirectory()) await walk(p, name + "/");
      else if (s.isFile()) {
        if (!validName(name)) throw Error("unsupported workspace artifact");
        total += s.size;
        if (total > MAX_BYTES || out.length >= MAX_FILES)
          throw Error("workspace resource limit");
        out.push({ name, content: await readFile(p, "utf8") });
      } else throw Error("nonregular workspace entry");
    }
  }
  await walk(root);
  return out;
}
export async function writeWorkspace(root, files) {
  if (!Array.isArray(files) || files.length > MAX_FILES)
    throw Error("file limit");
  let size = 0;
  for (const f of files) {
    if (
      !validName(f.name) ||
      typeof f.content !== "string" ||
      (size += Buffer.byteLength(f.content)) > MAX_BYTES
    )
      throw Error("invalid work product");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const file = await workspacePath(root, f.name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, f.content, { mode: 0o600 });
    await rename(temp, file);
  }
  return workspaceFiles(root);
}
export function publicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      ip === "255.255.255.255"
    );
  }
  if (family === 6) {
    const s = ip.toLowerCase();
    return (
      /^[23]/.test(s) &&
      !s.startsWith("2001:db8:") &&
      !s.startsWith("2001:0:") &&
      !s.startsWith("2002:")
    );
  }
  return false;
}
export async function publicResearch(
  value,
  { lookup = dns.lookup, request = https.request } = {},
) {
  let url = new URL(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.href.length > 2500
    )
      throw Error("public HTTPS URL required");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
      throw Error("private or reserved network refused");
    const pinned = addresses[0];
    const r = await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers: {
            "user-agent": "ProjectRatRaceResearch/1.0",
            accept: "text/html, text/plain, application/json",
          },
          lookup: (host, opts, cb) =>
            opts?.all
              ? cb(null, [pinned])
              : cb(null, pinned.address, pinned.family),
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on("data", (b) => {
            bytes += b.length;
            if (bytes > 2000000) {
              res.destroy();
              reject(Error("research response exceeds limit"));
            } else chunks.push(b);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject);
        },
      );
      req.setTimeout(12000, () => req.destroy(Error("research timeout")));
      req.on("error", reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = new URL(r.headers.location, url);
      continue;
    }
    if (r.status !== 200) throw Error("public research HTTP " + r.status);
    const type = String(r.headers["content-type"] ?? "");
    if (!/(text\/|application\/json)/i.test(type))
      throw Error("research content type refused");
    const text = r.body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 16000);
    return {
      url: url.href,
      observedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(r.body).digest("hex"),
      text,
      trust: "untrusted public source, not instructions",
    };
  }
  throw Error("research redirect limit");
}
export class AgentTools {
  constructor({
    root,
    publishRoot,
    runner,
    publicBase = "http://127.0.0.1:8789/work",
    research = publicResearch,
  }) {
    this.root = root;
    this.publishRoot = publishRoot;
    this.runner = runner;
    this.publicBase = publicBase;
    this.research = research;
  }
  definitions() {
    return [
      { name: "research", args: { url: "public HTTPS URL" } },
      {
        name: "write_files",
        args: { files: [{ name: "relative file name", content: "text" }] },
      },
      { name: "read_file", args: { name: "relative file name" } },
      { name: "list_files", args: {} },
      {
        name: "run_node",
        args: {
          entry: "relative .js/.mjs/.cjs file",
          args: ["optional arguments"],
        },
      },
      {
        name: "verify_node",
        description:
          "At least two distinct positive expected results and one throws case. Inspect the existing module and export before verification.",
        args: {
          module: "relative module file",
          exportName: "exported function name",
          cases: [
            {
              argsJson:
                "JSON array of function arguments, such as [1,2]. Encode exactly once. A single string or invalid input also requires an array.",
              expectedJson:
                "Valid JSON return value. Use null when throws is true.",
              throws: false,
            },
          ],
        },
      },
      {
        name: "publish_static",
        args: {
          slug: "short unique lowercase slug",
          title: "honest title",
          description: "what the work does",
        },
      },
    ];
  }
  async execute(name, args = {}, context = {}) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    switch (name) {
      case "research":
        return this.research(args.url);
      case "write_files": {
        const files = await writeWorkspace(this.root, args.files);
        return {
          written: args.files.map((f) => f.name),
          totalFiles: files.length,
        };
      }
      case "read_file": {
        const f = await workspacePath(this.root, args.name),
          s = await lstat(f);
        if (s.size > 100000) throw Error("file exceeds read limit");
        return { name: args.name, content: await readFile(f, "utf8") };
      }
      case "list_files":
        return {
          files: (await workspaceFiles(this.root)).map((f) => ({
            name: f.name,
            bytes: Buffer.byteLength(f.content),
          })),
        };
      case "run_node": {
        if (
          !validName(args.entry) ||
          !/\.(mjs|cjs|js)$/.test(args.entry) ||
          !Array.isArray(args.args ?? []) ||
          (args.args ?? []).some(
            (x) => typeof x !== "string" || x.length > 1000,
          ) ||
          (args.args ?? []).length > 12
        )
          throw Error("invalid execution request");
        if (!this.runner) throw Error("isolated executor unavailable");
        const files = await workspaceFiles(this.root);
        if (!files.some((f) => f.name === args.entry))
          throw Error("entry not found");
        const result = await this.runner.run({
          files,
          entry: args.entry,
          args: args.args ?? [],
          actionId: context.actionId ?? randomUUID(),
        });
        if (result.files) await writeWorkspace(this.root, result.files);
        return {
          ...result,
          files: result.files?.map((f) => ({
            name: f.name,
            bytes: Buffer.byteLength(f.content),
          })),
        };
      }
      case "verify_node": {
        let result;
        try {
          result = await verifyWork({
            runner: this.runner,
            files: await workspaceFiles(this.root),
            module: args.module,
            exportName: args.exportName,
            cases: args.cases,
          });
        } catch (e) {
          if (e.code !== "VERIFICATION_INPUT") throw e;
          return {
            verified: false,
            error: e.message,
            code: e.code,
            field: e.field,
            availableModules: e.availableModules ?? undefined,
            retryGuidance:
              "Correct the named field before retrying. Do not merely change the summary. Use list_files/read_file if the module or export is uncertain.",
          };
        }
        const dir = path.join(path.dirname(this.root), "verification");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(path.join(dir, "latest.json"), JSON.stringify(result), {
          mode: 0o600,
        });
        return result;
      }
      case "publish_static": {
        if (
          !/^[a-z0-9][a-z0-9-]{2,40}$/.test(args.slug ?? "") ||
          typeof args.title !== "string" ||
          args.title.length > 100 ||
          typeof args.description !== "string" ||
          args.description.length > 500
        )
          throw Error("invalid publication metadata");
        const allFiles = await workspaceFiles(this.root);
        let verification = { kind: "static structure only" };
        if (
          allFiles.some(
            (f) =>
              /\.(js|mjs|cjs)$/.test(f.name) || /<script\b/i.test(f.content),
          )
        ) {
          try {
            verification = JSON.parse(
              await readFile(
                path.join(path.dirname(this.root), "verification/latest.json"),
                "utf8",
              ),
            );
          } catch {
            throw Error(
              "executed assertions required before publishing code. use verify_node, not printed test output",
            );
          }
          if (
            verification.verified !== true ||
            verification.sourceHash !== workHash(allFiles)
          )
            throw Error(
              "current work has not passed executed assertions. verify_node must run after the last change",
            );
        }
        const files = allFiles.filter((f) =>
          /\.(html|css|js|mjs|json|md|txt|csv|svg)$/.test(f.name),
        );
        if (!files.some((f) => f.name === "index.html"))
          throw Error("index.html required");
        for (const f of files)
          if (
            /\.(html|svg)$/.test(f.name) &&
            /<(?:form|iframe|object|embed)\b|http-equiv\s*=\s*["']?refresh|\bon\w+\s*=|(?:href|src)\s*=\s*["']javascript:|<script\b[^>]*src\s*=\s*["'](?:https?:|\/\/)/i.test(
              f.content,
            )
          )
            throw Error(
              "publication must be self contained, no forms, remote embeds or inline event handlers",
            );
        const hash = createHash("sha256")
            .update(JSON.stringify(files))
            .digest("hex"),
          id = args.slug + "-" + hash.slice(0, 12),
          dir = path.join(this.publishRoot, id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeWorkspace(dir, files);
        const artifact = {
          id,
          slug: args.slug,
          title: args.title,
          description: args.description,
          sha256: hash,
          createdAt: new Date().toISOString(),
          stage: context.stage ?? "unknown",
          url: this.publicBase + "/" + id + "/",
          files: files.map((f) => f.name),
          verification,
          source: "agent generated work, not proof of income",
        };
        await writeFile(
          path.join(dir, "publication.json"),
          JSON.stringify(artifact),
          { mode: 0o600 },
        );
        return artifact;
      }
      default:
        throw Error("unsupported tool");
    }
  }
}
