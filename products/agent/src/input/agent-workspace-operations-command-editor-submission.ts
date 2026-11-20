import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import { isAgentWorkspaceOperationsCommandEditorKind } from './agent-workspace-operations-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceOperationsCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message);
}

function optionalNoteArgs(value: string): string {
  const trimmed = value.trim();
  return trimmed ? ` --note ${quoteSlashCommandArg(trimmed)}` : '';
}

function optionalRememberArgs(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isAffirmative(trimmed) ? ' --remember' : ' --no-remember';
}

function optionalCommandArg(flag: string, value: string): string {
  const trimmed = value.trim();
  return trimmed ? ` ${flag} ${quoteSlashCommandArg(trimmed)}` : '';
}

export function isAgentWorkspaceOperationsCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceOperationsCommandEditorKind {
  return isAgentWorkspaceOperationsCommandEditorKind(kind);
}

const OPERATIONS_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceOperationsCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'approval-approve': (editor, readField) => approvalAction(editor, readField),
  'approval-deny': (editor, readField) => approvalAction(editor, readField),
  'approval-cancel': (editor, readField) => approvalAction(editor, readField),
  'automation-job-run': (editor, readField) => automationAction(editor, readField),
  'automation-job-pause': (editor, readField) => automationAction(editor, readField),
  'automation-job-resume': (editor, readField) => automationAction(editor, readField),
  'automation-run-cancel': (editor, readField) => automationAction(editor, readField),
  'automation-run-retry': (editor, readField) => automationAction(editor, readField),
  'routine-receipt': (editor, readField) => receiptInspection(editor, readField),
  'schedule-receipt': (editor, readField) => receiptInspection(editor, readField),
  'health-repair': (editor, readField) => approvalHealthShow(editor, readField),
  'approval-review': (editor, readField) => approvalHealthShow(editor, readField),
};

function approvalAction(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Approval action not confirmed. Type yes, then press Enter.');
  const verb = editor.kind.replace('approval-', '');
  const command = `/approval ${verb} ${quoteSlashCommandArg(readField('approvalId'))}${optionalNoteArgs(readField('note'))}${optionalRememberArgs(readField('remember'))} --yes`;
  const title = `${verb[0]?.toUpperCase() ?? ''}${verb.slice(1)} approval`;
  return dispatchCommandEditorSubmission(
    command,
    title,
    'The workspace handed an explicit confirmed approval action to the shell-owned command router.',
    'safe',
  );
}

function automationAction(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Automation action not confirmed. Type yes, then press Enter.');
  const command = editor.kind === 'automation-job-run'
    ? `/automation job run ${quoteSlashCommandArg(readField('jobId'))} --yes`
    : editor.kind === 'automation-job-pause'
      ? `/automation job pause ${quoteSlashCommandArg(readField('jobId'))} --yes`
      : editor.kind === 'automation-job-resume'
        ? `/automation job resume ${quoteSlashCommandArg(readField('jobId'))} --yes`
        : editor.kind === 'automation-run-cancel'
          ? `/automation run cancel ${quoteSlashCommandArg(readField('runId'))} --yes`
          : editor.kind === 'automation-run-retry'
            ? `/automation run retry ${quoteSlashCommandArg(readField('runId'))} --yes`
            : `/automation schedule run ${quoteSlashCommandArg(readField('scheduleId'))} --yes`;
  return dispatchCommandEditorSubmission(
    command,
    'Opening confirmed automation action',
    'The workspace handed an explicit connected-host automation action to the shell-owned command router.',
    'safe',
  );
}

function receiptInspection(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  // A schedule receipt is the receipt of a promoted routine: /routines keeps both.
  const routine = editor.kind === 'routine-receipt';
  const command = `/routines receipt ${quoteSlashCommandArg(readField('receiptId'))}`;
  const title = routine ? 'Opening routine receipt' : 'Opening schedule receipt';
  return dispatchCommandEditorSubmission(
    command,
    title,
    routine
      ? 'The workspace handed read-only routine receipt inspection to the shell-owned command router.'
      : 'The workspace handed read-only schedule receipt inspection to the shell-owned command router.',
    'read-only',
  );
}

function approvalHealthShow(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const approval = editor.kind === 'approval-review';
  const command = approval
    ? `/approval review ${quoteSlashCommandArg(readField('kind'))}`
    : `/health check ${quoteSlashCommandArg(readField('domain'))}`;
  const title = approval ? 'Opening approval review' : 'Checking one health area';
  return dispatchCommandEditorSubmission(
    command,
    title,
    approval
      ? 'The workspace handed read-only approval class review to the shell-owned command router.'
      : 'The workspace handed a read-only health area check to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceOperationsCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceOperationsCommandEditorKind,
    editor,
    readField,
    OPERATIONS_COMMAND_SUBMISSION_HANDLERS,
  );
}
