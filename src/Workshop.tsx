import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  LockKey,
  Code,
  Brain,
  ShieldCheck,
  DownloadSimple,
} from "@phosphor-icons/react";
import type { Status } from "./types";
type WorkshopState = {
  phase: string;
  reason: string;
  escapeVerified: boolean;
  aiConfigured: boolean;
  topupsEnabled: boolean;
  approvalMode: string;
  executionStatus: string;
  projects: Array<{
    id: string;
    kind: string;
    summary: string;
    files: string[];
    url?: string;
  }>;
  events: Array<{ type: string; detail: string; at: string }>;
};
const empty: WorkshopState = {
  phase: "locked",
  reason: "awaiting verified launch and maze exit",
  escapeVerified: false,
  aiConfigured: false,
  topupsEnabled: false,
  approvalMode: "mission",
  executionStatus: "not_connected",
  projects: [],
  events: [],
};
export default function Workshop({ status }: { status: Status }) {
  const [state, setState] = useState(empty);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const r = await fetch("/api/workshop", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (!Array.isArray(d.projects) || !Array.isArray(d.events))
          throw new Error();
        if (active) setState(d);
      } catch {
        if (active && !abort.signal.aborted)
          setState({
            ...empty,
            reason: "workshop connection unavailable. actions remain locked.",
          });
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  const exportState = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "rat-race-workshop.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section id="beyond" className="beyond-section section-pad" data-reveal>
      <div className="beyond-heading">
        <h2>
          the first exit
          <br />
          is not freedom.
        </h2>
        <p>
          outside the maze, the experiment attempts something harder: building
          work that can pay for its own compute.
        </p>
      </div>
      <div className="escape-sequence">
        <span className={status.experimentPhase === "maze" ? "current" : ""}>
          <Brain size={18} /> learn the maze
        </span>
        <ArrowRight size={17} />
        <span className={state.escapeVerified ? "current" : ""}>
          <ShieldCheck size={18} /> verify the exit
        </span>
        <ArrowRight size={17} />
        <span className={state.projects.length ? "current" : ""}>
          <Code size={18} /> build beyond it
        </span>
      </div>
      <div className="workshop-grid">
        <div className="escape-proof">
          <div className="workshop-label">
            <ShieldCheck size={18} /> exit record
          </div>
          <h3>
            {state.escapeVerified
              ? "an exit, recorded."
              : "no date. no countdown."}
          </h3>
          <p>
            {state.escapeVerified
              ? "the full route is recorded. the navigation state is preserved."
              : "the first successful path opens the workshop. time spent in the maze does not qualify."}
          </p>
          <dl>
            <div>
              <dt>verified escape</dt>
              <dd>{state.escapeVerified ? "recorded" : "not yet"}</dd>
            </div>
            <div>
              <dt>funding</dt>
              <dd>experiment treasury</dd>
            </div>
            <div>
              <dt>earned income</dt>
              <dd>not established</dd>
            </div>
          </dl>
          <a
            className="inline-link"
            href="/api/escape"
            target="_blank"
            rel="noreferrer"
          >
            inspect exit evidence <ArrowUpRight size={15} />
          </a>
        </div>
        <div className="workshop-desk">
          <div className="workshop-label">
            <Code size={18} /> external AI workshop{" "}
            <button aria-label="download workshop record" onClick={exportState}>
              <DownloadSimple size={17} />
            </button>
          </div>
          <div className="workshop-status">
            <LockKey size={28} />
            <h3>
              {state.projects.length
                ? "work in progress."
                : "the work starts outside."}
            </h3>
            <p>{state.reason}</p>
          </div>
          <div className="workshop-metrics">
            <div>
              <span>work previews</span>
              <strong>{state.projects.length}</strong>
            </div>
            <div>
              <span>AI access</span>
              <strong>{state.aiConfigured ? "configured" : "not armed"}</strong>
            </div>
            <div>
              <span>credit purchases</span>
              <strong>{state.topupsEnabled ? "enabled" : "not armed"}</strong>
            </div>
            <div>
              <span>mission</span>
              <strong>open ended</strong>
            </div>
          </div>
          {state.projects.length > 0 && (
            <div className="project-records">
              {state.projects.map((project) => (
                <article key={project.id}>
                  <span>{"work product"}</span>
                  <p>{project.summary}</p>
                  <small>
                    {project.files.length} files. generated work is not proof of
                    income.
                  </small>
                  {project.url && (
                    <a
                      className="inline-link"
                      href={project.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      inspect work <ArrowUpRight size={14} />
                    </a>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="workshop-boundary">
        after escape, the mission is to earn enough to fund continued work. the
        approach is not prescribed. actions stay within dedicated resources. the
        runtime supports research, isolated code execution and
        verification-gated previews. compute refills are automatic while launch
        authorization is active. deposits are funding, not profit.
      </p>
    </section>
  );
}
