import type { ShellPathService } from '@/runtime/index.ts';
import { AgentResearchRunRegistry } from '../agent/research-run-registry.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';

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

export function buildAgentResearchRunPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult?: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to create this visible local research run.' },
      status: 'Research run creation not confirmed.',
    };
  }

  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use research action:"create_run" with these fields.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit research run creation from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const args = buildAgentResearchRunToolArgs(
    readField,
    'Create one visible checkpointable local research run.',
  );
  const prompt = [
    'Create this visible checkpointable local research run.',
    'Use the `research` tool with these arguments:',
    'action: "create_run"',
    `title: ${JSON.stringify(args.title)}`,
    `question: ${JSON.stringify(args.question)}`,
    // An unset field is left out, so the tool's own default applies (the goal defaults to the question).
    ...(args.goal ? [`goal: ${JSON.stringify(args.goal)}`] : []),
    ...(args.plan ? [`plan: ${JSON.stringify(args.plan)}`] : []),
    ...(args.nextSteps ? [`nextSteps: ${JSON.stringify(args.nextSteps)}`] : []),
    ...(args.sourceIds ? [`sourceIds: ${JSON.stringify(args.sourceIds)}`] : []),
    ...(args.note ? [`note: ${JSON.stringify(args.note)}`] : []),
    'confirm: true',
    `explicitUserRequest: ${JSON.stringify(args.explicitUserRequest)}`,
    'Policy: local visible run state only; do not perform web research, save a report, ingest Knowledge, or send external messages.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting research run creation request.',
    actionResult: {
      kind: 'guidance',
      title: 'Research run',
      detail: 'Asked the model to create a visible checkpointable local research run. Nothing is created until the model calls the tool and its result appears in the conversation.',
      safety: 'safe',
    },
  };
}

export type AgentResearchRunEditorOutcome =
  | { readonly kind: 'editor'; readonly editor: AgentWorkspaceLocalEditor; readonly status: string; readonly actionResult?: AgentWorkspaceActionResult }
  | { readonly kind: 'created'; readonly runId: string; readonly status: string; readonly actionResult: AgentWorkspaceActionResult };

/**
 * The owner's form creates the run itself, in the same local run ledger the
 * `agent_research_runs` tool writes, with the typed values as they are: no
 * model turn in between. A refusal (a missing title, a store that cannot be
 * written) keeps the form open with the reason so it can be corrected.
 */
export function submitAgentResearchRunEditor(
  shellPaths: Pick<ShellPathService, 'resolveProjectPath'>,
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentResearchRunEditorOutcome {
  if (!isAffirmative(readField('confirm'))) {
    return { kind: 'editor', editor: { ...editor, message: 'Type yes to create this visible local research run.' }, status: 'Research run creation not confirmed.' };
  }
  const args = buildAgentResearchRunToolArgs(readField, 'Created from the Agent workspace research run form.');
  try {
    const run = AgentResearchRunRegistry.fromShellPaths(shellPaths).create({
      title: args.title,
      question: args.question,
      ...(args.goal ? { goal: args.goal } : {}),
      ...(args.plan ? { plan: args.plan } : {}),
      ...(args.nextSteps ? { nextSteps: args.nextSteps } : {}),
      ...(args.sourceIds ? { sourceIds: args.sourceIds } : {}),
      ...(args.note ? { note: args.note } : {}),
      provenance: args.explicitUserRequest,
    });
    return {
      kind: 'created',
      runId: run.id,
      status: `Created research run ${run.id}.`,
      actionResult: {
        kind: 'dispatched',
        title: `Research run ${run.id} created`,
        detail: [
          `id ${run.id}`,
          `title ${run.title}`,
          `status ${run.status}`,
          `plan steps ${run.plan.length}`,
          'Nothing else ran: web research, reports and Knowledge ingest stay separate.',
        ].join('\n'),
        safety: 'safe',
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: 'editor',
      editor: { ...editor, message: `Not created: ${reason}` },
      status: 'Research run not created.',
      actionResult: { kind: 'error', title: 'Research run not created', detail: reason, safety: 'safe' },
    };
  }
}
