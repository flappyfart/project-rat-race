import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.argv[2] || "http://127.0.0.1:8789",
  out = "artifacts/arrival-motion";
await mkdir(out, { recursive: true });
const before = await (await fetch(base + "/api/status")).json();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const results = [];
const cases = [
  ["desktop-dark", 1440, 900, "dark", "no-preference"],
  ["laptop-light", 1024, 768, "light", "no-preference"],
  ["mobile-dark", 390, 844, "dark", "no-preference"],
  ["small-light", 320, 740, "light", "no-preference"],
  ["reduced-desktop", 1440, 900, "light", "reduce"],
  ["reduced-mobile", 390, 844, "dark", "reduce"],
];
try {
  for (const [name, width, height, theme, motion] of cases) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: motion,
      colorScheme: theme,
    });
    await context.addInitScript((theme) => {
      try {
        localStorage.setItem("rr-theme", theme);
      } catch {}
      window.__arrivalFrames = [];
      const start = performance.now();
      const sample = () => {
        const h = document.querySelector(".kinetic-headline");
        if (h) {
          window.__arrivalFrames.push({
            at: Math.round(performance.now() - start),
            arrival: document.documentElement.dataset.arrivalState,
            shuffle: h.dataset.shuffleState,
            text: [...h.querySelectorAll(".shuffle-ink")]
              .map((e) => e.textContent)
              .join(" "),
            door: document.querySelector(".arrival-door")
              ? getComputedStyle(document.querySelector(".arrival-door"))
                  .transform
              : null,
          });
        }
        if (performance.now() - start < 5000) setTimeout(sample, 50);
      };
      sample();
    }, theme);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".kinetic-headline");
    const began = Date.now();
    for (const delay of [0, 350, 700, 1150, 1800]) {
      await page.waitForTimeout(Math.max(0, delay - (Date.now() - began)));
      if (
        motion === "no-preference" &&
        (name === "desktop-dark" || name === "mobile-dark")
      )
        await page.screenshot({ path: `${out}/${name}-${delay}.png` });
    }
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.arrivalState === "complete" &&
        document.querySelector(".kinetic-headline")?.dataset.shuffleState ===
          "settled",
    );
    const data = await page.evaluate(() => {
      const h = document.querySelector(".kinetic-headline"),
        r = h.getBoundingClientRect();
      return {
        frames: window.__arrivalFrames,
        label: h.getAttribute("aria-label"),
        words: [...h.querySelectorAll(".shuffle-ink")].map(
          (e) => e.textContent,
        ),
        headlineWidth: r.width,
        wordBounds: [...h.querySelectorAll(".shuffle-word")].map((e) => {
          const b = e.getBoundingClientRect();
          return { left: b.left - r.left, right: b.right - r.left };
        }),
        pageWidth: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overlayHidden: document.querySelector(".arrival-reveal").hidden,
      };
    });
    if (
      data.label !== "the market is the maze." ||
      data.words.join(" ") !== "the market is the maze." ||
      data.words.join("").split(".").length !== 2
    )
      throw Error(name + " incorrect final type");
    if (
      data.scrollWidth > width ||
      data.wordBounds.some(
        (b) => b.right > data.headlineWidth + 2 || b.left < -2,
      )
    )
      throw Error(name + " headline overflow " + JSON.stringify(data));
    if (!data.overlayHidden || errors.length)
      throw Error(name + " overlay or console failure " + errors);
    const shuffled = data.frames.filter(
      (f) => f.shuffle === "shuffling" && f.text !== "the market is the maze.",
    );
    if (
      motion === "no-preference" &&
      new Set(shuffled.map((f) => f.text)).size < 2
    )
      throw Error(name + " shuffle not observed");
    if (
      motion === "reduce" &&
      data.frames.some(
        (f) => f.arrival === "opening" || f.shuffle === "shuffling",
      )
    )
      throw Error(name + " reduced motion ignored");
    const axe = await new AxeBuilder({ page }).analyze();
    if (axe.violations.length)
      throw Error(
        name +
          " accessibility " +
          JSON.stringify(
            axe.violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => n.target),
            })),
          ),
      );
    await page.screenshot({ path: `${out}/${name}-final.png` });
    if (name === "desktop-dark") {
      await page.waitForTimeout(2200);
      await page.locator(".kinetic-headline").hover();
      await page.waitForFunction(
        () =>
          document.querySelector(".kinetic-headline").dataset.shuffleState ===
          "shuffling",
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".kinetic-headline").dataset.shuffleState ===
          "settled",
      );
      await page
        .getByRole("button", { name: /switch to light/ })
        .first()
        .click();
      if (await page.locator(".arrival-reveal").isVisible())
        throw Error("intro replayed on theme change");
    }
    results.push({
      name,
      passed: true,
      observedShuffleFrames: shuffled.length,
      uniqueShuffleStates: new Set(shuffled.map((f) => f.text)).size,
      accessibilityViolations: axe.violations.length,
      headlineWidth: data.headlineWidth,
    });
    await writeFile(
      `${out}/${name}-timeline.json`,
      JSON.stringify(data, null, 2),
    );
    await context.close();
  }
  // A deep link should not be held behind the opening or animate an off-screen title.
  const c = await browser.newContext({
      reducedMotion: "no-preference",
      viewport: { width: 390, height: 844 },
    }),
    p = await c.newPage();
  await p.goto(base + "/#connection", { waitUntil: "networkidle" });
  if (
    (await p.locator(".arrival-reveal").isVisible()) ||
    (await p
      .locator(".kinetic-headline")
      .getAttribute("data-shuffle-state")) !== "settled"
  )
    throw Error("deep link did not skip intro");
  await p.goto(base, { waitUntil: "domcontentloaded" });
  await p.waitForSelector(".kinetic-headline");
  await p.keyboard.press("Escape");
  await p.waitForFunction(
    () =>
      document.documentElement.dataset.arrivalState === "complete" &&
      document.querySelector(".kinetic-headline").dataset.shuffleState ===
        "settled",
  );
  await p.getByRole("button", { name: "open navigation" }).click();
  if (!(await p.locator("#mobile-navigation").isVisible()))
    throw Error("menu obstructed after interruption");
  await p.keyboard.press("Escape");
  await c.close();
  results.push({ name: "deep-link-and-interruption", passed: true });
  const after = await (await fetch(base + "/api/status")).json();
  for (const k of ["totalSteps", "startedAt", "contract"])
    if (before[k] !== after[k]) throw Error("official state changed " + k);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        passed: true,
        base,
        results,
        official: {
          phase: after.phase,
          totalSteps: after.totalSteps,
          startedAt: after.startedAt,
          contract: after.contract,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, base, results, official: after.phase }),
  );
} finally {
  await browser.close();
}
