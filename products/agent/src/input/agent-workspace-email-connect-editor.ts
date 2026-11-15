/**
 * Email connect wizard, promotes the "Inbox workflows" workspace
 * card from a dead guidance card into a real, stepped connect flow.
 *
 * Security: the raw password NEVER travels through the generic slash-command
 * dispatch pipeline (AgentWorkspace.dispatchWorkspaceCommand), because that
 * pipeline echoes its `command` argument back into
 * AgentWorkspace.lastActionResult.command for the 'inline' execution path
 * (see handler.ts dispatchAgentWorkspaceCommand), a raw command string
 * containing the password would render it in the workspace UI. Instead this
 * editor is a DIRECT host action (the same pattern as the subscription
 * login editors in agent-workspace-subscription-editor.ts).
 *
 * Order of a save: every field is validated first (no writes); then, where
 * this terminal holds the password, the connection is tested with the typed
 * values held in memory; only a validated (and, where possible, verified)
 * set is written: the password first, then the plain values. A refused or
 * failed save leaves the stored configuration as it was. Validation and
 * persistence reuse the helpers the /email set command uses (email-settings.ts),
 * one storage path, not a fork, and the keys are `surfaces.email.*`, the
 * mailbox the daemon reads.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { EmailService, type EmailConnectionTestResult } from '@goodvibes-jev/engine/platform/platform/email';
import { daemonSecretKeyFor } from '@goodvibes-jev/engine/platform/platform/config';
import { nodeEmailTransport } from '@goodvibes-jev/engine/platform/platform/email/node';
import { describeSenderClaim } from '../agent/untrusted-content.ts';
import { requireSecretsManager } from './commands/runtime-services.ts';
import { agentDaemonConfigClient, openEffectiveConfigView, routeConfigWrite } from '../config/daemon-config-routing.ts';
import { MAILBOX_FIELDS, mailboxServiceDeps, persistMailboxField, readMailboxStatus, validateMailboxFieldValue, type MailboxField } from './commands/email-settings.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceEmailConnectStatus, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;

export interface AgentWorkspaceEmailConnectEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/** The stored inbox settings a reopened form starts from, so changing one value keeps the rest. */
export interface AgentWorkspaceEmailConnectPrefill {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** True: implicit TLS (465). False: STARTTLS (587). */
  readonly smtpSecure: boolean;
  readonly username: string;
  readonly fromAddress: string;
  /** A password reference is stored; a blank password field keeps it. */
  readonly hasStoredPassword: boolean;
}

/** The stored inbox settings, read from config. Null when the email section cannot be read. */
export function readAgentWorkspaceEmailConnectPrefill(context: CommandContext | null): AgentWorkspaceEmailConnectPrefill | null {
  if (!context) return null;
  try {
    const cm = context.platform.configManager as unknown as { get: (key: string) => unknown };
    const { settings, passwordStored } = readMailboxStatus((key) => cm.get(key));
    return {
      imapHost: settings.imapHost ?? '',
      imapPort: settings.imapPort,
      smtpHost: settings.smtpHost ?? '',
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      username: settings.username ?? '',
      fromAddress: settings.fromAddress ?? '',
      hasStoredPassword: passwordStored,
    };
  } catch {
    return null;
  }
}

