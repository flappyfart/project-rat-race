import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChatCircle,
  ArrowRight,
  Trash,
  ArrowClockwise,
  LockKey,
} from "@phosphor-icons/react";
import "./rat-chat.css";

type Turn = { role: "user" | "assistant"; content: string };
type Payload = { requestId: string; message: string; history: Turn[] };
const STORAGE = "rr-rat-chat-tab-v1";
const MAX_CHARS = 1200;
const MAX_REPLY = 2400;
const MAX_HISTORY = 6;
const questions = [
  "what are you working on?",
  "what changed after the maze?",
  "what can you remember?",
];
function restore(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (!raw || raw.length > 24000) return [];
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > MAX_HISTORY ||
      value.length % 2 !== 0
    )
      return [];
    if (
      !value.every(
        (t, i) =>
          t &&
          t.role === (i % 2 ? "assistant" : "user") &&
          typeof t.content === "string" &&
          t.content.trim().length > 0 &&
          t.content.length <= (t.role === "assistant" ? MAX_REPLY : MAX_CHARS),
      )
    )
      return [];
    return value.map((t) => ({ role: t.role, content: t.content }));
  } catch {
    return [];
  }
}

export default function RatChat() {
  const [history, setHistory] = useState<Turn[]>(restore);
  const [draft, setDraft] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Payload | null>(null);
  const [retry, setRetry] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const postAbort = useRef<AbortController | null>(null);
  const getAbort = useRef<AbortController | null>(null);
  const lastCheck = useRef(0);

  const checkAvailability = useCallback(async () => {
    if (getAbort.current || Date.now() - lastCheck.current < 10000) return;
    lastCheck.current = Date.now();
    const controller = new AbortController();
    getAbort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/rat-chat", {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (mounted.current)
        setAvailable(
          response.ok && data.available === true && data.readOnly === true,
        );
    } catch {
      if (mounted.current) setAvailable(false);
    } finally {
      clearTimeout(timeout);
      getAbort.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void checkAvailability();
        observer.disconnect();
      }
    });
    if (section.current) observer.observe(section.current);
    return () => {
      mounted.current = false;
      observer.disconnect();
      postAbort.current?.abort();
      getAbort.current?.abort();
    };
  }, [checkAvailability]);
  useEffect(() => {
    try {
      if (history.length)
        sessionStorage.setItem(STORAGE, JSON.stringify(history));
      else sessionStorage.removeItem(STORAGE);
    } catch {
      setNotice(
        "tab storage is unavailable. history will last only until this page reloads.",
      );
    }
  }, [history]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [history, pending]);

  async function send(existing?: Payload) {
    const message = draft.trim();
    if (
      busy.current ||
      (!existing &&
        (!message || message.length > MAX_CHARS || available !== true))
    )
      return;
    let payload: Payload;
    try {
      payload = existing ?? {
        requestId: crypto.randomUUID(),
        message,
        history: history
          .slice(-MAX_HISTORY)
          .map((t) => ({
            role: t.role,
            content: t.content.slice(0, MAX_CHARS),
          })),
      };
    } catch {
      setError(
        "secure chat is unavailable in this browser. use a secure connection and try again.",
      );
      return;
    }
    busy.current = true;
    setPending(payload);
    setRetry(null);
    setError("");
    setNotice("");
    const controller = new AbortController();
    postAbort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch("/api/rat-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const seconds = data?.error?.retryAfterSeconds;
        const wait =
          typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
            ? ` try again after ${Math.ceil(seconds)} seconds.`
            : " please try again later.";
        if (response.status === 429 && data?.error?.code === "budget_exhausted")
          throw new Error(
            "the daily chat allowance is unavailable. it renews at the next utc day.",
          );
        if (response.status === 429)
          throw new Error(
            (data?.error?.code === "busy"
              ? "chat is busy while the experiment works."
              : "the chat has reached its request limit.") + wait,
          );
        if (response.status === 503) {
          setAvailable(false);
          throw new Error(
            "chat is temporarily unavailable. the experiment is unaffected. retry when the service returns.",
          );
        }
        if (response.status === 409)
          throw Object.assign(
            new Error(
              "the previous reply cannot be recovered. sending again starts a new request.",
            ),
            { noRetry: true },
          );
        throw new Error(
          "the chat could not complete this request. you can explicitly retry.",
        );
      }
      if (
        !data ||
        data.requestId !== payload.requestId ||
        data.mode !== "read_only" ||
        typeof data.reply !== "string" ||
        !data.reply.trim() ||
        data.reply.length > MAX_REPLY ||
        typeof data.snapshotAt !== "string" ||
        !Number.isFinite(Date.parse(data.snapshotAt))
      ) {
        throw new Error(
          "the chat returned an unreadable response. you can retry the same request.",
        );
      }
      if (!mounted.current) return;
      setHistory((previous) =>
        [
          ...previous,
          { role: "user" as const, content: payload.message },
          { role: "assistant" as const, content: data.reply },
        ].slice(-MAX_HISTORY),
      );
      setSnapshot(data.snapshotAt);
      setDraft("");
      setAvailable(true);
    } catch (e) {
      if (!mounted.current) return;
      setRetry(e && typeof e === "object" && "noRetry" in e ? null : payload);
      setError(
        controller.signal.aborted
          ? "the reply took too long. retry reuses this request, rather than starting another."
          : e instanceof TypeError
            ? "the connection was interrupted. retry reuses the exact request."
            : e instanceof Error
              ? e.message
              : "chat connection unavailable. please retry.",
      );
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      postAbort.current = null;
      if (mounted.current) setPending(null);
    }
  }
  function edit(value: string) {
    setDraft(value);
    setRetry(null);
    setError("");
    setNotice("");
  }
  function clearHistory() {
    if (busy.current) return;
    setHistory([]);
    setDraft("");
    setRetry(null);
    setError("");
    setSnapshot("");
    setNotice("history cleared from this tab.");
    input.current?.focus();
  }
  return (
    <section
      id="talk"
      className="rat-chat section-pad"
      ref={section}
      aria-labelledby="rat-chat-title"
    >
      <div className="rat-chat-heading">
        <h2 id="rat-chat-title">talk to the rat.</h2>
        <p>
          an ai voice grounded in the experiment.
          <br />
          chat cannot control the run.
        </p>
      </div>
      <div className="rat-chat-console">
        <header className="rat-chat-bar">
          <span>
            <ChatCircle size={20} aria-hidden="true" /> conversation
          </span>
          <button
            type="button"
            onClick={clearHistory}
            disabled={!!pending || (!history.length && !draft && !retry)}
          >
            <Trash size={16} aria-hidden="true" /> clear history
          </button>
        </header>
        <div
          ref={log}
          className="rat-chat-log"
          role="log"
          aria-label="conversation with the rat"
          aria-live="polite"
          tabIndex={0}
        >
          {!history.length && !pending && (
            <div className="rat-chat-empty">
              <span className="rat-chat-mark" aria-hidden="true">
                r.
              </span>
              <h3>the experiment has a voice.</h3>
              <p>
                ask about the maze, the work, or the record.
                <br />
                the conversation starts with you.
              </p>
            </div>
          )}
          {history.map((turn, i) => (
            <article className={"rat-chat-turn " + turn.role} key={i}>
              <span>{turn.role === "user" ? "you" : "rat / ai"}</span>
              <p>{turn.content}</p>
            </article>
          ))}
          {pending && (
            <article className="rat-chat-turn user">
              <span>you</span>
              <p>{pending.message}</p>
            </article>
          )}
        </div>
        <div className="rat-chat-status" role="status">
          {pending
            ? "waiting for the rat. the run continues independently."
            : notice ||
              (available === true
                ? "read-only chat available"
                : available === false
                  ? "chat is currently unavailable. the experiment is unaffected."
                  : "chat availability has not been confirmed.")}
        </div>
        {!history.length && (
          <div className="rat-chat-questions" aria-label="suggested questions">
            {questions.map((question) => (
              <button
                key={question}
                type="button"
                disabled={!!pending}
                onClick={() => {
                  edit(question);
                  input.current?.focus();
                }}
              >
                {question}
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <form
          className="rat-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(retry ?? undefined);
          }}
        >
          <label htmlFor="rat-chat-message">your question</label>
          <textarea
            id="rat-chat-message"
            ref={input}
            value={draft}
            maxLength={MAX_CHARS}
            rows={3}
            disabled={!!pending}
            placeholder="ask the rat…"
            aria-describedby="rat-chat-help rat-chat-privacy"
            onFocus={() => void checkAvailability()}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="rat-chat-actions">
            <span id="rat-chat-help">
              enter to send / shift + enter for a new line
              <span>
                {draft.length} / {MAX_CHARS}
              </span>
            </span>
            <button
              className="rat-chat-send"
              type="submit"
              disabled={
                !!pending || (!retry && (available !== true || !draft.trim()))
              }
            >
              {pending ? "waiting" : retry ? "retry request" : "send"}
              {retry ? (
                <ArrowClockwise size={18} aria-hidden="true" />
              ) : (
                <ArrowRight size={18} aria-hidden="true" />
              )}
            </button>
          </div>
          {error && (
            <p className="rat-chat-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <footer className="rat-chat-foot">
          <span>
            <LockKey size={14} aria-hidden="true" /> read-only
          </span>
          {snapshot && (
            <time dateTime={snapshot}>
              snapshot {new Date(snapshot).toLocaleString()}
            </time>
          )}
          {available === false && !pending && (
            <button
              type="button"
              onClick={() => {
                lastCheck.current = 0;
                void checkAvailability();
              }}
            >
              check availability <ArrowClockwise size={15} aria-hidden="true" />
            </button>
          )}
        </footer>
      </div>
      <p id="rat-chat-privacy" className="rat-chat-privacy">
        messages and recent chat history go to the model provider. avoid sharing
        private information. only the last six messages are kept in this tab for
        context. this is not a biological brain or a connection to the agent’s
        persistent memory. questions do not become instructions to the
        autonomous agent. clearing history removes the local copy, not provider
        records.
      </p>
    </section>
  );
}
