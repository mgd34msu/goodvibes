/**
 * The words Automation says about its things, in a person's words: a run's
 * state, a trigger's state, a CI verdict, what a check-in did, and a CI
 * watch's repository as a person writes it. One owner for every surface: the
 * Automation capabilities' answers (automation.ts), the terminal place
 * (terminal-shell places/automation-place.ts) and the web UI's Automation
 * view. No imports, so a browser can load it.
 */

/** A run's state in a person's words. */
export const AUTOMATION_RUN_STATE_WORDS: Readonly<Record<string, string>> = {
  queued: 'waiting to start', running: 'running', completed: 'finished', failed: 'failed', cancelled: 'stopped', missed: 'missed its time',
};

/** A trigger's state in a person's words. */
export const TRIGGER_STATE_WORDS: Readonly<Record<string, string>> = {
  idle: 'watching', running: 'watching a command', backoff: 'waiting after a failure', 'circuit-open': 'gave up after failing again and again',
  firing: 'acting on what it saw', fired: 'done: it acted', cancelled: 'stopped', failed: 'stopped: it failed',
};

/** Trigger states that watch, or wait to watch again: a stop applies to them. */
export const TRIGGER_LIVE_STATES: readonly string[] = ['idle', 'running', 'backoff', 'circuit-open', 'firing', 'failed'];

/** Trigger states of one that gave up: starting it again applies to them. */
export const TRIGGER_GAVE_UP_STATES: readonly string[] = ['circuit-open', 'failed'];

/** A CI verdict in a person's words. */
export const CI_VERDICT_WORDS: Readonly<Record<string, string>> = { passed: 'passed', failed: 'failed', pending: 'still running', unknown: 'not known yet' };

/** A check-in's outcome in a person's words. */
export const CHECKIN_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  delivered: 'told you', partial: 'told you in part', quiet: 'stayed quiet: nothing needed you', 'skipped-disabled': 'skipped: check-ins are off',
  'skipped-quiet-hours': 'skipped: quiet hours', 'skipped-stale': 'skipped: what it read was out of date',
  'skipped-decision-models-disabled': 'skipped: no decision model', cancelled: 'stopped', error: 'failed', skipped: 'skipped',
};

/** What a trigger watches, as the supervisor says it, with an interval in milliseconds said in minutes or hours. */
export function watchingWords(watching: string): string {
  return watching.replace(/every (\d+)ms/g, (_whole, digits: string) => {
    const ms = Number(digits);
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000 === 1 ? 'hour' : `${ms / 3_600_000} hours`}`;
    if (ms % 60_000 === 0) return `every ${ms / 60_000 === 1 ? 'minute' : `${ms / 60_000} minutes`}`;
    return `every ${Math.round(ms / 1000)} seconds`;
  });
}

/** `owner/repo`, `owner/repo#123` (a pull request) or `owner/repo@ref` (a branch, tag or commit), from a CI report or watch. */
export function ciTargetText(target: Readonly<Record<string, unknown>>): string {
  const repo = typeof target['repo'] === 'string' ? target['repo'] : '';
  const pr = typeof target['prNumber'] === 'number' && Number.isFinite(target['prNumber']) ? target['prNumber'] : undefined;
  const ref = typeof target['ref'] === 'string' ? target['ref'] : '';
  return pr !== undefined ? `${repo}#${pr}` : ref ? `${repo}@${ref}` : repo;
}
