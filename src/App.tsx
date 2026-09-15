import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowDown,
  LockKey,
  Sun,
  Moon,
  List,
  X,
  DownloadSimple,
  GlobeHemisphereWest,
  Wallet,
  Check,
  CircleNotch,
  Flask,
  Brain,
  Fingerprint,
  CaretDown,
  Copy,
  Broadcast,
} from "@phosphor-icons/react";
const MazeScene = lazy(() =>
  import("./Scenes").then((m) => ({ default: m.MazeScene })),
);
const AtlasScene = lazy(() =>
  import("./Scenes").then((m) => ({ default: m.AtlasScene })),
);
import { locked } from "./types";
import type { Status } from "./types";
import Workshop from "./Workshop";
import { ActivityFrame, activityAge, useActivityClock } from "./Activity";
import Manifesto from "./Manifesto";
import Navigation from "./Navigation";
import { ArrivalReveal, KineticHeadline } from "./Arrival";

type Theme = "light" | "dark";
type Connection = {
  phase: string;
  url: string | null;
  title: string | null;
  pagesOpened: number;
  lastObservedAt: string | null;
  events: Array<{ type: string; at: string; detail: string; url?: string }>;
  screenshotUrl?: string | null;
  reason: string;
};
type Economy = {
  phase: string;
  treasury: string | null;
  balanceEth: string | null;
  creatorFeesEth: string | null;
  earnedIncomeEth: string | null;
  spendingEnabled: boolean;
  maxSpendEth: string;
  events: Array<{ type: string; at: string; detail: string }>;
  reason: string;
};
const noConnection: Connection = {
  phase: "dormant",
  url: null,
  title: null,
  pagesOpened: 0,
  lastObservedAt: null,
  events: [],
  reason: "internet exploration begins after verified launch",
};
const noEconomy: Economy = {
  phase: "unconfigured",
  treasury: null,
  balanceEth: null,
  creatorFeesEth: null,
  earnedIncomeEth: null,
  spendingEnabled: false,
  maxSpendEth: "0",
  events: [],
  reason: "treasury address pending operator configuration",
};
const sourceLinks = [
  {
    name: "waxholm space rat atlas",
    kind: "anatomical reference",
    description:
      "actual segmented rat anatomy. the yellow structures are the hippocampal formation.",
    url: "https://www.nitrc.org/projects/whs-sd-atlas/",
  },
  {
    name: "ratinabox",
    kind: "computational literature",
    description:
      "rodent movement and spatial cell models. a reference, not the engine currently running here.",
    url: "https://github.com/RatInABox-Lab/RatInABox",
  },
  {
    name: "ucla spatial navigation study",
    kind: "experimental basis",
    description:
      "hippocampal representations of distance, heading, and experience in virtual environments.",
    url: "https://newsroom.ucla.edu/releases/virtual-reality-how-neurons-enable-learning",
  },
  {
    name: "crcns hippocampal recordings",
    kind: "validation candidate",
    description:
      "real rat recordings. not imported into this controller or presented as its live activity.",
    url: "https://crcns.org/data-sets/hc/hc-3/about-hc-3",
  },
];
const phaseCopy: Record<string, string> = {
  prelaunch: "awaiting contract",
  verification_pending: "verification pending",
  live: "experiment active",
  paused: "experiment paused",
  error: "connection unavailable",
};
function formatTime(s: string | null) {
  return s ? new Date(s).toISOString().slice(11, 19) + " utc" : "not started";
}

