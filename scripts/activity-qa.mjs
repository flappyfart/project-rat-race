import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.argv[2] ?? "http://127.0.0.1:8789",
  out = "artifacts/rpc-recovery";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const results = [];
try {
  for (const [name, width, theme] of [
    ["desktop", 1440, "light"],
    ["mobile", 390, "dark"],
    ["small", 320, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 950 },
      reducedMotion: "reduce",
      colorScheme: theme,
    });
    await context.addInitScript(
      (t) => localStorage.setItem("rr-theme", t),
      theme,
    );
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/#beyond", { waitUntil: "networkidle" });
    await page.waitForFunction(() =>
      document
        .querySelector(".agent-activity")
        ?.textContent.includes("completed cycles"),
    );
    const activity = await page.locator(".agent-activity").innerText();
    if (activity.includes("detailed activity unavailable"))
      throw Error("new telemetry missing");
    const current = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    if (current.scroll > width || errors.length)
      throw Error(JSON.stringify({ name, current, errors }));
    const axe = await new AxeBuilder({ page }).analyze();
    if (axe.violations.length)
      throw Error(
        JSON.stringify({
          name,
          violations: axe.violations.map((v) => ({
            id: v.id,
            targets: v.nodes.map((n) => n.target),
          })),
        }),
      );
    await page
      .locator(".agent-activity")
      .evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out + "/" + name + "-activity.png" });
    await page
      .locator(".browser-frame-wrap")
      .evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out + "/" + name + "-browser.png" });
    results.push({
      name,
      passed: true,
      activity: activity.slice(0, 850),
      errors,
      accessibilityViolations: 0,
    });
    await context.close();
  }
  const context = await browser.newContext({
      viewport: { width: 390, height: 950 },
      reducedMotion: "reduce",
    }),
    page = await context.newPage();
  const [status, internet, workshop] = await Promise.all(
    ["/api/status", "/api/internet", "/api/workshop"].map(async (p) =>
      (await fetch(base + p)).json(),
    ),
  );
  await page.route("**/api/status", (r) =>
    r.fulfill({
      json: {
        ...status,
        phase: "paused",
        reason: "synthetic outage fixture: chain RPC HTTP 403",
      },
    }),
  );
  await page.route("**/api/internet", (r) =>
    r.fulfill({
      json: {
        ...internet,
        phase: "paused",
        reason: "synthetic outage fixture: chain RPC HTTP 403",
        lastObservedAt: new Date(Date.now() - 120000).toISOString(),
      },
    }),
  );
  await page.route("**/api/workshop", (r) =>
    r.fulfill({
      json: {
        ...workshop,
        phase: "paused",
        reason: "synthetic outage fixture: chain RPC HTTP 403",
      },
    }),
  );
  await page.goto(base + "/#connection", { waitUntil: "networkidle" });
  const text = await page.locator(".browser-frame-overlay").innerText();
  if (!text.includes("not live") || !text.includes("HTTP 403"))
    throw Error("paused frame not clearly labeled");
  await page
    .locator(".browser-frame-wrap")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: out + "/synthetic-paused.png" });
  results.push({ name: "explicit-synthetic-pause", passed: true, text });
  await context.close();
  await writeFile(
    out + "/ui-report.json",
    JSON.stringify({ passed: true, base, results }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, base, results }));
} finally {
  await browser.close();
}
