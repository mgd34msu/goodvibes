import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { noticeSeverity, type NoticeSeverity } from './batteries/notice-severity.js';
import { decisionOrClassic } from '@goodvibes-jev/engine/platform/platform/runtime';

export interface NoticeSeverityReading {
  readonly provenance?: 'classic';
  readonly severity: NoticeSeverity | undefined;
  readonly assertCurrent: () => void;
  /** Record and fence publication immediately before the caller's display effect. */
  readonly recordPublication: () => void;
}

/** Full-input privacy screening precedes port capture, logging and transmission. */
export async function readNoticeSeverity(text: string, options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {}): Promise<NoticeSeverityReading> {
  return decisionOrClassic(() => readDecisionNoticeSeverity(text, options), () => {
    const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    current();
    // Neutral display default only; the notice text still carries its actual outcome.
    return { provenance: 'classic', severity: 'info', assertCurrent: current, recordPublication: current };
  });
}

async function readDecisionNoticeSeverity(text: string, options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'>): Promise<NoticeSeverityReading> {
  snapshotJudgmentInput({ text });
  const owner = captureJudgmentPort('terminal-shell.notice-severity', { ...options, prepareResultCapture: prepareJudgmentResult });
  const run = await noticeSeverity.run(owner.port, { text }, { site: 'terminal-shell.notice-severity', signal: owner.signal });
  owner.assertCurrent();
  const reading = run.readings.severity;
  const severity = reading.outcome === 'act' && reading.choice !== 'unknown' ? reading.choice : undefined;
  if (severity === undefined) { run.recordAction('notice-held'); owner.assertCurrent(); }
  return { severity, assertCurrent: owner.assertCurrent, recordPublication() {
    owner.assertCurrent();
    run.recordAction(severity === undefined ? 'notice-held' : `notice-published:${severity}`);
    owner.assertCurrent();
  } };
}