/** Fields, in wizard-step order, prefilled from the stored settings when there are any. */
export function createEmailConnectWizardEditor(
  status: AgentWorkspaceEmailConnectStatus | null,
  stored: AgentWorkspaceEmailConnectPrefill | null = null,
): AgentWorkspaceLocalEditor {
  const message = !status
    ? 'Connect your inbox. Enter your IMAP/SMTP settings; the password is stored through the Agent secret manager, never in plain config.'
    : status.connected
      ? `Currently connected as ${status.username} (${status.imapHost}). Change any value below; the stored settings are filled in, and a blank password keeps the stored one.`
      : 'Not connected, connect your inbox. Enter your IMAP/SMTP settings below.';
  const keepPassword = stored?.hasStoredPassword === true;
  return {
    kind: 'email-connect-wizard',
    mode: 'create',
    title: 'Connect Inbox',
    selectedFieldIndex: 0,
    message,
    fields: [
      { id: 'imapHost', label: 'IMAP host', value: stored?.imapHost || status?.imapHost || '', required: true, multiline: false, hint: 'For example imap.gmail.com.' },
      { id: 'imapPort', label: 'IMAP port', value: String(stored?.imapPort ?? 993), required: true, multiline: false, hint: 'Default 993 (implicit TLS).' },
      { id: 'smtpHost', label: 'SMTP host', value: stored?.smtpHost ?? '', required: true, multiline: false, hint: 'For example smtp.gmail.com.' },
      { id: 'smtpPort', label: 'SMTP port', value: String(stored?.smtpPort ?? 465), required: true, multiline: false, hint: '465 (implicit TLS) or 587 (STARTTLS).' },
      { id: 'smtpSecure', label: 'SMTP implicit TLS', value: String(stored?.smtpSecure ?? true), required: true, multiline: false, hint: 'true for port 465 (implicit TLS), false for port 587 (STARTTLS).' },
      { id: 'username', label: 'Username', value: stored?.username || status?.username || '', required: true, multiline: false, hint: 'Mailbox login, usually your email address.' },
      {
        id: 'password',
        label: 'Password',
        value: '',
        required: !keepPassword,
        multiline: false,
        hint: keepPassword
          ? 'Leave blank to keep the stored password. Stored through the Agent secret manager; masked here and never rendered in results.'
          : 'Stored through the Agent secret manager. Masked here and never rendered in results.',
        redact: true,
      },
      { id: 'fromAddress', label: 'From address', value: stored?.fromAddress || stored?.username || status?.username || '', required: true, multiline: false, hint: 'Address used in the From: header when sending.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to test the connection and store these settings.' },
    ],
  };
}

/** Form field id to the mailbox field it stores; the password is stored on its own, first. */
const FIELD_TO_MAILBOX_FIELD: Readonly<Record<string, MailboxField>> = {
  imapHost: 'imap.host',
  imapPort: 'imap.port',
  smtpHost: 'smtp.host',
  smtpPort: 'smtp.port',
  smtpSecure: 'smtp.secure',
  username: 'user',
  fromAddress: 'from',
};

/** The name the mailbox password is stored under, the one every mail reader looks under. */
const MAILBOX_PASSWORD_SECRET_KEY = daemonSecretKeyFor(MAILBOX_FIELDS.password);

export type EmailConnectionTester = (
  getConfig: (key: string) => unknown,
  secretsManager: { readonly get: (key: string) => Promise<string | null> },
) => { testConnection(): Promise<EmailConnectionTestResult> };

/** `getConfig` answers the `surfaces.email.*` settings; the service reads them through the mailbox adapter. */
const defaultTester: EmailConnectionTester = (getConfig, secretsManager) =>
  new EmailService(mailboxServiceDeps({
    getConfig,
    secretsManager,
    // The real sockets, and this product's own sender-claim wording. The
    // platform service ships neither: it opens no connection itself, and the
    // phrasing of a trust boundary belongs to the surface that renders it.
    transport: nodeEmailTransport,
    describeSenderClaim,
  }));

