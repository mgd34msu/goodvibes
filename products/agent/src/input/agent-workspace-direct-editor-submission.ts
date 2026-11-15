/**
 * Editor kinds that perform a direct host action on submit (OAuth calls,
 * config/secrets writes) rather than building a slash command for the
 * generic command-editor dispatch pipeline (agent-workspace-command-editor.ts).
 * Centralizing the dispatch here keeps AgentWorkspace.submitLocalEditor()
 * under the architecture line cap as new direct-action editor kinds are
 * added (email-connect-wizard alongside the existing
 * subscription-login-start/finish/logout kinds).
 */
import type { CommandContext } from './command-registry.ts';
import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import {
  submitAgentWorkspaceSubscriptionLoginFinishEditor,
  submitAgentWorkspaceSubscriptionLoginStartEditor,
  submitAgentWorkspaceSubscriptionLogoutEditor,
  type AgentWorkspaceSubscriptionEditorHost,
} from './agent-workspace-subscription-editor.ts';
import { submitAgentWorkspaceEmailConnectWizardEditor, type AgentWorkspaceEmailConnectEditorHost } from './agent-workspace-email-connect-editor.ts';
import { submitAgentWorkspaceCalendarSubscribeWizardEditor, type AgentWorkspaceCalendarSubscribeEditorHost } from './agent-workspace-calendar-subscribe-editor.ts';
import { submitAgentWorkspaceCalendarOAuthEditor, type AgentWorkspaceCalendarOAuthEditorHost } from './agent-workspace-calendar-oauth-editor.ts';
import { submitAgentWorkspaceGoogleSetupEditor, type AgentWorkspaceGoogleSetupEditorHost } from './agent-workspace-google-setup-editor.ts';

type FieldReader = (id: string) => string;
type DirectEditorHost = AgentWorkspaceSubscriptionEditorHost & AgentWorkspaceEmailConnectEditorHost & AgentWorkspaceCalendarSubscribeEditorHost & AgentWorkspaceCalendarOAuthEditorHost & AgentWorkspaceGoogleSetupEditorHost;

/**
 * Every Google connection card routes to one submit function, which branches on
 * the editor kind. The alternative, one entry per card here, would put the
 * routing in two places and let them disagree about which kinds exist.
 */
const GOOGLE_EDITOR_KINDS = new Set([
  'google-status',
  'google-connect',
  'google-reauthorize',
  'google-forget',
  'google-setup-walkthrough',
  'google-setup-app-password',
  'google-adopt',
  'google-client-file',
  'google-client-manual',
]);

/**
 * Hosts with a direct submission still running. The editor stays open until the
 * action finishes, so a second Enter would start the action again (a duplicate
 * subscription, a second connection test, a second consent link).
 */
const submissionsInFlight = new WeakSet<object>();

function runExclusive(host: DirectEditorHost, requestRender: (() => void) | undefined, run: () => Promise<void>): void {
  if (submissionsInFlight.has(host)) {
    host.status = 'Still working on the previous submit. Wait for it to finish.';
    requestRender?.();
    return;
  }
  submissionsInFlight.add(host);
  void run().finally(() => {
    submissionsInFlight.delete(host);
    requestRender?.();
  });
}

/** Returns true when this editor kind was handled directly (caller should return without further dispatch). */
export function trySubmitDirectHostActionEditor(
  host: DirectEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
  requestRender?: () => void,
): boolean {
  if (editor.kind === 'subscription-login-start') {
    runExclusive(host, requestRender, () => submitAgentWorkspaceSubscriptionLoginStartEditor(host, editor, context, readField));
    return true;
  }
  if (editor.kind === 'subscription-login-finish') {
    runExclusive(host, requestRender, () => submitAgentWorkspaceSubscriptionLoginFinishEditor(host, editor, context, readField));
    return true;
  }
  if (editor.kind === 'subscription-logout') {
    submitAgentWorkspaceSubscriptionLogoutEditor(host, editor, context, readField);
    requestRender?.();
    return true;
  }
  if (editor.kind === 'email-connect-wizard') {
    runExclusive(host, requestRender, () => submitAgentWorkspaceEmailConnectWizardEditor(host, editor, context, readField));
    return true;
  }
  if (editor.kind === 'calendar-subscribe-wizard') {
    runExclusive(host, requestRender, () => submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, context, readField));
    return true;
  }
  if (editor.kind === 'calendar-oauth-google' || editor.kind === 'calendar-oauth-outlook') {
    runExclusive(host, requestRender, () => submitAgentWorkspaceCalendarOAuthEditor(host, editor, context, readField));
    return true;
  }
  if (GOOGLE_EDITOR_KINDS.has(editor.kind)) {
    runExclusive(host, requestRender, () => submitAgentWorkspaceGoogleSetupEditor(host, editor, context, readField));
    return true;
  }
  return false;
}
