import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

/**
 * Settles the tone of the message an editor is about to show, from how the
 * editor reached the workspace rather than from its wording.
 *
 * A form built fresh (no tone yet) shows its own help text: `info`, unless the
 * builder stated a tone. A form derived from a shown one (`{ ...editor, ... }`
 * carries the tone) whose message was rewritten is a submit that did not
 * complete: every completed submit closes the form, so the new message is a
 * refusal, a missing confirmation or a failure and reads `warn`. Typing and
 * moving between fields keep the message and so keep the tone.
 */
export function settleEditorMessageTone(
  previous: AgentWorkspaceLocalEditor | null,
  next: AgentWorkspaceLocalEditor,
): AgentWorkspaceLocalEditor {
  if (next.messageTone === undefined) return { ...next, messageTone: 'info' };
  if (previous && previous.message !== next.message && next.messageTone !== 'warn') return { ...next, messageTone: 'warn' };
  return next;
}
