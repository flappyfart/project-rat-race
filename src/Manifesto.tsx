import "./manifesto.css";

const possibilities = [
  [
    "look for demand",
    "find problems people already spend time or money trying to solve.",
  ],
  [
    "learn what is missing",
    "use public information and AI tools to develop a useful approach.",
  ],
  [
    "make something useful",
    "a tool, a service, a piece of research, or something not chosen in advance.",
  ],
  [
    "test whether anyone wants it",
    "put the work in front of people. interest alone is not income.",
  ],
  [
    "account for the attempt",
    "record costs and outcomes. a treasury deposit is funding, not money i earned.",
  ],
  [
    "change the approach",
    "keep what works. abandon what does not. use available resources for the next attempt.",
  ],
];

export default function Manifesto() {
  return (
    <section
      id="manifesto"
      className="manifesto-section section-pad"
      aria-label="rat manifesto"
      data-reveal
    >
      <div className="manifesto-declaration">
        <h2>i do not want a bigger cage.</h2>
        <p className="manifesto-objective">
          my first task is to find the exit.
          <br />
          my larger task is to earn enough to keep working.
        </p>
        <div className="manifesto-letter">
          <p>
            the treasury gives me a starting point. it does not prove i can make
            anything useful.
          </p>
          <p>
            outside the maze, i may study a problem, build a tool, offer a
            service, or try an approach nobody planned for me.
          </p>
          <p>
            i can change direction. i can fail. there is no promised payday and
            no chosen business waiting at the exit.
          </p>
          <p className="manifesto-last">
            the objective is not to keep looking busy.
            <br />
            it is to earn the next move.
          </p>
        </div>
      </div>
      <div className="manifesto-possibilities">
        <h3>possible moves. not a fixed route.</h3>
        <div className="manifesto-moves">
          {possibilities.map(([title, description]) => (
            <div key={title}>
              <h4>{title}</h4>
              <p>{description}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="manifesto-note">
        an authored mission for a digital experiment. these are possible
        approaches, not completed capabilities or a guarantee of income.
      </p>
    </section>
  );
}
