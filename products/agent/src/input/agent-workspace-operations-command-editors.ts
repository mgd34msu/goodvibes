import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceOperationsCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'health-repair'
  | 'approval-review'
  | 'approval-approve'
  | 'approval-deny'
  | 'approval-cancel'
  | 'automation-job-run'
  | 'automation-job-pause'
  | 'automation-job-resume'
  | 'automation-run-cancel'
  | 'automation-run-retry'
  | 'routine-receipt'
  | 'schedule-receipt'
>;

export function isAgentWorkspaceOperationsCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceOperationsCommandEditorKind {
  return kind === 'health-repair'
    || kind === 'approval-review'
    || kind === 'approval-approve'
    || kind === 'approval-deny'
    || kind === 'approval-cancel'
    || kind === 'automation-job-run'
    || kind === 'automation-job-pause'
    || kind === 'automation-job-resume'
    || kind === 'automation-run-cancel'
    || kind === 'automation-run-retry'
    || kind === 'routine-receipt'
    || kind === 'schedule-receipt';
}

function approvalActionSpec(kind: AgentWorkspaceOperationsCommandEditorKind): AgentWorkspaceEditorSpec {
  const verb = kind === 'approval-approve' ? 'Approve' : kind === 'approval-deny' ? 'Deny' : 'Cancel';
  return {
    mode: 'update',
    title: `${verb} Approval`,
    selectedFieldIndex: 0,
    message: `${verb} one pending connected-host approval request. This is an explicit operator action and requires typed confirmation.`,
    fields: [
      { id: 'approvalId', label: 'Approval id', value: '', required: true, multiline: false, hint: 'Approval request id from the approval list.' },
      { id: 'note', label: 'Note', value: '', required: false, multiline: true, hint: 'Optional approval note. Ctrl-J inserts a new line.' },
      { id: 'remember', label: 'Remember', value: '', required: false, multiline: false, hint: 'yes/no when you explicitly want to set the connected-host remember flag; blank leaves it unset.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: `Type yes to run /approval ${kind.replace('approval-', '')} with --yes.` },
    ],
  };
}

function automationActionSpec(kind: AgentWorkspaceOperationsCommandEditorKind): AgentWorkspaceEditorSpec {
  const job = kind.startsWith('automation-job-');
  const run = kind.startsWith('automation-run-');
  const label = job ? 'Job id' : run ? 'Run id' : 'Schedule id';
  const field = job ? 'jobId' : run ? 'runId' : 'scheduleId';
  const action = kind === 'automation-job-run'
    ? 'Run Automation Job'
    : kind === 'automation-job-pause'
      ? 'Pause Automation Job'
      : kind === 'automation-job-resume'
        ? 'Resume Automation Job'
        : kind === 'automation-run-cancel'
          ? 'Cancel Automation Run'
          : kind === 'automation-run-retry'
            ? 'Retry Automation Run'
            : 'Run Schedule';
  return {
    mode: 'update',
    title: action,
    selectedFieldIndex: 0,
    message: `${action} through the connected host. This is never automatic and requires typed confirmation.`,
    fields: [
      { id: field, label, value: '', required: true, multiline: false, hint: `${label} from the Automation workspace list.` },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run the confirmed connected-host action with --yes.' },
    ],
  };
}

function receiptSpec(kind: AgentWorkspaceOperationsCommandEditorKind): AgentWorkspaceEditorSpec {
  const routine = kind === 'routine-receipt';
  return {
    mode: 'create',
    title: routine ? 'Show Routine Promotion Receipt' : 'Show Schedule Receipt',
    selectedFieldIndex: 0,
    message: routine
      ? 'Show one local routine schedule-promotion receipt without reconciling or mutating connected schedules.'
      : 'Show one local schedule receipt without reconciling or mutating connected schedules.',
    fields: [
      { id: 'receiptId', label: 'Receipt id', value: '', required: true, multiline: false, hint: 'Receipt id from Promotion receipts.' },
    ],
  };
}

const OPERATIONS_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceOperationsCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceOperationsCommandEditorKind>>> = {
  'health-repair': {
    mode: 'create',
    title: 'Show Health Repair Guidance',
    selectedFieldIndex: 0,
    message: 'Show health repair guidance for one domain. Agent does not manage connected-host hosting or mutate connected-host lifecycle.',
    fields: [
      { id: 'domain', label: 'Domain', value: 'settings', required: true, multiline: false, hint: 'settings, auth, accounts, host, remote, mcp, continuity, or maintenance.' },
    ],
  },
  'approval-review': {
    mode: 'create',
    title: 'Review Approval Class',
    selectedFieldIndex: 0,
    message: 'Review one approval class without approving, denying, or mutating pending requests.',
    fields: [
      { id: 'kind', label: 'Approval kind', value: 'shell', required: true, multiline: false, hint: 'shell, file, network, delegate, mcp, remote, hook, or plugin.' },
    ],
  },
  'approval-approve': approvalActionSpec,
  'approval-deny': approvalActionSpec,
  'approval-cancel': approvalActionSpec,
  'automation-job-run': automationActionSpec,
  'automation-job-pause': automationActionSpec,
  'automation-job-resume': automationActionSpec,
  'automation-run-cancel': automationActionSpec,
  'automation-run-retry': automationActionSpec,
  'routine-receipt': receiptSpec,
  'schedule-receipt': receiptSpec,
};

export function createAgentWorkspaceOperationsCommandEditor(kind: AgentWorkspaceOperationsCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, OPERATIONS_COMMAND_EDITOR_SPECS);
}
