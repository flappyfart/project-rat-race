import { memo, useEffect, useRef } from "react";
import "./arrival.css";

const LINES = [
  ["the", "market"],
  ["is", "the", "maze."],
];
const REDUCED = "(prefers-reduced-motion: reduce)";
const INTERRUPT = "rr:arrival-interrupted";
const isDeepLink = () =>
  Boolean(location.hash && !["#top", "#main"].includes(location.hash));

// Presentation only. No experiment clock, learning state, network or wallet access.
export const ArrivalReveal = memo(function ArrivalReveal() {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement,
      media = matchMedia(REDUCED);
    let detach = () => {};
    const stop = () => {
      detach();
      root.classList.remove("rr-arriving");
      root.dataset.arrivalState = "complete";
      if (layer.current) layer.current.hidden = true;
    };
    if (
      media.matches ||
      isDeepLink() ||
      document.visibilityState === "hidden"
    ) {
      stop();
      return;
    }
    root.dataset.arrivalState = "opening";
    root.classList.add("rr-arriving");
    if (layer.current) layer.current.hidden = false;
    const interrupt = () => {
      stop();
      window.dispatchEvent(new Event(INTERRUPT));
    };
    const reduce = () => {
      if (media.matches) interrupt();
    };
    const timer = window.setTimeout(stop, 1700);
    const options = { capture: true, passive: true };
    for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
      window.addEventListener(event, interrupt, options);
    detach = () => {
      for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
        window.removeEventListener(event, interrupt, true);
    };
    media.addEventListener("change", reduce);
    window.addEventListener("pagehide", interrupt);
    return () => {
      clearTimeout(timer);
      stop();
      for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
        window.removeEventListener(event, interrupt, true);
      media.removeEventListener("change", reduce);
      window.removeEventListener("pagehide", interrupt);
    };
  }, []);
  return (
    <div className="arrival-reveal" ref={layer} hidden aria-hidden="true">
      <div className="arrival-door arrival-door-left" />
      <div className="arrival-door arrival-door-right" />
      <div className="arrival-brand">
        <div className="arrival-brand-inner">
          <span className="arrival-monogram">r.</span>
          <span className="arrival-wordmark">project rat race</span>
        </div>
      </div>
    </div>
  );
});

// Shuffle only the unresolved letters of each word. Punctuation never moves.
function shuffled(word: string, progress: number) {
  const source = [...word],
    positions = source.flatMap((c, i) => (/[a-z]/.test(c) ? [i] : []));
  const count = Math.floor(
    Math.max(0, Math.min(1, progress)) * positions.length,
  );
  const suffix = positions.slice(count).map((i) => source[i]);
  for (let i = suffix.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [suffix[i], suffix[j]] = [suffix[j], suffix[i]];
  }
  positions.slice(count).forEach((position, i) => {
    source[position] = suffix[i];
  });
  return source.join("");
}

export const KineticHeadline = memo(function KineticHeadline() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = heading.current;
    if (!element) return;
    const media = matchMedia(REDUCED),
      inks = [...element.querySelectorAll<HTMLElement>("[data-shuffle-word]")];
    const words = inks.map((ink) => ink.dataset.shuffleWord!);
    let frame = 0,
      startTimer = 0,
      active = false,
      disposed = false,
      lastTick = -1,
      started = 0,
      lastFinish = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      clearTimeout(startTimer);
      active = false;
      inks.forEach((ink, i) => {
        ink.textContent = words[i];
      });
      element.dataset.shuffleState = "settled";
      lastFinish = performance.now();
    };
    const tick = (now: number) => {
      if (disposed) return;
      const elapsed = now - started;
      if (elapsed >= 1150) {
        settle();
        return;
      }
      if (now - lastTick >= 65) {
        lastTick = now;
        inks.forEach((ink, i) => {
          const progress = (elapsed - 180 - i * 65) / 650;
          ink.textContent =
            progress >= 1 ? words[i] : shuffled(words[i], progress);
        });
      }
      frame = requestAnimationFrame(tick);
    };
    const play = () => {
      if (disposed || media.matches || active) return;
      if (document.visibilityState === "hidden") {
        settle();
        return;
      }
      active = true;
      started = performance.now();
      lastTick = -1;
      element.dataset.shuffleState = "shuffling";
      inks.forEach((ink, i) => {
        ink.textContent = shuffled(words[i], 0);
      });
      frame = requestAnimationFrame(tick);
    };
    const reduce = () => {
      if (media.matches) settle();
    };
    const hide = () => {
      if (document.visibilityState === "hidden") settle();
    };
    const hover = () => {
      if (
        document.documentElement.dataset.arrivalState === "complete" &&
        matchMedia("(hover: hover) and (pointer: fine)").matches &&
        performance.now() - lastFinish > 2000
      )
        play();
    };
    window.addEventListener(INTERRUPT, settle);
    document.addEventListener("visibilitychange", hide);
    media.addEventListener("change", reduce);
    element.addEventListener("pointerenter", hover);
    if (media.matches || isDeepLink()) settle();
    else {
      element.dataset.shuffleState = "waiting";
      startTimer = window.setTimeout(play, 470);
    }
    return () => {
      disposed = true;
      settle();
      window.removeEventListener(INTERRUPT, settle);
      document.removeEventListener("visibilitychange", hide);
      media.removeEventListener("change", reduce);
      element.removeEventListener("pointerenter", hover);
    };
  }, []);
  return (
    <h1
      className="kinetic-headline"
      ref={heading}
      aria-label="the market is the maze."
    >
      {LINES.map((words, line) => (
        <span className="kinetic-line" aria-hidden="true" key={line}>
          {words.map((word, index) => (
            <span key={index}>
              {index > 0 ? " " : null}
              <span className="shuffle-word">
                <span className="shuffle-measure">{word}</span>
                <span className="shuffle-ink" data-shuffle-word={word}>
                  {word}
                </span>
              </span>
            </span>
          ))}
        </span>
      ))}
    </h1>
  );
});
