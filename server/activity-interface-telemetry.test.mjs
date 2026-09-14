import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Transform source in memory only: no listener, dist build, runtime APIs or credentials.
test("activity interface renders truthful synthetic states, outcomes and legacy/stale fallbacks", async () => {
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    esbuild: { jsx: "automatic" },
  });
  try {
    const { default: Activity, ActivityFrame } =
      await vite.ssrLoadModule("/src/Activity.tsx");
    const frameUrl = "/api/browser-frame?frame=" + "a".repeat(64),
      frameAt = "2026-01-01T00:00:00Z";
    const frame = renderToStaticMarkup(
      createElement(ActivityFrame, {
        url: frameUrl,
        title: "synthetic wikipedia frame",
        reason: "RPC HTTP 403; launch verification unavailable",
        label: "experiment paused",
        at: frameAt,
        now: Date.parse(frameAt) + 90000,
        onError: () => {},
      }),
    );
    assert.ok(frame.includes(`src="${frameUrl}"`));
    assert.match(frame, /browser-frame-overlay/);
    assert.match(frame, /experiment paused\. not live/);
    assert.match(frame, /RPC HTTP 403; launch verification unavailable/);
    assert.match(frame, /90s ago/);
    assert.ok(frame.includes(frameAt));
    const now = new Date().toISOString();
    const activity = {
      version: 1,
      observedAt: now,
      since: now,
      stage: "working",
      tool: "verify_node",
      intent: "synthetic claim of success",
      nextAt: null,
      workspace: {
        count: 2,
        names: ["analyzer.mjs"],
        completeNames: false,
        observedAt: now,
      },
    };
    const props = {
      phase: "working",
      reason: "executing selected tool: verify_node",
      cycles: 7,
      activity,
      events: [
        {
          at: now,
          type: "verify_node",
          outcome: "failed",
          detail: "assertion harness failed",
          intent: "synthetic planner thought it worked",
        },
      ],
    };
    const render = (p) => renderToStaticMarkup(createElement(Activity, p));
    const active = render(props);
    assert.match(active, /selected tool executing/);
    assert.match(active, /completed cycles/);
    assert.match(active, />7</);
    assert.match(active, /planner intent\. not a verified accomplishment/);
    assert.match(active, /assertion harness failed/);
    assert.match(active, /partial/);
    assert.match(
      active,
      /separate from the independent wikipedia sensory browser/,
    );
    const legacy = render({
      ...props,
      activity: undefined,
      reason: "fake legacy success",
      events: [{ type: "write_files", detail: "fake legacy success" }],
    });
    assert.match(legacy, /detailed activity unavailable/);
    assert.doesNotMatch(legacy, /fake legacy success/);
    const stale = render({
      ...props,
      activity: { ...activity, observedAt: "2020-01-01T00:00:00Z" },
    });
    assert.match(stale, /activity record stale/);
    assert.doesNotMatch(stale, /selected tool: <code>/);
    const unavailable = render({ ...props, unavailable: "workshop HTTP 503" });
    assert.match(unavailable, /workshop HTTP 503/);
    assert.doesNotMatch(unavailable, /selected tool: <code>/);
    const paused = render({
      ...props,
      phase: "paused",
      reason: "RPC HTTP 403",
      activity: { ...activity, tool: null, intent: null },
    });
    assert.match(paused, /RPC HTTP 403/);
    const waiting = render({
      ...props,
      phase: "resting",
      activity: {
        ...activity,
        tool: null,
        intent: null,
        nextAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    assert.match(waiting, /waiting for next cycle/);
    assert.match(waiting, /in 60s/);
  } finally {
    await vite.close();
  }
});
