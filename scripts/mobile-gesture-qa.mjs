import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.argv[2] ?? "http://127.0.0.1:8789",
  out = "artifacts/mobile-motion";
await mkdir(out, { recursive: true });
const before = await (await fetch(base + "/api/status")).json();
const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  }),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "no-preference",
  }),
  page = await context.newPage(),
  cdp = await context.newCDPSession(page),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      Number(document.querySelector(".hardware-stage")?.dataset.triangles) > 0,
  );
  await page.waitForTimeout(1700);
  const sweeps = [];
  for (const distance of [-650, -650, 400, -700]) {
    const from = await page.evaluate(() => scrollY);
    await cdp.send("Input.synthesizeScrollGesture", {
      x: 195,
      y: 550,
      yDistance: distance,
      speed: 1300,
      gestureSourceType: "touch",
    });
    await page.waitForTimeout(700);
    const data = await page
        .locator(".hardware-stage")
        .evaluate((e) => ({ ...e.dataset })),
      to = await page.evaluate(() => scrollY);
    if (from === to) throw Error("native swipe did not scroll");
    if (
      Math.abs(Number(data.sceneProgress) - Number(data.targetProgress)) > 0.003
    )
      throw Error("camera failed to settle after swipe");
    sweeps.push({ from, to, ...data });
  }
  const dimensions = () =>
    page
      .locator(".hardware-stage canvas")
      .evaluate((e) => ({ width: e.width, height: e.height }));
  const initial = await dimensions();
  for (const height of [804, 774, 824, 844]) {
    await page.setViewportSize({ width: 390, height });
    await page.waitForTimeout(220);
    const next = await dimensions();
    if (next.width !== initial.width || next.height !== initial.height)
      throw Error("toolbar-size change reallocated buffer");
  }
  await page.getByRole("button", { name: "pause background motion" }).click();
  await page.waitForTimeout(100);
  const paused = await page
    .locator(".hardware-stage")
    .getAttribute("data-camera-position");
  await cdp.send("Input.synthesizeScrollGesture", {
    x: 195,
    y: 550,
    yDistance: -350,
    speed: 1200,
    gestureSourceType: "touch",
  });
  if (
    paused !==
    (await page.locator(".hardware-stage").getAttribute("data-camera-position"))
  )
    throw Error("pause failed");
  await page.getByRole("button", { name: "resume background motion" }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(800);
  const landscape = await dimensions();
  if (landscape.width < 800) throw Error("orientation resize was ignored");
  if (
    (await page
      .locator(".hardware-stage")
      .getAttribute("data-geometry-detail")) !== "compact"
  )
    throw Error("touch device lost compact geometry");
  await page.screenshot({ path: out + "/landscape.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page
    .locator("#anatomy")
    .evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "start" }));
  await page.waitForSelector(".atlas-host canvas");
  await page
    .locator(".atlas-host")
    .evaluate((e) =>
      e.scrollIntoView({ block: "center", behavior: "instant" }),
    );
  await page.waitForTimeout(400);
  const rect = await page.locator(".atlas-host canvas").boundingBox(),
    start = await page.evaluate(() => scrollY);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    yDistance: -280,
    speed: 1000,
    gestureSourceType: "touch",
  });
  if ((await page.evaluate(() => scrollY)) <= start)
    throw Error("anatomy canvas captured page swipe");
  await page
    .locator("#top")
    .evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(900);
  await page.screenshot({ path: out + "/portrait.png" });
  await page.getByRole("button", { name: "open navigation" }).click();
  if (!(await page.locator("#mobile-navigation").isVisible()))
    throw Error("menu blocked");
  await page.keyboard.press("Escape");
  if (
    errors.length ||
    (await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ))
  )
    throw Error(JSON.stringify({ errors }));
  const after = await (await fetch(base + "/api/status")).json();
  for (const k of ["phase", "contract", "startedAt", "totalSteps", "chainId"])
    if (after[k] !== before[k]) throw Error("runtime changed " + k);
  await writeFile(
    out + "/gesture-qa.json",
    JSON.stringify(
      {
        passed: true,
        base,
        environment: "emulated touch device, 4x CPU throttling",
        sweeps,
        stableBuffer: initial,
        landscape,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      base,
      nativeSwipes: sweeps.length,
      toolbarBufferStable: true,
      orientationResize: true,
      anatomySwipe: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
