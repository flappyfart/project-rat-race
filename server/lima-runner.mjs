import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const UNPACK = `const fs=require('fs'),p=require('path');let s='';process.stdin.on('data',b=>{s+=b;if(s.length>1500000)process.exit(2)});process.stdin.on('end',()=>{const a=JSON.parse(s);for(const f of a){if(!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(f.name)||f.name.includes('..')||f.name.split('/').some(x=>x.startsWith('.')))throw Error('unsafe input');const x=p.resolve('/workspace',f.name);if(!x.startsWith('/workspace/'))throw Error('escape');fs.mkdirSync(p.dirname(x),{recursive:true});fs.writeFileSync(x,f.content)}console.log('input prepared')});`;
const COLLECT = `const fs=require('fs'),p=require('path'),a=[];let total=0;function walk(d,prefix=''){for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f),name=prefix+n;if(n.startsWith('.')||s.isSymbolicLink())throw Error('unsupported output');if(s.isDirectory())walk(f,name+'/');else if(s.isFile()){if(!/\\.(js|mjs|cjs|html|css|json|md|txt|csv|svg)$/.test(n))throw Error('unsupported output type');total+=s.size;if(total>750000||a.length>=80)throw Error('output limit');a.push({name,content:fs.readFileSync(f,'utf8')})}else throw Error('nonregular output')}}walk('/workspace');console.log(JSON.stringify(a));`;
export class LimaRunner {
  constructor({
    binary = path.join(
      homedir(),
      ".local/share/project-rat-race/tools/lima/bin/limactl",
    ),
    limaHome = path.join(homedir(), ".local/share/project-rat-race/lima"),
    instance = "rat-race",
    image = "docker.io/library/node:22-alpine",
    timeoutMs = 20000,
  } = {}) {
    this.binary = binary;
    this.limaHome = limaHome;
    this.instance = instance;
    this.imageReference = image;
    this.image = image;
    this.timeoutMs = timeoutMs;
    this.ready = false;
    this.uid = "501";
    this.gid = "501";
  }
  command(args, { input = "", timeoutMs = 20000, maxOutput = 1500000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["shell", this.instance, ...args], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: homedir(),
          LIMA_HOME: this.limaHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        overflow = false,
        timedOut = false,
        finished = false,
        force;
      const finish = (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(force);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, signal, stdout, stderr, timedOut, overflow });
      };
      const kill = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        force = setTimeout(() => finish(null, "SIGKILL"), 300);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const collect = (kind, b) => {
        if (finished || overflow) return;
        const text = b.toString(),
          room = Math.max(
            0,
            maxOutput - Buffer.byteLength(stdout) - Buffer.byteLength(stderr),
          );
        if (kind === "stdout") stdout += text.slice(0, room);
        else stderr += text.slice(0, room);
        if (b.length > room) {
          overflow = true;
          kill();
        }
      };
      child.stdout.on("data", (b) => collect("stdout", b));
      child.stderr.on("data", (b) => collect("stderr", b));
      child.on("error", (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(force);
        reject(e);
      });
      child.on("close", finish);
      child.on("exit", (code, signal) => {
        if (timedOut || overflow) finish(code, signal);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  async health() {
    const r = await this.command(["id", "-u"]);
    if (r.code !== 0 || !/^\d+$/.test(r.stdout.trim()))
      throw Error("sandbox VM unavailable");
    this.uid = r.stdout.trim();
    const g = await this.command(["id", "-g"]);
    if (g.code !== 0 || !/^\d+$/.test(g.stdout.trim()))
      throw Error("sandbox identity unavailable");
    this.gid = g.stdout.trim();
    const image = await this.command([
      "sudo",
      "nerdctl",
      "image",
      "inspect",
      this.imageReference,
      "--format",
      "{{json .RepoDigests}}",
    ]);
    if (image.code !== 0) throw Error("sandbox image unavailable");
    const digests = JSON.parse(image.stdout.trim());
    if (!digests[0]?.includes("@sha256:"))
      throw Error("sandbox image digest missing");
    this.image = digests[0].startsWith("node@")
      ? "docker.io/library/" + digests[0]
      : digests[0];
    this.ready = true;
    return {
      ready: true,
      backend: "isolated linux VM and constrained OCI container",
      image: this.image,
      hostMounts: [],
      network: "none",
      memoryMb: 256,
      cpus: 1,
    };
  }
  container(
    dir,
    name,
    command,
    {
      input = "",
      timeoutMs = 20000,
      maxOutput = 1500000,
      readOnly = false,
    } = {},
  ) {
    return this.command(
      [
        "sudo",
        "nerdctl",
        "run",
        "-i",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--memory",
        "256m",
        "--cpus",
        "1",
        "--pids-limit",
        "32",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        this.uid + ":" + this.gid,
        "--tmpfs",
        "/tmp:rw,nosuid,noexec,size=16m",
        "--mount",
        `type=bind,src=${dir},dst=/workspace${readOnly ? ",readonly" : ""}`,
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        "--env",
        "NODE_OPTIONS=--max-old-space-size=128",
        this.image,
        ...command,
      ],
      { input, timeoutMs, maxOutput },
    );
  }
  async run({ files, entry, args = [], actionId = randomUUID() }) {
    if (!this.ready) await this.health();
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(actionId) ||
      !/^([a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(js|cjs|mjs)$/.test(
        entry,
      ) ||
      entry.includes("..")
    )
      throw Error("invalid sandbox request");
    const id = "rr-" + actionId,
      dir = "/var/lib/rat-sandbox/" + id;
    let mounted = false;
    try {
      let r = await this.command(["sudo", "mkdir", "-p", dir]);
      if (r.code !== 0) throw Error("sandbox directory unavailable");
      r = await this.command([
        "sudo",
        "mount",
        "-t",
        "tmpfs",
        "-o",
        `size=16m,uid=${this.uid},gid=${this.gid},mode=0700,nosuid,nodev,noexec`,
        "tmpfs",
        dir,
      ]);
      if (r.code !== 0) throw Error("sandbox quota mount failed");
      mounted = true;
      r = await this.container(dir, id + "-input", ["node", "-e", UNPACK], {
        input: JSON.stringify(files),
      });
      if (r.code !== 0)
        throw Error(
          "sandbox input preparation failed: " + r.stderr.slice(0, 300),
        );
      const executed = await this.container(
        dir,
        id,
        [
          "timeout",
          "-s",
          "KILL",
          String(Math.ceil(this.timeoutMs / 1000)),
          "node",
          "--",
          entry,
          ...args,
        ],
        { timeoutMs: this.timeoutMs, maxOutput: 160000 },
      );
      if (executed.timedOut || executed.overflow) {
        await this.command(["sudo", "nerdctl", "rm", "-f", id]);
        return {
          exitCode: executed.code,
          timedOut: executed.timedOut,
          outputLimited: executed.overflow,
          stdout: executed.stdout,
          stderr: executed.stderr,
          files: [],
        };
      }
      const collected = await this.container(
        dir,
        id + "-collect",
        ["node", "-e", COLLECT],
        { readOnly: true },
      );
      if (collected.code !== 0)
        throw Error(
          "sandbox output validation failed: " + collected.stderr.slice(0, 300),
        );
      const outputs = JSON.parse(collected.stdout);
      return {
        exitCode: executed.code,
        signal: executed.signal,
        stdout: executed.stdout,
        stderr: executed.stderr,
        files: outputs,
        isolation: {
          network: "none",
          memoryMb: 256,
          hostMounts: [],
          workspaceLimitMb: 16,
          image: this.image,
        },
      };
    } finally {
      await this.command(["sudo", "nerdctl", "rm", "-f", id], {
        timeoutMs: 10000,
      }).catch(() => {});
      if (mounted)
        await this.command(["sudo", "umount", dir], { timeoutMs: 10000 }).catch(
          () => {},
        );
      await this.command(["sudo", "rmdir", dir], { timeoutMs: 10000 }).catch(
        () => {},
      );
    }
  }
}
