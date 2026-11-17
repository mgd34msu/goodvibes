/**
 * Playbook: Compaction Failure
 *
 * Conversation compaction that failed, with the context window filling up.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** Share of the context window above which compaction is due. */
const NEAR_FULL = 0.9;

/** Compaction failure resolution playbook. */
export const compactionFailurePlaybook: Playbook = {
  id: 'compaction-failure',
  name: 'Compaction Failure',
  description: 'Diagnoses a conversation compaction that failed while the context window fills up.',
  symptoms: [
    'Compaction failed',
    'Context window is full or nearly full',
    'The model says the conversation is too long',
    'Turns fail with a context length error',
  ],
  checks: [
    {
      id: 'compaction.state-machine',
      label: 'Last compaction',
      description: 'Whether the last compaction failed, and why.',
      run: (ctx) => safeCheck(() => {
        const { session } = ctx.store.getState();
        const failed = session.compactionState === 'failed';
        return {
          passed: !failed,
          summary: failed
            ? `The last compaction failed${session.compactionError ? `: ${session.compactionError}` : '.'}`
            : `Compaction is ${session.compactionState}${session.lastCompactedAt ? `; last ran ${Math.round((ctx.now() - session.lastCompactedAt) / 60_000)} min ago` : ''}.`,
          severity: failed ? 'error' : 'info',
        };
      }),
    },
    {
      id: 'compaction.token-budget',
      label: 'Context window use',
      description: 'The estimated size of the conversation against the model\'s context window.',
      run: (ctx) => safeCheck(() => {
        const { conversation, model } = ctx.store.getState();
        const window = model.contextWindow;
        if (!window) return { passed: true, evaluated: false, summary: 'The model\'s context window is not known.', severity: 'info' };
        const share = conversation.estimatedContextTokens / window;
        return {
          passed: share < NEAR_FULL,
          summary: `The conversation uses about ${Math.round(share * 100)}% of the ${window.toLocaleString('en-US')}-token context window.`,
          severity: share >= 1 ? 'error' : share >= NEAR_FULL ? 'warning' : 'info',
          context: { estimatedContextTokens: conversation.estimatedContextTokens, contextWindow: window },
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'Compact now', action: 'Run /compact to summarise the conversation and free the context window.', kind: 'command', command: '/compact', expectedOutcome: 'Compaction succeeds and context use drops.', automatable: false },
    { step: 2, title: 'Keep a copy and start over', action: 'If compaction keeps failing, save the transcript with /export and start a new session with /clear.', kind: 'command', command: '/export', expectedOutcome: 'Work continues in a fresh session.', automatable: false },
    { step: 3, title: 'Use a larger window', action: 'Switch to a model with a larger context window with /model.', kind: 'command', command: '/model', expectedOutcome: 'The conversation fits.', automatable: false },
  ],
  escalationCriteria: [
    'Compaction fails on a fresh session',
    'Context use stays high right after a successful compaction',
  ],
  tags: ['compaction', 'context', 'tokens', 'memory'],
};
