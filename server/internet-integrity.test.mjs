import test from "node:test";
import assert from "node:assert/strict";
import { InternetObserver, adapterDecision } from "./internet.mjs";
import { createLearner } from "./learner.mjs";
test("same-document anchors do not masquerade as article navigation", () => {
  const currentUrl = "https://en.wikipedia.org/wiki/Rat";
  const d = adapterDecision(
    createLearner().weights,
    [1, 1, 1, 1],
    [
      currentUrl + "#Pets",
      currentUrl + "#Diet",
      "https://en.wikipedia.org/wiki/Rodent",
    ],
    { currentUrl },
  );
  assert.equal(d.url, "https://en.wikipedia.org/wiki/Rodent");
  assert.equal(
    adapterDecision(
      createLearner().weights,
      [1, 1, 1, 1],
      [currentUrl + "#Pets"],
      { currentUrl },
    ).url,
    null,
  );
});
test("http errors cannot increment page visits", async () => {
  const o = new InternetObserver({ root: "/unused" });
  o.page = {
    url: () => "about:blank",
    goto: async () => ({ status: () => 403 }),
  };
  await assert.rejects(o.navigate("https://en.wikipedia.org/wiki/Rat"), /403/);
  assert.equal(o.record.pagesOpened, 0);
});
test("error state survives browser shutdown", async () => {
  const o = new InternetObserver({ root: "/unused" });
  o.record.phase = "error";
  await o.stop("test error");
  assert.equal(o.status().phase, "error");
});
