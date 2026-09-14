import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { verifyEscape } from "./learner.mjs";
export function permittedDestination(value, { escaped = false } = {}) {
  if (permittedArticle(value)) return true;
  if (!escaped) return false;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.search
    )
      return false;
    return (
      (u.hostname === "developer.mozilla.org" &&
        u.pathname.startsWith("/en-US/docs/")) ||
      (u.hostname === "docs.python.org" && u.pathname.startsWith("/3/")) ||
      (u.hostname === "openrouter.ai" && u.pathname.startsWith("/docs/"))
    );
  } catch {
    return false;
  }
}

export function permittedArticle(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "en.wikipedia.org" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      u.pathname.startsWith("/wiki/") &&
      u.pathname.length > 6 &&
      !decodeURIComponent(u.pathname.slice(6)).includes(":")
    );
  } catch {
    return false;
  }
}
export function luminanceInput(buffer) {
  const png = PNG.sync.read(buffer);
  if (png.width * png.height > 2000000)
    throw new Error("image exceeds sensor limit");
  const sums = [0, 0, 0, 0],
    counts = [0, 0, 0, 0];
  for (let y = 0; y < png.height; y += 8)
    for (let x = 0; x < png.width; x += 8) {
      const k = (y * png.width + x) * 4;
      const q = (y >= png.height / 2 ? 2 : 0) + (x >= png.width / 2 ? 1 : 0);
      sums[q] +=
        (0.2126 * png.data[k] +
          0.7152 * png.data[k + 1] +
          0.0722 * png.data[k + 2]) /
        255;
      counts[q]++;
    }
  return sums.map((s, i) => s / Math.max(1, counts[i]));
}
export function adapterDecision(weights, input, links, options = {}) {
  if (
    !Array.isArray(weights) ||
    weights.length !== 4 ||
    weights.some(
      (w) =>
        !Array.isArray(w) ||
        w.length !== 10 ||
        w.some((v) => !Number.isFinite(v)),
    )
  )
    throw new Error("invalid model output");
  if (
    input.length !== 4 ||
    input.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new Error("invalid sensory input");
  const f = [
    1,
    ...input,
    ...input.map((v) => 1 - v),
    input.reduce((a, b) => a + b, 0) / 4,
  ];
  const scores = weights.map((row) => row.reduce((a, w, i) => a + w * f[i], 0));
  const motor = scores.indexOf(Math.max(...scores));
  const clean = (u) => {
    try {
      const v = new URL(u);
      v.hash = "";
      return v.href;
    } catch {
      return null;
    }
  };
  const safe = [
    ...new Set(
      links.filter((u) => permittedDestination(u, options)).map(clean),
    ),
  ].filter((u) => u && u !== clean(options.currentUrl));
  if (!safe.length)
    return { action: "no permitted links", url: null, motor, scores, input };
  const index = Math.min(
    safe.length - 1,
    Math.floor(((motor + input[motor]) * safe.length) / 4),
  );
  return {
    action: "open permitted article",
    url: safe[index],
    motor,
    scores,
    input,
  };
}
export class InternetObserver {
  constructor({ root, launchBrowser, now = Date.now } = {}) {
    this.root = root;
    this.launchBrowser = launchBrowser;
    this.now = now;
    this.context = null;
    this.browser = null;
    this.page = null;
    this.busy = false;
    this.lastTick = 0;
    this.frames = new Map();
    this.record = {
      phase: "dormant",
      url: null,
      title: null,
      pagesOpened: 0,
      lastObservedAt: null,
      events: [],
      screenshotUrl: null,
      reason: "internet exploration begins after verified launch",
    };
  }
  status() {
    return structuredClone(this.record);
  }
  event(type, detail, url) {
    this.record.events.push({
      type,
      detail,
      at: new Date(this.now()).toISOString(),
      ...(url ? { url } : {}),
    });
    this.record.events = this.record.events.slice(-80);
  }
  async stop(reason = "internet exploration begins after verified launch") {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.page = null;
    this.record.phase =
      this.record.phase === "error"
        ? "error"
        : this.record.pagesOpened
          ? "paused"
          : "dormant";
    this.record.reason = reason;
  }
  async navigate(url) {
    const previous = this.page.url().split("#")[0];
    const response = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    if (response && response.status() >= 400)
      throw new Error("public page returned " + response.status());
    if (this.page.url().split("#")[0] !== previous) this.record.pagesOpened++;
  }
  async publishFrame(screenshot, record) {
    const id = createHash("sha256")
      .update(screenshot)
      .update(record.lastObservedAt)
      .update(record.url ?? "")
      .digest("hex");
    const next = {
      ...record,
      frameId: id,
      screenshotUrl: "/api/browser-frame?frame=" + id,
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, "frame.png.tmp"), screenshot);
    await rename(
      path.join(this.root, "frame.png.tmp"),
      path.join(this.root, "frame.png"),
    );
    await writeFile(
      path.join(this.root, "record.json.tmp"),
      JSON.stringify(next),
    );
    await rename(
      path.join(this.root, "record.json.tmp"),
      path.join(this.root, "record.json"),
    );
    this.frames.set(id, Buffer.from(screenshot));
    while (this.frames.size > 8)
      this.frames.delete(this.frames.keys().next().value);
    this.record = next;
  }
  async tick(runtime) {
    if (
      !runtime.gate.ok ||
      !runtime.state ||
      runtime.config.internet?.enabled !== true
    ) {
      if (this.browser) await this.stop("experiment gate is closed");
      return;
    }
    if (this.busy || this.now() - this.lastTick < 15000) return;
    this.busy = true;
    this.lastTick = this.now();
    try {
      if (!this.page) {
        const { chromium } = await import("@playwright/test");
        this.browser = await (
          this.launchBrowser ?? chromium.launch.bind(chromium)
        )({
          headless: true,
          ...(runtime.config.internet.executablePath
            ? { executablePath: runtime.config.internet.executablePath }
            : {}),
        });
        this.context = await this.browser.newContext({
          viewport: { width: 960, height: 600 },
          javaScriptEnabled: false,
          acceptDownloads: false,
          serviceWorkers: "block",
          permissions: [],
        });
        await this.context.route("**/*", async (route) => {
          const req = route.request(),
            u = new URL(req.url());
          const asset =
            req.method() === "GET" &&
            u.protocol === "https:" &&
            [
              "en.wikipedia.org",
              "upload.wikimedia.org",
              "commons.wikimedia.org",
              "developer.mozilla.org",
              "docs.python.org",
              "openrouter.ai",
            ].includes(u.hostname) &&
            !u.username &&
            !u.password &&
            !u.port;
          const allowed = req.isNavigationRequest()
            ? permittedDestination(req.url(), {
                escaped: verifyEscape(runtime.state?.escape),
              }) && req.method() === "GET"
            : asset;
          if (allowed) await route.continue();
          else await route.abort();
        });
        this.context.on("page", (p) => {
          if (this.page && p !== this.page) void p.close();
        });
        this.page = await this.context.newPage();
        this.page.on("download", (d) => void d.cancel());
        this.page.on("dialog", (d) => void d.dismiss());
        const seed = runtime.config.internet.seedUrl;
        if (!permittedArticle(seed))
          throw new Error("seed article not permitted");
        await this.navigate(seed);
      }
      const options = {
        escaped: verifyEscape(runtime.state?.escape),
        currentUrl: this.page.url(),
      };
      if (
        runtime.researchTarget &&
        permittedDestination(runtime.researchTarget, options)
      ) {
        const target = runtime.researchTarget;
        runtime.researchTarget = null;
        await this.navigate(target);
        this.event(
          "AI research request",
          "opened an approved research page",
          target,
        );
      }
      if (!permittedDestination(this.page.url(), options))
        throw new Error("navigation escaped research policy");
      options.currentUrl = this.page.url();
      const screenshot = await this.page.screenshot({
        type: "png",
        fullPage: false,
      });
      const input = luminanceInput(screenshot);
      const links = await this.page.locator("a[href]").evaluateAll((nodes) =>
        nodes
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 600;
          })
          .map((n) => n.href),
      );
      if (!runtime.gate.ok || !runtime.state) {
        await this.stop("experiment gate is closed");
        return;
      }
      const decision = adapterDecision(
        runtime.state.weights,
        input,
        links,
        options,
      );
      runtime.sensoryInput = {
        values: input,
        observedAt: new Date(this.now()).toISOString(),
        url: this.page.url(),
      };
      runtime.observationText = {
        url: this.page.url(),
        text: (await this.page.locator("body").innerText()).slice(0, 10000),
        observedAt: new Date(this.now()).toISOString(),
      };
      this.event(
        "observation",
        "four measured screenshot luminance inputs",
        this.page.url(),
      );
      this.event(
        "adapter",
        `model motor channel ${decision.motor} selected ${decision.action}`,
        decision.url,
      );
      await this.publishFrame(screenshot, {
        ...this.record,
        phase: "observing",
        url: this.page.url(),
        title: (await this.page.title()).slice(0, 200),
        lastObservedAt: new Date(this.now()).toISOString(),
        reason: "numeric screen adapter. no semantic understanding claim",
      });
      if (decision.url) {
        await this.navigate(decision.url);
        this.event(
          "navigation",
          "opened an allowed public article",
          decision.url,
        );
      } else
        this.event(
          "veto",
          "no article link available. no unrestricted fallback.",
        );
    } catch (error) {
      this.record.phase = "error";
      this.record.reason =
        "isolated browser unavailable. no fabricated observation.";
      this.event("error", String(error.message).slice(0, 180));
      await this.stop(this.record.reason);
    } finally {
      this.busy = false;
    }
  }
  async frame(id) {
    if (!this.record.screenshotUrl) return null;
    if (id !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      return this.frames.get(id) ?? null;
    }
    return readFile(path.join(this.root, "frame.png"));
  }
}
