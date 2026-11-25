/**
 * Playbook: Session Unrecoverable
 *
 * The session could not be restored (its recovery ended in a failed state).
 */
import { existsSync } from 'node:fs';
import type { Playbook } from '../types.js';
import { notTracked, safeCheck } from '../safe-check.js';
import { readRecoveryFileMetadata } from '../runtime-context.js';

/** Session unrecoverable resolution playbook. */
export const sessionUnrecoverablePlaybook: Playbook = {
  id: 'session-unrecoverable',
  name: 'Session Unrecoverable',
  description: 'Diagnoses a session that could not be restored: its recovery failed, or its saved files are missing or unreadable.',
  symptoms: [
    'Session recovery failed',
    'The last session does not come back after a restart',
    'Session state file missing or corrupted',
    'Resume does not restore the conversation',
  ],
  checks: [
    {
      id: 'session.recovery-attempts',
      label: 'Session recovery state',
      description: "The session's own recovery state: failed means it could not be restored.",
      run: (ctx) => safeCheck(() => {
        const { session } = ctx.store.getState();
        const failed = session.recoveryState === 'failed';
        return {
          passed: !failed,
          summary: failed
            ? `Session recovery failed${session.recoveryError ? `: ${session.recoveryError}` : '.'}`
            : `Session recovery state is ${session.recoveryState}.`,
          severity: failed ? 'critical' : 'info',
          context: { recoveryState: session.recoveryState },
        };
      }),
    },
    {
      id: 'session.state-file',
      label: 'Session files readable',
      description: 'Whether the recovery file and the last-session pointer exist and can be read.',
      run: (ctx) => safeCheck(() => {
        const recoveryPath = ctx.recoveryFilePath?.();
        if (!recoveryPath || !ctx.lastSessionPointerPath) return notTracked('The session recovery file');
        const recovery = existsSync(recoveryPath) ? readRecoveryFileMetadata(recoveryPath) : undefined;
        const pointerExists = existsSync(ctx.lastSessionPointerPath);
        // No recovery file is the normal state after a clean exit; an unreadable one is not.
        const passed = (recovery === undefined || recovery.ok) && pointerExists;
        return {
          passed,
          summary: passed
            ? `Last-session pointer present; ${recovery ? 'recovery file readable' : 'no recovery file (clean exit)'}.`
            : `${recovery && !recovery.ok ? recovery.summary : ''}${pointerExists ? '' : ' The last-session pointer is missing.'}`.trim(),
          severity: passed ? 'info' : 'error',
          context: { recoveryFilePresent: recovery !== undefined, lastSessionPointerPresent: pointerExists },
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'Pick the session by hand', action: 'Open the Sessions place: it lists your saved sessions, and Enter on one resumes it here (or /resume with its id).', kind: 'command', command: '/resume', expectedOutcome: 'The conversation is back.', automatable: false },
    { step: 2, title: 'Keep a copy first', action: 'Once a session is open, save its transcript with This conversation, "Save or export this conversation as a file", before trying anything else.', kind: 'observe', expectedOutcome: 'A transcript file exists.', automatable: false },
    { step: 3, title: 'Start fresh', action: 'If the session cannot be opened, start a new one with /clear; the old files stay on disk for review.', kind: 'command', command: '/clear', expectedOutcome: 'A new session starts.', automatable: false },
  ],
  escalationCriteria: [
    'Recovery fails again right after a fresh start',
    'The session files cannot be written (disk full, permission denied)',
  ],
  tags: ['session', 'unrecoverable', 'recovery', 'resume'],
};

/** The session-unrecoverable playbook (kept as a function for callers that build playbooks). */
export function createSessionUnrecoverablePlaybook(): Playbook {
  return sessionUnrecoverablePlaybook;
}
