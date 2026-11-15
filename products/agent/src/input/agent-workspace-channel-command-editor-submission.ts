import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceChannelCommandEditorKind } from './agent-workspace-channel-command-editors.ts';
import { isAgentWorkspaceChannelCommandEditorKind } from './agent-workspace-channel-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative, redactWebhookForDisplay } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceChannelCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceChannelCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceChannelCommandEditorKind {
  return isAgentWorkspaceChannelCommandEditorKind(kind);
}

const CHANNEL_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceChannelCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'channel-send': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return editorMessageSubmission(editor, 'Channel delivery not confirmed. Type yes, then press Enter.', 'Channel delivery not confirmed.');
    }
    const targetCount = ['channel', 'route', 'webhook', 'link'].filter((id) => readField(id).trim().length > 0).length;
    if (targetCount > 1) {
      return editorMessageSubmission(editor, 'Fill only one target field (Channel, Route, Webhook or Link). Clear the others, then press Enter.', 'Channel delivery needs exactly one target.');
    }
    const parts = ['/channels', 'send'];
    const title = readField('title');
    const channel = readField('channel');
    const route = readField('route');
    const webhook = readField('webhook');
    const link = readField('link');
    if (title) parts.push('--title', quoteSlashCommandArg(title));
    if (channel) parts.push('--channel', quoteSlashCommandArg(channel));
    if (route) parts.push('--route', quoteSlashCommandArg(route));
    // The webhook URL carries a token, so the result pane gets a masked copy.
    const display = [...parts];
    if (webhook) {
      parts.push('--webhook', quoteSlashCommandArg(webhook));
      display.push('--webhook', quoteSlashCommandArg(redactWebhookForDisplay(webhook)));
    }
    if (link) {
      parts.push('--link', quoteSlashCommandArg(link));
      display.push('--link', quoteSlashCommandArg(link));
    }
    const tail = ['--message', quoteSlashCommandArg(readField('message')), '--yes'];
    parts.push(...tail);
    display.push(...tail);
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening channel delivery',
      'The workspace handed a confirmed channel delivery command to the shell-owned command router.',
      'safe',
      display.join(' '),
    );
  },
  'channel-doctor': (editor, readField) => channelInspection(editor, readField),
  'channel-setup': (editor, readField) => channelInspection(editor, readField),
  'channel-show': (editor, readField) => channelInspection(editor, readField),
};

function channelInspection(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const subcommand = editor.kind === 'channel-doctor' ? 'doctor' : editor.kind === 'channel-setup' ? 'setup' : 'show';
  const command = `/channels ${subcommand} ${quoteSlashCommandArg(readField('channel'))}`;
  const title = editor.kind === 'channel-doctor'
    ? 'Opening channel doctor'
    : editor.kind === 'channel-setup'
      ? 'Opening channel setup guidance'
      : 'Opening channel detail';
  return dispatchCommandEditorSubmission(
    command,
    title,
    'The workspace handed read-only channel inspection to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceChannelCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceChannelCommandEditorKind,
    editor,
    readField,
    CHANNEL_COMMAND_SUBMISSION_HANDLERS,
  );
}
