import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  skip = new Set([".git", "node_modules", "dist", "artifacts", ".cache"]),
  findings = [];
async function walk(dir) {
  for (const name of await readdir(dir)) {
    if (skip.has(name)) continue;
    const p = path.join(dir, name),
      s = await lstat(p),
      relative = path.relative(root, p);
    if (s.isSymbolicLink()) {
      findings.push({ file: relative, kind: "symlink" });
      continue;
    }
    if (s.isDirectory()) {
      if (relative === "server/state") {
        findings.push({ file: relative, kind: "runtime state" });
        continue;
      }
      await walk(p);
      continue;
    }
    if (
      relative === "config/launch.json" ||
      /^\.env/.test(name) ||
      /keystore|tunnel-token|private-key/i.test(name)
    )
      findings.push({ file: relative, kind: "operator file" });
    if (
      !/\.(mjs|js|ts|tsx|json|ya?ml|md|html|svg|py|swift)$/.test(name) &&
      !["LICENSE", "package-lock.json"].includes(name)
    )
      continue;
    const text = await readFile(p, "utf8");
    if (/\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//.test(text))
      findings.push({ file: relative, kind: "absolute personal home path" });
    if (
      /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./.test(
        text,
      )
    )
      findings.push({ file: relative, kind: "credential pattern" });
    for (const email of text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []) {
      if (
        email === "user" + "@" + "en.wikipedia.org" &&
        relative.endsWith(".test.mjs") &&
        text.includes("https://" + email + "/")
      )
        continue;
      const domain = email.split("@")[1].toLowerCase();
      if (
        !["example.com", "example.test", "users.noreply.github.com"].includes(
          domain,
        )
      )
        findings.push({ file: relative, kind: "email address" });
    }
    for (const term of (process.env.PRIVACY_BLOCK_TERMS ?? "")
      .split(",")
      .filter(Boolean))
      if (text.toLowerCase().includes(term.toLowerCase()))
        findings.push({ file: relative, kind: "blocked private identifier" });
  }
}
await walk(root);
console.log(
  JSON.stringify({ passed: findings.length === 0, findings }, null, 2),
);
if (findings.length) process.exitCode = 1;
