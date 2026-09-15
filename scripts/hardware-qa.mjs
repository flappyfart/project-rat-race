import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.argv[2] ?? "http://127.0.0.1:8789",
  out = "artifacts/hardware-official";
await mkdir(out, { recursive: true });
const get = async (p) => {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw Error(p + " unavailable");
  return r.json();
};
const before = await get("/api/status");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const results = [];
async function move(page, id) {
  await page
    .locator("#" + id)
    .evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(850);
}
try {
  for (const [name, width, height, theme] of [
    ["desktop", 1440, 900, "light"],
    ["laptop", 1024, 768, "dark"],
    ["mobile", 390, 844, "dark"],
    ["small", 320, 740, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "no-preference",
    });
    await context.addInitScript(
      (t) => localStorage.setItem("rr-theme", t),
      theme,
    );
    const page = await context.newPage(),
      errors = [],
      badResponses = [],
      writes = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(base))
        badResponses.push({ url: r.url(), status: r.status() });
    });
    page.on("request", (r) => {
      if (r.url().includes("/api/") && r.method() !== "GET")
        writes.push(r.url());
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () =>
        Number(document.querySelector(".hardware-stage")?.dataset.triangles) >
        0,
    );
    await page.waitForTimeout(1700);
    const poses = [];
    for (const id of [
      "top",
      "machine",
      "maze",
      "anatomy",
      "connection",
      "beyond",
    ]) {
      await move(page, id);
      const d = await page
        .locator(".hardware-stage")
        .evaluate((e) => ({ ...e.dataset }));
      poses.push({ id, ...d });
      if (d.renderState !== "ready" || Number(d.triangles) < 1000)
        throw Error(name + " scene not rendered");
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        )
      )
        throw Error(name + " horizontal overflow");
      if (["top", "machine", "maze", "beyond"].includes(id))
        await page.screenshot({ path: `${out}/${name}-${id}-qa.png` });
    }
    if (
      new Set(poses.slice(0, 3).map((x) => x.cameraPosition)).size !== 3 ||
      Number(poses[1].explode) < 0.9
    )
      throw Error(name + " camera or casing did not animate");
    await move(page, "top");
    const reversed = await page
      .locator(".hardware-stage")
      .getAttribute("data-scene-progress");
    if (Number(reversed) > 0.01) throw Error(name + " reverse scroll failed");
    await page.getByRole("button", { name: "pause background motion" }).click();
    await move(page, "machine");
    const stopped = await page
      .locator(".hardware-stage")
      .getAttribute("data-camera-position");
    await move(page, "maze");
    if (
      stopped !==
      (await page
        .locator(".hardware-stage")
        .getAttribute("data-camera-position"))
    )
      throw Error("paused camera moved");
    await page
      .getByRole("button", { name: "resume background motion" })
      .click();
    await page.waitForTimeout(700);
    if (width < 1024) {
      await page.getByRole("button", { name: "open navigation" }).click();
      if (!(await page.locator("#mobile-navigation").isVisible()))
        throw Error("mobile menu blocked");
      await page.keyboard.press("Escape");
    }
    const axe = await new AxeBuilder({ page }).analyze();
    if (axe.violations.length)
      throw Error(
        JSON.stringify({
          name,
          a11y: axe.violations.map((x) => ({
            id: x.id,
            targets: x.nodes.map((n) => n.target),
          })),
        }),
      );
    if (errors.length || badResponses.length || writes.length)
      throw Error(JSON.stringify({ name, errors, badResponses, writes }));
    results.push({ name, passed: true, poses, accessibilityViolations: 0 });
    await context.close();
  }
  const reduced = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    }),
    rp = await reduced.newPage();
  await rp.goto(base, { waitUntil: "networkidle" });
  await rp.waitForFunction(
    () =>
      Number(document.querySelector(".hardware-stage")?.dataset.triangles) > 0,
  );
  await move(rp, "top");
  const staticPose = await rp
    .locator(".hardware-stage")
    .getAttribute("data-camera-position");
  await move(rp, "maze");
  if (
    staticPose !==
    (await rp.locator(".hardware-stage").getAttribute("data-camera-position"))
  )
    throw Error("reduced motion camera moved");
  results.push({ name: "reduced-motion", passed: true });
  await reduced.close();
  const fallback = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  await fallback.addInitScript(() => {
    const old = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).startsWith("webgl")) return null;
      return old.apply(this, [type, ...args]);
    };
  });
  const fp = await fallback.newPage();
  await fp.goto(base, { waitUntil: "networkidle" });
  await fp.waitForFunction(
    () =>
      document.querySelector(".hardware-stage")?.dataset.renderState ===
      "fallback",
  );
  if (
    !(await fp
      .locator(".hardware-fallback")
      .evaluate((i) => i.complete && i.naturalWidth > 0))
  )
    throw Error("fallback artwork missing");
  await fp.screenshot({ path: out + "/webgl-fallback.png" });
  results.push({ name: "webgl-fallback", passed: true });
  await fallback.close();
  const after = await get("/api/status");
  for (const k of ["contract", "startedAt", "chainId"])
    if (before[k] !== after[k]) throw Error("runtime identity changed");
  if (
    before.phase === "prelaunch" &&
    (after.totalSteps !== 0 || after.phase !== "prelaunch")
  )
    throw Error("presentation activated experiment");
  await writeFile(
    out + "/qa-report.json",
    JSON.stringify(
      {
        passed: true,
        base,
        results,
        official: {
          phase: after.phase,
          steps: after.totalSteps,
          contract: after.contract,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      base,
      cases: results.map((x) => ({ name: x.name, passed: x.passed })),
      official: after.phase,
    }),
  );
} finally {
  await browser.close();
}
