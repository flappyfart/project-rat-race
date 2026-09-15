import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const name = process.argv[2] ?? "baseline",
  base = process.argv[3] ?? "http://127.0.0.1:8789";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "no-preference",
  }),
  page = await context.newPage(),
  cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(
  () =>
    Number(document.querySelector(".hardware-stage")?.dataset.triangles) > 0,
);
await page.waitForTimeout(1800);
await page.evaluate(() => {
  document.documentElement.style.scrollBehavior = "auto";
  window.__scrollBench = {
    intervals: [],
    longTasks: [],
    reallocations: 0,
    renders: 0,
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__scrollBench.longTasks.push(e.duration);
  }).observe({ type: "longtask" });
  new MutationObserver((records) => {
    window.__scrollBench.reallocations += records.length;
  }).observe(document.querySelector(".hardware-stage canvas"), {
    attributes: true,
    attributeFilter: ["width", "height"],
  });
  new MutationObserver((records) => {
    window.__scrollBench.renders += records.length;
  }).observe(document.querySelector(".hardware-stage"), {
    attributes: true,
    attributeFilter: ["data-camera-position"],
  });
});
const sweep = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const b = window.__scrollBench;
      let previous = performance.now(),
        n = 0;
      const start = previous;
      function tick(now) {
        b.intervals.push(now - previous);
        previous = now;
        window.scrollBy(0, n < 105 ? 32 : -32);
        n++;
        if (n < 180) requestAnimationFrame(tick);
        else resolve({ elapsed: now - start, frames: n, scrollY });
      }
      requestAnimationFrame(tick);
    }),
);
for (const height of [804, 774, 824, 844]) {
  await page.setViewportSize({ width: 390, height });
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1000);
const report = await page.evaluate(() => {
  const b = window.__scrollBench,
    sorted = b.intervals.slice(1).sort((a, b) => a - b),
    pct = (q) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    medianFrameMs: pct(0.5),
    p95FrameMs: pct(0.95),
    maxFrameMs: sorted.at(-1),
    framesOver25Ms: sorted.filter((x) => x > 25).length,
    longTaskCount: b.longTasks.length,
    longTaskMs: b.longTasks.reduce((a, b) => a + b, 0),
    reallocations: b.reallocations,
    renders: b.renders,
    stage: { ...document.querySelector(".hardware-stage").dataset },
  };
});
await mkdir("artifacts/mobile-motion", { recursive: true });
await writeFile(
  "artifacts/mobile-motion/" + name + ".json",
  JSON.stringify(
    {
      name,
      base,
      environment:
        "headless Chrome mobile emulation, 4x CPU throttle, not a physical phone",
      sweep,
      ...report,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ name, sweep, ...report }));
await browser.close();
