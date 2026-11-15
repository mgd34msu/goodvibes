/**
 * Calendar OAuth client card.
 *
 * No client id ships with the product (calendar/oauth-providers.ts): calendar
 * sync with Google or Outlook needs the owner's own OAuth app, and
 * `/calendar connect google|outlook` refuses with `client-not-configured` until
 * one is stored. This card is that first step: it stores a client id and
 * (optionally) a client secret the same way every other Agent credential is
 * stored (id in config, secret through the secret manager, never in plain
 * config, never in a command string); the connect command then authorizes.
 *
 * Security: like the email connect wizard, this is a DIRECT host action, not a slash
 * command, the client secret never travels through the command-dispatch pipeline
 * that echoes the command string into the rendered result. The OAuth network dance
 * (auth URL / device code) lives in the /calendar connect command, which can print
 * the URL/code immediately; this card only persists credentials.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { requireSecretsManager } from './commands/runtime-services.ts';
import { persistSecretBackedConfigValue } from '../config/secret-config.ts';
import { routeConfigWrite } from '../config/daemon-config-routing.ts';
import type { ConfigKey } from '../config/index.ts';
import {
  CALENDAR_OAUTH_CLIENT_ID_KEYS,
  CALENDAR_OAUTH_CLIENT_SECRET_KEYS,
} from '../agent/calendar/calendar-oauth-service.ts';
import { ensureCalendarConfigDefaults } from '@goodvibes-jev/engine/platform/platform/config';
import type { AgentWorkspaceActionResult, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;
type Provider = 'google' | 'microsoft';

export interface AgentWorkspaceCalendarOAuthEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/** Honest, no-I/O calendar-OAuth build state per provider, true once a client id override is stored (F1c). */
export interface AgentWorkspaceCalendarOAuthConfigStatus {
  readonly google: boolean;
  readonly microsoft: boolean;
}

const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };
const CONNECT_HINT: Record<Provider, string> = { google: '/calendar connect google', microsoft: '/calendar connect outlook' };

/** The card's message, read from whether a client id is already stored. */
function cardMessage(label: string, provider: Provider, isConfigured: boolean): string {
  if (!isConfigured) {
    return (
      `Connecting ${label} needs your own OAuth client id (free, about five minutes). ` +
      'Register an OAuth app with the provider (Google Cloud Console, or the Azure portal for ' +
      'Microsoft), choose the desktop/public-client type, copy the client id it gives you, and paste it ' +
      `below. Then run ${CONNECT_HINT[provider]} to authorize. A client secret is only needed for a ` +
      'confidential-client registration; it is stored through the Agent secret manager and never shown again.'
    );
  }
  return (
    `A ${label} client id is already stored: run ${CONNECT_HINT[provider]} to authorize. ` +
    'Use this form only to replace the stored client id or secret. A client secret is stored through ' +
    'the Agent secret manager and never shown again.'
  );
}

/** The OAuth client form for one provider. */
export function createCalendarOAuthEditor(provider: Provider, isConfigured = false): AgentWorkspaceLocalEditor {
  const label = PROVIDER_LABEL[provider];
  const kind: AgentWorkspaceEditorKind = provider === 'google' ? 'calendar-oauth-google' : 'calendar-oauth-outlook';
  return {
    kind,
    mode: 'create',
    title: isConfigured ? `Replace ${label} OAuth client` : `Store ${label} OAuth client`,
    selectedFieldIndex: 0,
    message: cardMessage(label, provider, isConfigured),
    fields: [
      { id: 'clientId', label: 'Client ID', value: '', required: true, multiline: false, hint: `Your ${label} OAuth client id (Desktop/public client needs no secret).` },
      { id: 'clientSecret', label: 'Client secret (optional)', value: '', required: false, multiline: false, hint: 'Only for a confidential-client app. Stored through the secret manager, masked here.', redact: true },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: `Type yes to store these credentials, then run ${CONNECT_HINT[provider]} to authorize.` },
    ],
  };
}

export async function submitAgentWorkspaceCalendarOAuthEditor(
  host: AgentWorkspaceCalendarOAuthEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
): Promise<void> {
  const provider: Provider = editor.kind === 'calendar-oauth-outlook' ? 'microsoft' : 'google';
  const label = PROVIDER_LABEL[provider];

  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Credentials not confirmed. Type yes, then press Enter.' };
    host.status = 'Calendar credentials not confirmed.';
    return;
  }
  if (!context) {
    host.localEditor = { ...editor, message: 'This runtime has no command context; cannot store credentials.' };
    host.status = 'Calendar connect unavailable.';
    host.lastActionResult = { kind: 'error', title: 'Calendar connect unavailable', detail: 'No command context is available in this runtime.', safety: 'safe' };
    return;
  }

  const clientId = readField('clientId').trim();
  if (!clientId) {
    host.localEditor = { ...editor, message: 'A client id is required.' };
    host.status = 'Client id is required.';
    return;
  }

  const secret = readField('clientSecret');
  const hasSecret = secret.trim().length > 0;
  // Two writes, id first: a failure says which half is stored, so the result
  // never claims nothing was saved after the id landed.
  let idStored = false;
  try {
    const secretsManager = requireSecretsManager(context);
    ensureCalendarConfigDefaults(context.platform.configManager);
    const cm = context.platform.configManager as unknown as {
      get: (key: ConfigKey) => unknown;
      setDynamic: (key: ConfigKey, value: unknown) => void;
      save: () => void;
    };
    // The client id is not a secret: a plain config value, routed to its owner.
    const configManager = context.platform.configManager;
    const homeDir = configManager.getHomeDirectory();
    await routeConfigWrite(configManager, CALENDAR_OAUTH_CLIENT_ID_KEYS[provider], clientId, homeDir ? { homeDir } : {});
    idStored = true;
    // The client secret goes through the secret-backed writer, which routes to
    // the same owner: a ref in config, the raw value only in the secret store.
    if (hasSecret) {
      await persistSecretBackedConfigValue(cm, secretsManager, CALENDAR_OAUTH_CLIENT_SECRET_KEYS[provider] as unknown as ConfigKey, secret);
    }
    cm.save();

    host.localEditor = null;
    host.status = `${label} credentials stored.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: `${label} credentials stored`,
      detail: `Your ${label} client id was saved${hasSecret ? ' (and the client secret through the secret manager)' : ''}. Run ${CONNECT_HINT[provider]} to open the browser and authorize.`,
      safety: 'safe',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const detail = idStored
      ? `The client id was stored; the client secret was not: ${reason} Enter the secret again and press Enter, or run ${CONNECT_HINT[provider]} if your app needs no secret.`
      : `Nothing was stored: ${reason}`;
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: idStored ? `${label} client secret not stored` : `${label} credentials not stored`, detail, safety: 'safe' };
  }
}
