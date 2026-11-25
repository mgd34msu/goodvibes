/**
 * Handing coding work on (Work and agents), home `daemon`. The daemon makes a
 * shared session on itself, puts the work in it as the first message (which
 * asks before it changes anything), and keeps the record of the hand-off in
 * its own store (`<daemon home>/handed-off.json`), so the hand-off and its
 * progress are seen from every program. Until this version the Agent kept the
 * record in its own home (`~/.goodvibes/agent/delegations/delegations.json`);
 * the daemon carries those into its store once (agent-turn/agent-store-handoff.ts).
 */
import type { ListName } from '../types.js';
import { fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** The hand-offs a form chooses from (terminal-shell agents-command.ts reads the daemon's). */
export const AGENTS_HANDED_OFF_LIST = 'agents.handed-off' as ListName;

export const AGENTS_HAND_OFF = storeCapability({
  id: 'agents.hand-off', group: 'work', actionId: 'hand-off', label: 'Hand coding work to the terminal app', word: 'hand-off',
  inputs: [
    wordsInput({ id: 'task', label: 'The work', help: 'What to build, fix or review, in full', why: 'your own words for the work', kind: 'long-text', typed: { tail: true } }),
    fixedInput({ id: 'review', label: 'Reviewed', help: 'Whether the terminal app has its work reviewed', choices: [{ value: 'no', label: 'No review asked' }, { value: 'yes', label: 'Review the work too' }], typed: { flag: '--review', switchOn: 'yes' }, optional: { default: 'no', means: 'no review asked' } }),
    wordsInput({ id: 'reason', label: 'Why', help: 'Why it goes to the terminal app', why: 'your own words', typed: { flag: '--reason' }, optional: { default: '', means: 'not given' } }),
    wordsInput({ id: 'success', label: 'Done when', help: 'What shows the work is right', why: 'your own words', typed: { flag: '--success' }, optional: { default: '', means: 'not given' } }),
    wordsInput({ id: 'workspace', label: 'Where', help: 'A project, folder or worktree to work in', why: 'a name or path', typed: { flag: '--workspace' }, optional: { default: '', means: 'not given' } }),
    wordsInput({ id: 'priority', label: 'Priority', help: 'How soon, or a deadline', why: 'your own words', typed: { flag: '--priority' }, optional: { default: '', means: 'not given' } }),
  ],
  sentence: '"{task}" goes to the terminal app as a new shared session on the daemon, which asks before it changes anything; the hand-off is kept in Handed off.',
  example: { task: 'fix the failing upload test', review: 'yes' },
});

export const AGENTS_HANDED_OFF = storeRead({
  id: 'agents.handed-off', group: 'work', actionId: 'handed-off', label: 'See work you handed off', word: 'handed-off',
  inputs: [pickedInput({ id: 'session', label: 'Hand-off', help: 'Work you handed to the terminal app, newest first', list: AGENTS_HANDED_OFF_LIST, other: 'a session id', optional: { default: '', means: 'all of them' } })],
  sentence: 'Shows the work you handed off {session}, with its session, whether it was taken, and its latest answer.',
  example: { session: 'session-1a2b' },
});

export const HANDED_OFF_CAPABILITIES = [AGENTS_HAND_OFF, AGENTS_HANDED_OFF];
