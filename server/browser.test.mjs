import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InternetObserver } from "./internet.mjs";
import { createLearner } from "./learner.mjs";

test("isolated offline browser fixture exercises pixels, policy output, screenshot and gate shutdown", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rat-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const launchBrowser = async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : {}),
    });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      const register = context.route.bind(context);
      context.route = async (pattern, handler) => {
        await register(pattern, handler);
        // Test fixture override only. No external page is fetched, and this file is not a production import.
        await register("https://en.wikipedia.org/wiki/**", async (route) => {
          requests++;
          await route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><head><title>offline rat adapter test</title></head><body><h1>offline unit fixture</h1><p>not a live observation</p><a href="https://en.wikipedia.org/wiki/Memory">permitted link</a></body></html>',
          });
        });
      };
      return context;
    };
    return browser;
  };
  const observer = new InternetObserver({ root, launchBrowser });
  t.after(() => observer.stop());
  const runtime = {
    gate: { ok: true },
    state: createLearner(),
    config: {
      internet: { enabled: true, seedUrl: "https://en.wikipedia.org/wiki/Rat" },
    },
  };
  await observer.tick(runtime);
  const status = observer.status();
  assert.equal(status.phase, "observing");
  assert.equal(status.title, "offline rat adapter test");
  assert.equal(
    status.events.some((e) => e.type === "observation"),
    true,
  );
  assert.equal(runtime.sensoryInput.values.length, 4);
  assert(requests >= 2);
  assert((await stat(path.join(root, "frame.png"))).size > 1000);
  runtime.gate.ok = false;
  await observer.tick(runtime);
  assert.equal(observer.status().phase, "paused");
  assert.equal(observer.browser, null);
});
