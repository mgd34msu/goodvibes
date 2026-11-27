/**
 * run-answerer.ts, who answers the questions this process's run raises.
 *
 * A headless run started with `--answer-permissions` answers its questions from its script: the script is the run's
 * one answerer, for every call the run makes. A call the daemon would otherwise decide itself when it arrives (a
 * natively admitted method, the gate's `hostDecides`) is then decided here, put to the script, and sent saying so, so
 * the daemon does not put it to the owner in Waiting for you a second time. Set once by the run; never by a caller.
 *
 * A headless run with nobody to answer (no person, no script) holds such a call for the owner instead of waiting on
 * the daemon's question: it is decided here like any other call, and one the mode puts to the owner is handed to the
 * daemon's `capabilities.run`, which holds it in Waiting for you and answers at once with the approval it waits as
 * (native/headless-held-calls.ts); the run's result names it (`heldForOwner`) and the run goes on.
 */
let answersEveryQuestion = false;
let holdsForOwner = false;
const changed = new Set<() => void>();

function tell(): void {
  for (const listener of [...changed]) {
    try { listener(); } catch { /* a listener cannot stop the run */ }
  }
}

/** The run answers every question its calls raise (`--answer-permissions`). */
export function setRunAnswersEveryQuestion(on: boolean): void {
  if (answersEveryQuestion === on) return;
  answersEveryQuestion = on;
  tell();
}

/** Whether this process's run answers every question its calls raise. */
export function runAnswersEveryQuestion(): boolean {
  return answersEveryQuestion;
}

/** The run has nobody to answer its questions: what the owner must decide is held for them, never waited on. */
export function setRunHoldsForOwner(on: boolean): void {
  if (holdsForOwner === on) return;
  holdsForOwner = on;
  tell();
}

/** Whether this process's run holds for the owner what it cannot have answered (a headless run nobody answers). */
export function runHoldsForOwner(): boolean {
  return holdsForOwner;
}

/** Told when who answers this run's questions changes; returns the stop. */
export function onRunAnswererChanged(listener: () => void): () => void {
  changed.add(listener);
  return () => { changed.delete(listener); };
}