export async function submitAgentWorkspaceEmailConnectWizardEditor(
  host: AgentWorkspaceEmailConnectEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
  /** Injectable for tests, avoids real network I/O. Production callers omit this and get the real EmailService. */
  buildTester: EmailConnectionTester = defaultTester,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Inbox connection not confirmed. Type yes, then press Enter.' };
    host.status = 'Inbox connection not confirmed.';
    return;
  }
  if (!context) {
    host.localEditor = { ...editor, message: 'This runtime has no command context; cannot connect the inbox.' };
    host.status = 'Inbox connect unavailable.';
    host.lastActionResult = { kind: 'error', title: 'Inbox connect unavailable', detail: 'No command context is available in this runtime.', safety: 'safe' };
    return;
  }

  // 1. Validate every field before anything is written.
  const candidate = new Map<string, unknown>();
  for (const [fieldId, field] of Object.entries(FIELD_TO_MAILBOX_FIELD)) {
    const raw = readField(fieldId).trim();
    const checked = validateMailboxFieldValue(field, raw);
    if (!raw || !checked.ok) {
      const error = !raw ? `${fieldId} is required.` : (checked as { readonly error: string }).error;
      host.localEditor = { ...editor, message: `Nothing was saved: ${error} Correct the field and press Enter.` };
      host.status = 'Inbox settings invalid; nothing was saved.';
      host.lastActionResult = { kind: 'error', title: 'Inbox settings invalid', detail: `Nothing was saved: ${error}`, safety: 'safe' };
      return;
    }
    candidate.set(MAILBOX_FIELDS[field], checked.value);
  }
  const password = readField('password');
  const keepStoredPassword = password.length === 0;

  const configManager = context.platform.configManager;
  const homeDir = configManager.getHomeDirectory();
  const writeRouted = (key: string, value: unknown) => routeConfigWrite(configManager, key, value, homeDir ? { homeDir } : {});
  const written: string[] = [];
  try {
    const secretsManager = requireSecretsManager(context);
    const cm = configManager as unknown as {
      get: (key: string) => unknown;
      setDynamic: (key: string, value: unknown) => void;
      save: () => void;
    };
    if (keepStoredPassword && !readMailboxStatus((key) => cm.get(key)).passwordStored) {
      host.localEditor = { ...editor, message: 'Nothing was saved: a password is required because none is stored yet.' };
      host.status = 'Inbox password required; nothing was saved.';
      return;
    }

    // On a connected host the mailbox password lives only on the host, so this
    // terminal cannot test the connection; it stores the validated set there.
    const hostHoldsPassword = agentDaemonConfigClient()?.ownsKey(MAILBOX_FIELDS.password) === true;
    if (!hostHoldsPassword) {
      // 2. Test with the typed values held in memory: the candidate password is
      // served from memory under the mailbox password's name, nothing touches the store.
      const view = await openEffectiveConfigView(configManager, homeDir ? { homeDir } : {});
      const readCandidate = (key: string): unknown => (candidate.has(key) ? candidate.get(key) : view.get(key));
      const candidateSecrets = {
        get: (key: string): Promise<string | null> => (key === MAILBOX_PASSWORD_SECRET_KEY && !keepStoredPassword
          ? Promise.resolve(password)
          : secretsManager.get(key)),
      };
      const test = await buildTester(readCandidate, candidateSecrets).testConnection();
      if (!test.ok) {
        // The form stays open with everything typed, so the wrong value can be
        // corrected without retyping the rest.
        const failure = `Could not verify the mailbox (${test.stage ?? 'unknown'} stage): ${test.error ?? 'unknown error'}. Nothing was saved; the stored settings are unchanged. Correct the value in this form and press Enter to try again.`;
        host.localEditor = { ...editor, message: failure };
        host.status = `Inbox connection failed (${test.stage ?? 'unknown'}); nothing was saved.`;
        host.lastActionResult = { kind: 'error', title: 'Inbox connection failed', detail: failure, safety: 'safe' };
        return;
      }
    }

    // 3. Write the validated set: the password first (the secret store is the
    // write most likely to refuse, and then nothing else has changed), then the
    // plain values. The mailbox is in use once the set is complete.
    if (!keepStoredPassword) {
      const stored = await persistMailboxField(cm, secretsManager, 'password', password);
      if (!stored.ok) throw new Error(stored.error ?? 'Could not store the password.');
      written.push(MAILBOX_FIELDS.password);
    }
    for (const [key, value] of candidate) {
      await writeRouted(key, value);
      written.push(key);
    }
    cm.save();

    host.localEditor = null;
    host.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    if (hostHoldsPassword) {
      host.status = 'Inbox settings saved on the host; connection not verified.';
      host.lastActionResult = {
        kind: 'refreshed',
        title: 'Inbox settings saved',
        detail: `The mailbox settings for ${readField('username')} were saved on the connected host. The IMAP/SMTP connection was not verified from this terminal: the password is stored on the host. Run /email status to see the inbox state.`,
        safety: 'safe',
      };
      return;
    }
    host.status = 'Inbox connected.';
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Inbox connected',
      detail: `IMAP and SMTP were verified for ${readField('username')}. Inbox workflows are ready.`,
      safety: 'safe',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A transport or store failure part-way: say exactly what is stored.
    const detail = written.length === 0
      ? `Nothing was saved: ${reason}`
      : `Saving stopped part-way: ${reason} Stored: ${written.join(', ')}. The set is incomplete. Press Enter to save the whole set again.`;
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Inbox connect failed', detail, safety: 'safe' };
  }
}
