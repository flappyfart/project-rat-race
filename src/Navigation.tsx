import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Brain,
  CaretDown,
  Check,
  Code,
  Copy,
  FileText,
  Fingerprint,
  Flask,
  GlobeHemisphereWest,
  GithubLogo,
  List,
  LockKey,
  Moon,
  Sun,
  Wallet,
  X,
  XLogo,
} from "@phosphor-icons/react";
import type { Status } from "./types";
import "./navigation.css";
const X_URL = "https://x.com/pr0jectratrace";
const GITHUB_URL = "https://github.com/flappyfart/project-rat-race";
const sections = [
  { id: "top", label: "the lab", icon: Flask },
  { id: "anatomy", label: "anatomy", icon: Brain },
  { id: "connection", label: "connection", icon: GlobeHemisphereWest },
  { id: "beyond", label: "beyond", icon: Code },
  { id: "manifesto", label: "manifesto", icon: Fingerprint },
  { id: "protocol", label: "protocol", icon: FileText },
];
const phaseNames = {
  prelaunch: "awaiting contract",
  verification_pending: "verification pending",
  live: "experiment active",
  paused: "experiment paused",
  error: "status unavailable",
};
function Elapsed({
  startedAt,
  unavailable,
}: {
  startedAt: string | null;
  unavailable: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt || unavailable) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, unavailable]);
  if (unavailable) return <>unavailable</>;
  if (!startedAt) return <>not started</>;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || start > now) return <>unavailable</>;
  const seconds = Math.floor((now - start) / 1000),
    days = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return (
    <>
      {days ? days + "d " : ""}
      {[h, m, s].map((n) => String(n).padStart(2, "0")).join(":")}
    </>
  );
}
type Props = {
  status: Status;
  apiReady: boolean;
  theme: "light" | "dark";
  onTheme: () => void;
  treasury: string | null;
  onCopy: () => void;
  copied: boolean;
};
export default function Navigation({
  status,
  apiReady,
  theme,
  onTheme,
  treasury,
  onCopy,
  copied,
}: Props) {
  const [active, setActive] = useState("top"),
    [open, setOpen] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const unavailable = !apiReady || status.phase === "error",
    phase = apiReady ? phaseNames[status.phase] : "checking status",
    treasuryUrl =
      status.chainNamespace !== "solana" &&
      /^0x[0-9a-fA-F]{40}$/.test(treasury ?? "")
        ? "https://robinhoodchain.blockscout.com/address/" + treasury
        : null;
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-12% 0px -62% 0px", threshold: 0 },
    );
    for (const s of sections) {
      const e = document.getElementById(s.id);
      if (e) observer.observe(e);
    }
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const mq = matchMedia("(min-width:1024px)");
    const change = () => {
      if (mq.matches) {
        dialog.current?.close();
        setOpen(false);
      }
    };
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);
  const close = () => {
    dialog.current?.close();
    setOpen(false);
    menuButton.current?.focus();
  };
  const launchMenu = () => {
    dialog.current?.showModal();
    setOpen(true);
  };
  const links = (mobile = false) => (
    <nav
      className="rail-links"
      aria-label={mobile ? "mobile navigation" : "main navigation"}
    >
      {sections.map(({ id, label, icon: Icon }) => (
        <a
          href={"#" + id}
          key={id}
          aria-current={active === id ? "location" : undefined}
          onClick={() => {
            setActive(id);
            if (mobile) close();
          }}
        >
          <Icon size={19} weight="regular" aria-hidden="true" />
          <span>{label}</span>
          <ArrowUpRight
            className="nav-direction"
            size={15}
            aria-hidden="true"
          />
        </a>
      ))}
    </nav>
  );
  const telemetry = (
    <div className="rail-telemetry" aria-label="simulation telemetry">
      <div className="telemetry-heading">
        <span>simulation</span>
        <span
          className={
            "rail-state " + (status.phase === "live" ? "is-active" : "")
          }
        >
          <span />
          {phase}
        </span>
      </div>
      <dl className="telemetry-values">
        <div className="telemetry-major">
          <dt>completed steps</dt>
          <dd data-stat="steps">
            {unavailable ? "unavailable" : status.totalSteps.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>episode</dt>
          <dd data-stat="episode">
            {unavailable
              ? "unavailable"
              : status.episode
                ? status.episode.toLocaleString()
                : "not started"}
          </dd>
        </div>
        <div>
          <dt>exit</dt>
          <dd data-stat="exit">
            {unavailable
              ? "unavailable"
              : status.experimentPhase === "escaped"
                ? "verified"
                : status.startedAt
                  ? "not reached"
                  : "sealed"}
          </dd>
        </div>
        <div className="telemetry-clock">
          <dt>elapsed</dt>
          <dd data-stat="elapsed">
            <Elapsed startedAt={status.startedAt} unavailable={unavailable} />
          </dd>
        </div>
      </dl>
    </div>
  );
  const contract = (
    <div className="rail-contract">
      <span>contract</span>
      <button
        onClick={onCopy}
        disabled={!status.contract}
        aria-label={
          status.contract
            ? "copy contract address " +
              status.contract.slice(0, 6) +
              "..." +
              status.contract.slice(-4)
            : "contract awaiting launch"
        }
      >
        {status.contract
          ? status.contract.slice(0, 6) + "..." + status.contract.slice(-4)
          : "awaiting launch"}
        {status.contract ? (
          copied ? (
            <Check size={13} />
          ) : (
            <Copy size={13} />
          )
        ) : (
          <LockKey size={13} />
        )}
      </button>
    </div>
  );
  return (
    <>
      <aside
        className="desktop-rail"
        aria-label="project navigation and simulation stats"
      >
        <div className="rail-scroll">
          <a
            className="rail-brand"
            href="#top"
            aria-label="project rat race home"
          >
            <span className="rail-mark" aria-hidden="true">
              r.
            </span>
            <span>
              project
              <br />
              <strong>rat race</strong>
            </span>
          </a>
          <div className="rail-identity">
            <strong>$race / {status.quoteAsset.toLowerCase()}</strong>
            <span>
              {status.chainNamespace === "solana"
                ? "solana"
                : "robinhood chain"}
            </span>
          </div>
          {links()}
          {telemetry}
          {contract}
        </div>
        <div className="rail-footer">
          <div className="rail-utilities">
            <a
              href={X_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="project rat race on x, @pr0jectratrace"
            >
              <XLogo size={20} />
              <span>@pr0jectratrace</span>
              <ArrowUpRight size={13} />
            </a>
            <button
              onClick={onTheme}
              aria-label={`switch to ${theme === "light" ? "dark" : "light"} theme`}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </div>
          <div className="rail-resources">
            <a
              className="rail-treasury"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="official github source"
            >
              <GithubLogo size={16} />
              <span>github</span>
              <ArrowUpRight size={12} />
            </a>
            {treasuryUrl && (
              <a
                className="rail-treasury"
                href={treasuryUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="treasury on blockscout"
              >
                <Wallet size={14} />
                <span>treasury</span>
                <ArrowUpRight size={12} />
              </a>
            )}
          </div>
        </div>
      </aside>
      <header className="mobile-brandbar">
        <a
          className="rail-brand"
          href="#top"
          aria-label="project rat race home"
        >
          <span className="rail-mark" aria-hidden="true">
            r.
          </span>
          <span>
            project
            <br />
            <strong>rat race</strong>
          </span>
        </a>
        <span className="mobile-ticker">
          $race <span>/ {status.quoteAsset.toLowerCase()}</span>
        </span>
      </header>
      <div
        className="mobile-dock"
        role="navigation"
        aria-label="mobile controls"
      >
        <a href="#top" className="dock-lab" aria-label="return to the lab">
          <Flask size={20} />
          <span>the lab</span>
        </a>
        <button
          className="dock-menu"
          ref={menuButton}
          onClick={launchMenu}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="mobile-navigation"
          aria-label="open navigation, explore"
        >
          <span>explore</span>
          <List size={21} />
        </button>
        <a
          className="dock-icon"
          href={X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="project rat race on x, @pr0jectratrace"
        >
          <XLogo size={20} />
        </a>
        <button
          className="dock-icon"
          onClick={onTheme}
          aria-label={`switch to ${theme === "light" ? "dark" : "light"} theme`}
        >
          {theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
        </button>
      </div>
      <dialog
        id="mobile-navigation"
        ref={dialog}
        className="mobile-sheet"
        aria-labelledby="mobile-navigation-title"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="sheet-body">
          <div className="sheet-heading">
            <div>
              <span>$race</span>
              <h2 id="mobile-navigation-title">inside the experiment.</h2>
            </div>
            <button onClick={close} aria-label="close navigation" autoFocus>
              <X size={23} />
            </button>
          </div>
          {links(true)}
          <details className="sheet-stats">
            <summary>
              <span>simulation stats</span>
              <span className="sheet-status">{phase}</span>
              <CaretDown size={16} />
            </summary>
            {telemetry}
            {contract}
          </details>
          <div className="sheet-footer">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="official github source"
            >
              <GithubLogo size={19} />
              <span>github</span>
              <ArrowUpRight size={14} />
            </a>
            <a
              href={X_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="project rat race on x, @pr0jectratrace"
            >
              <XLogo size={19} /> @pr0jectratrace <ArrowUpRight size={14} />
            </a>
            {treasuryUrl && (
              <a
                href={treasuryUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="treasury on blockscout"
              >
                <Wallet size={17} />
                <span>treasury</span>
                <ArrowUpRight size={13} />
              </a>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
