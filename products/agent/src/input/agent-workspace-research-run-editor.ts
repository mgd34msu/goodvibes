import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentResearchRunWorkspaceToolArgs {
  readonly mode: 'create';
  readonly title: string;
  readonly question: string;
  readonly goal?: string;
  readonly plan?: readonly string[];
  readonly nextSteps?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly note?: string;
  readonly confirm: true;
  readonly explicitUserRequest: string;
}

/** One entry per line; a step may itself contain commas. */
function splitLines(value: string): readonly string[] {
  return value
    .split('\n')
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

/** Source ids: one per line or comma-separated. */
function splitIds(value: string): readonly string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

export function createAgentResearchRunEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'research-run',
    mode: 'create',
    title: 'Start Research Run',
    selectedFieldIndex: 0,
    message: 'Create a visible checkpointable research run. This records local run state only; web research, source review, reports, and Knowledge ingest stay separate.',
    fields: [
      { id: 'title', label: 'Title', value: '', required: true, multiline: false, hint: 'Short name for this research run.' },
      { id: 'question', label: 'Question', value: '', required: true, multiline: true, hint: 'Research question the run should answer.' },
      { id: 'goal', label: 'Goal', value: '', required: false, multiline: true, hint: 'User-visible outcome. Defaults to the question.' },
      { id: 'plan', label: 'Plan', value: '', required: false, multiline: true, hint: 'One research step per line. Ctrl-J inserts a new line.' },
      { id: 'nextSteps', label: 'Next steps', value: '', required: false, multiline: true, hint: 'Immediate next actions, one per line, to keep the run resumable.' },
      { id: 'sourceIds', label: 'Source ids', value: '', required: false, multiline: false, hint: 'Optional comma-separated local source ids already known.' },
      { id: 'note', label: 'Note', value: '', required: false, multiline: true, hint: 'Optional context, caveat, or initial checkpoint note.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to create the visible local run.' },
    ],
  };
}

export function buildAgentResearchRunToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentResearchRunWorkspaceToolArgs {
  const goal = readField('goal').trim();
  const plan = splitLines(readField('plan'));
  const nextSteps = splitLines(readField('nextSteps'));
  const sourceIds = splitIds(readField('sourceIds'));
  const note = readField('note').trim();
  return {
    mode: 'create',
    title: readField('title').trim(),
    question: readField('question').trim(),
    ...(goal ? { goal } : {}),
    ...(plan.length > 0 ? { plan } : {}),
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(note ? { note } : {}),
    confirm: true,
    explicitUserRequest,
  };
}