function short(s: string | null) {
  return s ? s.slice(0, 6) + "..." + s.slice(-4) : "not assigned";
}
function validStatus(v: unknown): v is Status {
  if (!v || typeof v !== "object") return false;
  const s = v as Status;
  const networkValid =
    s.chainNamespace === "solana"
      ? s.chainId === null &&
        s.quoteAsset === "SOL" &&
        ["prelaunch", "verification_pending", "error"].includes(s.phase) &&
        s.contract === null &&
        s.startedAt === null &&
        s.maze === null &&
        s.totalSteps === 0
      : s.chainId === 4663 && s.quoteAsset === "ETH";
  return (
    networkValid &&
    Object.keys(phaseCopy).includes(s.phase) &&
    typeof s.episode === "number" &&
    typeof s.totalSteps === "number" &&
    (s.phase !== "live" || (!!s.contract && !!s.startedAt && !!s.maze))
  );
}
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const [theme, setTheme] = useState<Theme>(
    (document.documentElement.dataset.theme as Theme) || "light",
  );
  const [status, setStatus] = useState<Status>(locked),
    [apiReady, setApiReady] = useState(false),
    [tab, setTab] = useState<"internet" | "economy">("internet");
  const [connection, setConnection] = useState<Connection>(noConnection),
    [economy, setEconomy] = useState<Economy>(noEconomy),
    [showAtlas, setShowAtlas] = useState(false),
    [copied, setCopied] = useState(false),
    [exportError, setExportError] = useState(""),
    [failedFrame, setFailedFrame] = useState<string | null>(null);
  const atlasSection = useRef<HTMLElement>(null),
    protocolDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("rr-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    async function poll() {
      try {
        const r = await fetch("/api/status", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (!validStatus(d)) throw new Error();
        if (active) {
          setStatus(d);
          setApiReady(true);
        }
      } catch {
        if (active && !abort.signal.aborted) {
          setStatus({
            ...locked,
            phase: "error",
            reason:
              "status connection unavailable. experiment controls locked.",
          });
          setApiReady(true);
        }
      }
    }
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let active = true,
      busy = false;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        for (const path of ["internet", "economy"]) {
          try {
            const r = await fetch("/api/" + path, {
              cache: "no-store",
              signal: abort.signal,
            });
            if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
            const d = await r.json();
            if (!active) continue;
            if (path === "internet") {
              if (!Array.isArray(d.events) || typeof d.phase !== "string")
                throw new Error("invalid internet response");
              setConnection(d);
            } else setEconomy(d);
          } catch (e) {
            if (!active || abort.signal.aborted) continue;
            if (path === "internet")
              setConnection((previous) => ({
                ...previous,
                phase: "unavailable",
                reason:
                  e instanceof Error
                    ? e.message
                    : "observation connection unavailable",
              }));
            else
              setEconomy({
                ...noEconomy,
                reason: "economy connection unavailable",
              });
          }
        }
      } finally {
        busy = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 6000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!atlasSection.current) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShowAtlas(true);
          ob.disconnect();
        }
      },
      { rootMargin: "250px" },
    );
    ob.observe(atlasSection.current);
    return () => ob.disconnect();
  }, []);
  useEffect(() => {
    const ob = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("revealed");
            ob.unobserve(e.target);
          }
        }),
      { threshold: 0.08 },
    );
    document.querySelectorAll("[data-reveal]").forEach((e) => ob.observe(e));
    return () => ob.disconnect();
  }, []);
  const live = status.phase === "live";
  const hasRecordedMaze =
    !!status.startedAt && !!status.maze && status.totalSteps > 0;
  const frameUrl = /^\/api\/browser-frame\?frame=[a-f0-9]{64}$/.test(
    connection.screenshotUrl ?? "",
  )
    ? connection.screenshotUrl
    : null;
  const frameFailed = !!frameUrl && failedFrame === frameUrl;
  const now = useActivityClock();
  const browserStale =
    !connection.lastObservedAt ||
    !Number.isFinite(Date.parse(connection.lastObservedAt)) ||
    now - Date.parse(connection.lastObservedAt) > 45000;
  const browserLabel = !live
    ? status.phase === "paused"
      ? "experiment paused"
      : status.phase === "error"
        ? "status unavailable"
        : "awaiting verified launch"
    : connection.phase !== "observing"
      ? "observer offline"
      : frameFailed
        ? "frame unavailable"
        : browserStale
          ? "observation stale"
          : "recorded sensory snapshot";
  const browserReason = !live
    ? status.reason
    : connection.phase !== "observing"
      ? connection.reason
      : frameFailed
        ? "the recorded frame could not be loaded"
        : browserStale
          ? "no fresh sensory frame received within 45 seconds"
          : null;
  const exportRecord = async () => {
    setExportError("");
    try {
      const r = await fetch("/api/protocol", { cache: "no-store" });
      if (!r.ok) throw new Error();
      download(await r.json(), "rat-race-protocol.json");
    } catch {
      setExportError(
        "record unavailable. please retry when the connection returns.",
      );
    }
  };
  const copy = async () => {
    if (!status.contract) return;
    try {
      await navigator.clipboard.writeText(status.contract);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setExportError(
        "clipboard unavailable. the contract is shown in the launch record.",
      );
    }
  };
  return (
    <>
      <a className="skip-link" href="#main">
        skip to observation
      </a>
      <Navigation
        status={status}
        apiReady={apiReady}
        theme={theme}
        onTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        treasury={economy.treasury}
        onCopy={copy}
        copied={copied}
      />
      <div className="page-content">
        <ArrivalReveal />
        <main id="main">
          <section id="top" className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="small-cross">+</span> independent computational
                laboratory
              </div>
              <KineticHeadline />
              <p className="hero-description">
                a digital rat. a changing world.
                <br />
                an experiment that remembers.
              </p>
              <a className="primary-link" href="#anatomy">
                inside the experiment <ArrowDown size={19} />
              </a>
            </div>
            <div className="hero-apparatus">
              <div className="apparatus-caption">
                <span>
                  <Flask size={16} /> observation chamber
                </span>
                <span className="state-label">
                  <LockKey size={13} />
                  {live ? "active" : hasRecordedMaze ? "paused" : "sealed"}
                </span>
              </div>
              <Suspense
                fallback={
                  <div className="scene-wrap">
                    <img
                      className="maze-fallback-image"
                      src={
                        theme === "dark"
                          ? "/assets/maze-dark.jpg"
                          : "/assets/maze-light.jpg"
                      }
                      alt="static view of the sealed reference apparatus"
                      fetchPriority="high"
                    />
                  </div>
                }
              >
                <MazeScene
                  theme={theme}
                  maze={hasRecordedMaze ? status.maze : null}
                />
              </Suspense>
              <div className="apparatus-foot">
                <span>
                  {hasRecordedMaze
                    ? status.experimentPhase === "escaped"
                      ? "last verified maze state. exit recorded."
                      : live
                        ? "authoritative experiment state"
                        : "last verified maze state. experiment paused."
                    : "reference apparatus. no experiment running."}
                </span>
                <span>spatial navigation</span>
              </div>
            </div>
            <div className="hero-bottom">
              <div className="launch-state">
                <span className={live ? "status-dot active" : "status-dot"} />
                <span>
                  {apiReady ? phaseCopy[status.phase] : "checking launch state"}
                </span>
                <LockKey size={15} />
              </div>
              <div className="launch-message">
                {status.experimentPhase === "escaped"
                  ? "the exit is recorded. follow the agent in beyond."
                  : hasRecordedMaze
                    ? live
                      ? "the official experiment is running."
                      : "the saved experiment is paused."
                    : "the maze starts after the contract goes live."}
              </div>
              <button
                className="inline-link"
                onClick={() => protocolDialog.current?.showModal()}
              >
                launch conditions <ArrowUpRight size={16} />
              </button>
            </div>
          </section>
          <section className="premise section-pad" data-reveal>
            <div className="premise-heading">
              <span className="section-symbol">
                <Fingerprint weight="light" size={48} />
              </span>
              <h2>
                they keep moving
                <br />
                the cheese.
              </h2>
            </div>
            <div className="premise-body">
              <p>
                markets change the conditions.
                <br />
                experience changes the rat.
              </p>
              <p className="body-muted">
                project rat race studies a simple question: can a persistent
                navigation model adapt to an environment that will not stand
                still.
              </p>
              <a href="#protocol" className="inline-link">
                read the experimental protocol <ArrowUpRight size={17} />
              </a>
            </div>
          </section>
          <section
            id="anatomy"
            className="anatomy-section section-pad"
            ref={atlasSection}
            data-reveal
          >
            <div className="anatomy-copy">
              <div className="eyebrow">anatomical reference</div>
              <h2>
                not a brain
                <br />
                shaped decoration.
              </h2>
              <p className="section-intro">
                real rat anatomy.
                <br />a clearly defined computational model.
              </p>
              <p className="body-muted">
                this is the waxholm space rat atlas. explore the actual
                segmented structures, with the hippocampal formation
                highlighted.
              </p>
              <div className="anatomy-facts">
                <div>
                  <span>specimen</span>
                  <strong>sprague dawley rat</strong>
                </div>
                <div>
                  <span>source</span>
                  <strong>mri and dti segmentation</strong>
                </div>
                <div>
                  <span>data layer</span>
                  <strong>anatomy only</strong>
                </div>
              </div>
              <a
                href="/data/atlas-provenance.json"
                target="_blank"
                rel="noreferrer"
                className="inline-link"
              >
                inspect source and provenance <ArrowUpRight size={17} />
              </a>
            </div>
            <div className="anatomy-visual">
              {showAtlas ? (
                <Suspense
                  fallback={
                    <div className="atlas-placeholder">
                      <img
                        src="/assets/atlas-surface.png"
                        alt="anatomical surface reference"
                      />
                    </div>
                  }
                >
                  <AtlasScene theme={theme} />
                </Suspense>
              ) : (
                <div className="atlas-placeholder">
                  <img
                    src="/assets/atlas-surface.png"
                    alt="anatomical rat atlas surface"
                    loading="lazy"
                  />
                </div>
              )}
              <p className="figure-caption">
                waxholm space atlas. adapted surface geometry, not a complete
                neural connectome. cc by 4.0.
              </p>
            </div>
          </section>
          <section className="system-flow section-pad" data-reveal>
            <h2>
              one subject.
              <br />
              three connected worlds.
            </h2>
            <div className="flow-diagram">
              <div className="flow-station">
                <GlobeHemisphereWest weight="light" size={40} />
                <h3>the internet</h3>
                <p>
                  permitted public pages become observations. the adapter
                  records every decision.
                </p>
                <span>sensory input</span>
              </div>
              <div className="flow-arrow">
                <ArrowRight size={24} />
              </div>
              <div className="flow-station neural-station">
                <Brain weight="light" size={44} />
                <h3>spatial memory</h3>
                <p>
                  a learning policy selects actions. memory persists across
                  verified episodes.
                </p>
                <span>simulated cognition</span>
              </div>
              <div className="flow-arrow">
                <ArrowRight size={24} />
              </div>
              <div className="flow-station">
                <Wallet weight="light" size={40} />
                <h3>the economy</h3>
                <p>
                  treasury funding supports the experiment. financial actions
                  require a separate policy.
                </p>
                <span>bounded resources</span>
              </div>
            </div>
            <p className="system-boundary">
              the anatomy is biological reference data. the controller and its
              internet interface are computational. no living tissue or
              consciousness claim.
            </p>
          </section>
          <section
            id="connection"
            className="connection-section section-pad"
            data-reveal
          >
            <div className="connection-heading">
              <h2>observe the connection.</h2>
              <p className="body-muted">
                independent wikipedia sensory snapshots. AI research and tool
                work appear in the workshop below.
              </p>
            </div>
            <div
              className="connection-tabs"
              role="tablist"
              aria-label="observation channel"
            >
              <button
                role="tab"
                id="internet-tab"
                aria-controls="internet-panel"
                aria-selected={tab === "internet"}
                onClick={() => setTab("internet")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") {
                    setTab("economy");
                    document.getElementById("economy-tab")?.focus();
                  }
                }}
              >
                <GlobeHemisphereWest size={18} /> internet
              </button>
              <button
                role="tab"
                id="economy-tab"
                aria-controls="economy-panel"
                aria-selected={tab === "economy"}
                onClick={() => setTab("economy")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    setTab("internet");
                    document.getElementById("internet-tab")?.focus();
                  }
                }}
              >
                <Wallet size={18} /> economy
              </button>
              <span className="connection-state">
                {tab === "internet"
                  ? browserLabel
                  : live
                    ? "economy observations"
                    : "awaiting verified launch"}
              </span>
            </div>
            {tab === "internet" ? (
              <div
                role="tabpanel"
                id="internet-panel"
                aria-labelledby="internet-tab"
                className="observation-panel"
              >
                <div className="browser-observation">
                  <div className="address-bar">
                    <LockKey size={14} />
                    <span>
                      {connection.url ?? "isolated observation channel"}
                    </span>
                    <Broadcast size={16} />
                  </div>
                  {frameUrl && !frameFailed ? (
                    <ActivityFrame
                      url={frameUrl}
                      title={connection.title}
                      reason={browserReason}
                      label={browserLabel}
                      at={connection.lastObservedAt}
                      now={now}
                      onError={() => setFailedFrame(frameUrl)}
                    />
                  ) : (
                    <div className="dormant-browser">
                      <div className="dormant-orbit">
                        <GlobeHemisphereWest weight="thin" size={92} />
                        <span>
                          <LockKey size={20} />
                        </span>
                      </div>
                      <h3>
                        {live && frameFailed
                          ? "frame unavailable."
                          : "the outside world can wait."}
                      </h3>
                      <p>
                        {live && frameFailed
                          ? "waiting for the next recorded observation."
                          : connection.reason}
                      </p>
                      <span className="small-label">
                        {connection.pagesOpened === 0
                          ? "no browsing has begun."
                          : "browser observation paused."}
                      </span>
                    </div>
                  )}
                  <p className="browser-frame-note">
                    {browserReason ??
                      "independent sensory snapshots, not video or evidence of AI work. no visitor control."}{" "}
                    · last frame {connection.lastObservedAt ?? "unavailable"} ·{" "}
                    {activityAge(connection.lastObservedAt, now)}
                  </p>
                  <div className="browser-stats">
                    <span>
                      pages this session{" "}
                      <strong>{connection.pagesOpened}</strong>
                    </span>
                    <span>
                      last observation{" "}
                      <strong>{formatTime(connection.lastObservedAt)}</strong>
                    </span>
                  </div>
                </div>
                <aside className="observation-log">
                  <div className="log-heading">
                    <h3>observation record</h3>
                    <button
                      aria-label="download internet observation record"
                      onClick={() =>
                        download(connection, "rat-race-observations.json")
                      }
                    >
                      <DownloadSimple size={18} />
                    </button>
                  </div>
                  {connection.events.length ? (
                    connection.events
                      .slice(-8)
                      .reverse()
                      .map((e, i) => (
                        <div className="log-event" key={i}>
                          <time>{formatTime(e.at)}</time>
                          <strong>{e.type}</strong>
                          <p>{e.detail}</p>
                          {e.url && (
                            <a href={e.url} target="_blank" rel="noreferrer">
                              source <ArrowUpRight size={12} />
                            </a>
                          )}
                        </div>
                      ))
                  ) : (
                    <div className="empty-log">
                      <span className="empty-line" />
                      <span className="empty-line" />
                      <span className="empty-line" />
                      <p>
                        the record begins with the first verified observation.
                      </p>
                    </div>
                  )}
                  <div className="adapter-note">
                    <strong>authored interface</strong>
                    <p>
                      public research pages. developer documentation opens after
                      verified escape. no accounts, forms, downloads, or wallet
                      access.
                    </p>
                  </div>
                </aside>
              </div>
            ) : (
              <div
                role="tabpanel"
                id="economy-panel"
                aria-labelledby="economy-tab"
                className="economy-panel"
              >
                <div className="treasury-ledger">
                  <div className="treasury-heading">
                    <Wallet weight="light" size={38} />
                    <span>experiment treasury</span>
                  </div>
                  <p>{economy.reason}</p>
                  <dl>
                    <div>
                      <dt>treasury address</dt>
                      <dd>
                        {/^0x[0-9a-fA-F]{40}$/.test(economy.treasury ?? "") ? (
                          <a
                            className="treasury-address-link"
                            href={
                              "https://robinhoodchain.blockscout.com/address/" +
                              economy.treasury
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="view experiment treasury on robinhood chain blockscout"
                            title={economy.treasury ?? ""}
                          >
                            {short(economy.treasury)}
                            <ArrowUpRight size={13} />
                          </a>
                        ) : (
                          short(economy.treasury)
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>verified earned income</dt>
                      <dd>
                        {economy.earnedIncomeEth == null
                          ? "not established"
                          : economy.earnedIncomeEth + " eth"}
                      </dd>
                    </div>
                    <div>
                      <dt>automatic spending</dt>
                      <dd>
                        {economy.spendingEnabled ? "enabled" : "disabled"}{" "}
                        <LockKey size={13} />
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="economy-policy">
                  <h3>the treasury funds the work.</h3>
                  <p>
                    available funds support compute and experiments. a deposit
                    is funding, not earned income.
                  </p>
                  <div className="funding-route">
                    <span>experiment treasury</span>
                    <ArrowDown size={19} />
                    <span>operating reserve</span>
                    <ArrowDown size={19} />
                    <span>compute, research, and project drafts</span>
                  </div>
                  <p className="small-note">
                    no model signing keys. no guaranteed income. no holder
                    payout promise. spending limits require operator approval.
                  </p>
                  <button
                    className="inline-link"
                    onClick={() => download(economy, "rat-race-economy.json")}
                  >
                    download economy state <DownloadSimple size={16} />
                  </button>
                </div>
              </div>
            )}
          </section>
          <Workshop status={status} />
          <Manifesto />
          <section
            id="protocol"
            className="protocol-section section-pad"
            data-reveal
          >
            <div className="protocol-title">
              <div className="eyebrow">open experimental protocol</div>
              <h2>
                the rules are
                <br />
                part of the experiment.
              </h2>
              <p>
                observe the behavior.
                <br />
                inspect the mechanism.
              </p>
              <button className="primary-link" onClick={exportRecord}>
                download current record <DownloadSimple size={18} />
              </button>
              {exportError && (
                <p className="error-copy" role="alert">
                  {exportError}
                </p>
              )}
            </div>
            <div className="protocol-accordions">
              {[
                [
                  "what starts the maze.",
                  "the new contract and launch transaction must be verified on robinhood chain. activation also requires usable funding, a fresh reference market observation and the isolated executor. until then, the official rat remains sealed.",
                ],
                [
                  "what changes the maze.",
                  "each attempt uses a recorded reference market snapshot, seed and episode to generate a connected maze. price, daily price-change and turnover proxies affect passages. walls stay fixed during that attempt. the source is visible, and a reachable exit is not a promised escape.",
                ],
                [
                  "what the brain actually is.",
                  "the atlas is genuine rat anatomy. the initial navigation controller is a place cell inspired sarsa prototype using synthetic spatial features. it is not a full rat brain, a ratinabox implementation, or a validated biological reconstruction.",
                ],
                [
                  "what the internet adapter does.",
                  "an isolated browser observes permitted public articles. numeric page observations are mapped into the controller interface. the adapter constrains navigation and publishes its interventions. this does not establish semantic understanding of a page.",
                ],
                [
                  "what persists.",
                  "the server stores learned weights, random state, actions, route, and launch identity. the first verified exit preserves the final maze state and unlocks the workshop stage. no countdown triggers escape. a corrupt checkpoint is an error, not permission to erase history.",
                ],
                [
                  "what the chain can do.",
                  "the chain establishes the token launch and supplies treasury observations. the dedicated receiving wallet is separate from the model. the mission is open ended, with no prescribed business model or per action approval queue. payment and publishing require working isolated execution tools and use only dedicated resources. the current signing service is limited to compute funding. code runs in a separate linux sandbox, and public work previews require executed assertions.",
                ],
                [
                  "what is not being claimed.",
                  "no live animal is involved. no uploaded consciousness. no market oracle, investment recommendation, guaranteed return, or institutional endorsement. scientific references are attributed, not claimed as partnerships.",
                ],
              ].map(([title, text], i) => (
                <details key={title} open={i === 0}>
                  <summary>
                    {title}
                    <CaretDown size={18} />
                  </summary>
                  <p>{text}</p>
                </details>
              ))}
            </div>
          </section>
          <section className="research-section section-pad" data-reveal>
            <h2>built on a visible record.</h2>
            <div className="research-list">
              {sourceLinks.map((s) => (
                <a key={s.name} href={s.url} target="_blank" rel="noreferrer">
                  <span className="source-kind">{s.kind}</span>
                  <h3>
                    {s.name}
                    <ArrowUpRight size={20} />
                  </h3>
                  <p>{s.description}</p>
                </a>
              ))}
            </div>
            <p className="attribution">
              atlas attribution: kleven, bjerke, clasca and colleagues. papp and
              colleagues. hippocampal delineations by kjonigsen and colleagues.
              adapted geometry by project rat race. source hashes and license
              notes are included in the provenance record.
            </p>
          </section>
          <section className="closing section-pad" data-reveal>
            <span className="closing-mark">r.</span>
            <h2>
              the maze resets.
              <br />
              the rat remembers.
            </h2>
            <div className="closing-state">
              <LockKey size={18} />
              <span>
                {live
                  ? "the experiment is active."
                  : "awaiting the first contract."}
              </span>
            </div>
          </section>
        </main>
        <footer className="site-footer">
          <div>
            <strong>project rat race</strong>
            <span>independent computational experiment</span>
          </div>
          <a
            href="/data/atlas-provenance.json"
            target="_blank"
            rel="noreferrer"
          >
            source record <ArrowUpRight size={15} />
          </a>
        </footer>
      </div>
      <dialog
        ref={protocolDialog}
        className="launch-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) protocolDialog.current?.close();
        }}
      >
        <div className="dialog-head">
          <LockKey size={25} />
          <button
            aria-label="close launch conditions"
            onClick={() => protocolDialog.current?.close()}
          >
            <X size={22} />
          </button>
        </div>
        <h2>sealed until launch.</h2>
        <p>
          the operator launches the token. the experiment independently verifies
          the evidence.
        </p>
        <ol>
          <li>contract address supplied by the operator.</li>
          <li>
            verified robinhood chain contract and successful launch transaction.
          </li>
          <li>
            token code, identity and confirmed canonical launch block verified.
          </li>
          <li>approved market source and explicit activation.</li>
        </ol>
        <div className="dialog-status">
          <span>current state</span>
          <strong>{phaseCopy[status.phase]}</strong>
        </div>
        <p className="small-note">
          camera inspection and anatomical exploration do not run the maze.
          there is no public activation control.
        </p>
        <button
          className="primary-link"
          onClick={() => protocolDialog.current?.close()}
        >
          return to the lab <ArrowRight size={18} />
        </button>
      </dialog>
    </>
  );
}
