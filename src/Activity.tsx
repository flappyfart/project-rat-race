import { useEffect, useState } from "react";
import "./Activity.css";
export type ActivityTelemetry = {
  version: number;
  observedAt: string | null;
  since: string | null;
  stage: string;
  tool: string | null;
  intent: string | null;
  nextAt: string | null;
  workspace: {
    count: number;
    names: string[];
    completeNames: boolean;
    observedAt: string | null;
  } | null;
};
export type ActivityEvent = {
  type: string;
  detail: string;
  at: string | null;
  outcome?: string;
  intent?: string | null;
  files?: string[];
};
export function useActivityClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function activityAge(at: string | null | undefined, now: number) {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms)
    ? `${Math.max(0, Math.floor((now - ms) / 1000))}s ago`
    : "time unavailable";
}
export function ActivityFrame({
  url,
  title,
  reason,
  label,
  at,
  now,
  onError,
}: {
  url: string;
  title: string | null;
  reason: string | null;
  label: string;
  at: string | null;
  now: number;
  onError: () => void;
}) {
  return (
    <div className="browser-frame-wrap">
      <img
        key={url}
        className="browser-capture"
        src={url}
        alt={`recorded browser page: ${title ?? "untitled page"}`}
        onError={onError}
      />
      {reason && (
        <div className="browser-frame-overlay">
          <strong>{label}. not live</strong>
          <p>{reason}</p>
          <time>
            last frame: {at ?? "unknown"}. {activityAge(at, now)}
          </time>
        </div>
      )}
    </div>
  );
}
const stages: Record<string, string> = {
  thinking: "planning / inference",
  working: "selected tool executing",
  resting: "waiting for next cycle",
  waiting_for_credits: "waiting for verified AI credits",
  checking_credits: "checking AI credit admission",
  paused: "paused",
  locked: "locked",
  error: "error / retry pending",
};
export default function Activity({
  phase,
  reason,
  cycles,
  activity,
  events,
  unavailable,
}: {
  phase: string;
  reason: string;
  cycles?: number;
  activity?: ActivityTelemetry;
  events: ActivityEvent[];
  unavailable?: string;
}) {
  const now = useActivityClock(),
    fresh =
      !!activity?.observedAt &&
      Number.isFinite(Date.parse(activity.observedAt)) &&
      now - Date.parse(activity.observedAt) < 20000;
  const next = activity?.nextAt ? Date.parse(activity.nextAt) : NaN;
  return (
    <div className="agent-activity" aria-label="AI agent activity">
      <h3>
        {unavailable
          ? "activity connection unavailable"
          : !activity
            ? "detailed activity unavailable"
            : !fresh
              ? "activity record stale"
              : (stages[phase] ?? phase)}
      </h3>
      <p>
        {unavailable ??
          (activity
            ? reason
            : ["paused", "locked", "waiting_for_credits", "error"].includes(
                  phase,
                )
              ? reason
              : "this worker does not provide detailed telemetry. legacy planner text is not evidence of current work.")}
      </p>
      <div className="activity-facts">
        <span>
          completed cycles <strong>{cycles ?? "unavailable"}</strong>
        </span>
        <span>
          record age <strong>{activityAge(activity?.observedAt, now)}</strong>
        </span>
      </div>
      {activity && (
        <>
          <p className="small-note">
            state since {activity.since ?? "unavailable"}.{" "}
            {activityAge(activity.since, now)}
          </p>
          {fresh && !unavailable && phase === "working" && activity.tool && (
            <p>
              selected tool: <code>{activity.tool}</code>
            </p>
          )}
          {activity.intent && (
            <p className="activity-intent">
              planner intent. not a verified accomplishment: {activity.intent}
            </p>
          )}
          <p>
            next eligible attempt:{" "}
            {Number.isFinite(next)
              ? `${activity.nextAt}. ${next > now ? `in ${Math.ceil((next - now) / 1000)}s` : "due; awaiting worker / gate"}`
              : "not scheduled while active or locked"}
            . timing is not a promise; authorization and credit gates still
            apply.
          </p>
          {activity.workspace && (
            <p>
              last observed workspace: {activity.workspace.count} files.{" "}
              {activityAge(activity.workspace.observedAt, now)}.{" "}
              {activity.workspace.completeNames
                ? "safe names"
                : "recently written safe names (partial)"}
              : {activity.workspace.names.join(", ") || "withheld"}. contents
              are not public.
            </p>
          )}
        </>
      )}
      <h4>recent tool outcomes</h4>
      {activity?.version === 1 ? (
        events
          .slice(-8)
          .reverse()
          .map((e, i) => (
            <article className="activity-event" key={`${e.at}-${i}`}>
              <time>
                {e.at ?? "time unavailable"}. {activityAge(e.at, now)}
              </time>
              <strong>
                {e.type}. {e.outcome ?? "unclassified"}
              </strong>
              <p>{e.detail}</p>
              {!!e.files?.length && <small>{e.files.join(", ")}</small>}
              {e.intent && (
                <details>
                  <summary>planner intent. not verified work</summary>
                  <p>{e.intent}</p>
                </details>
              )}
            </article>
          ))
      ) : (
        <p>
          verified outcome telemetry unavailable from this worker. legacy
          summaries are intentionally not shown as results.
        </p>
      )}
      {activity && events.length === 0 && <p>no recorded tool outcomes.</p>}
      <p className="small-note">
        AI research and workspace tools are separate from the independent
        wikipedia sensory browser. generated work is not proof of income.
      </p>
    </div>
  );
}
