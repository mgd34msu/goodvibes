/**
 * calendar-connect-runtime.ts, the /calendar connect|disconnect|accounts subcommands
 * and the provider-event merge for /calendar upcoming.
 *
 * The OAuth network dance lives here (not in the workspace card) because a command
 * handler can print the authorization URL / device user-code IMMEDIATELY, then await
 * the browser callback or poll the device code; `--code` completes a pasted sign-in
 * started with `--device` for Google. The client id is the operator's own, from
 * config, and its secret from the secret manager (captured by the advanced workspace
 * card). No secret is ever put into a command string.
 *
 * The service is injectable so tests drive every path against fakes with no real
 * network, port, or browser.
 */
import type { CalendarProviderId, DeviceCodeFlowStart, EventWindow, MergedCalendarEvent } from '@goodvibes-jev/engine/platform/platform/calendar';
import type { CalendarProvider } from '@goodvibes-jev/engine/terminal-shell/calendar-command';
import type { CommandContext } from '../command-registry.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { CalendarOAuthService, type CalendarConfigReader, type CalendarSecretSlice, type ConnectResult } from '../../agent/calendar/calendar-oauth-service.ts';
import { commandRefusal } from './confirmation.ts';

/** Factory seam: production builds the real service from context; tests inject a fake. */
export type CalendarServiceFactory = (ctx: CommandContext) => CalendarOAuthService;

/** The account choice of /calendar ('outlook' is Microsoft's). */
function providerOf(account: CalendarProvider): CalendarProviderId {
  return account === 'outlook' ? 'microsoft' : 'google';
}

const PROVIDER_LABEL: Record<CalendarProviderId, string> = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };

const CONNECTION_STATE_NOTE: Record<string, string> = {
  connected: 'connected',
  'refresh-due': 'connected (token refresh due)',
  'reconnect-needed': 'reconnect needed, run the connect command again',
  disconnected: 'disconnected',
};

function defaultServiceFactory(ctx: CommandContext): CalendarOAuthService {
  const config = ctx.platform.configManager as unknown as CalendarConfigReader;
  const secrets = requireSecretsManager(ctx) as unknown as CalendarSecretSlice;
  return new CalendarOAuthService({ config, secrets });
}

function deviceCodeMessage(label: string, start: DeviceCodeFlowStart): string {
  return [
    `Authorize ${label} on another device or browser:`,
    `  1. Open ${start.verificationUri}`,
    `  2. Enter the code: ${start.userCode}`,
    start.verificationUriComplete ? `  (or open directly: ${start.verificationUriComplete})` : '',
    '  Waiting for approval...',
  ].filter(Boolean).join('\n');
}

function pastedCodeMessage(label: string, word: string, url: string): string {
  return [
    `Authorize ${label} from any device:`,
    `  1. Open ${url}`,
    '  2. Approve. The browser then lands on a 127.0.0.1 address that does not load; that is expected.',
    `  3. Copy that whole address and run: /calendar connect ${word} --with code (it asks for the address, masked)`,
    '  The link stays valid for ten minutes in this session.',
  ].join('\n');
}

function authUrlMessage(label: string, url: string): string {
  return [
    `Authorize ${label} in your browser:`,
    `  ${url}`,
    '  (Attempting to open it automatically. Waiting for the redirect...)',
  ].join('\n');
}

/** Best-effort browser open; never throws, never blocks the flow. */
function bestEffortOpenBrowser(url: string): void {
  void (async () => {
    try {
      const { spawn } = await import('node:child_process');
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const child = spawn(opener, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch {
      // ignore, the URL was already printed for the user to open manually
    }
  })();
}

/** Sign a calendar account in: a browser here, a device code for another device, or the address the browser landed on. */
export async function connectCalendar(
  ctx: CommandContext,
  account: CalendarProvider,
  how: 'browser' | 'device' | 'code',
  pasted: string,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<void> {
  const provider = providerOf(account);
  const label = PROVIDER_LABEL[provider];
  const service = factory(ctx);
  const word = account;

  if (how === 'code') {
    if (!pasted.trim()) throw commandRefusal(`Give the address the browser landed on, or the code: /calendar connect ${word} --with code --code <address>`);
    printConnectResult(ctx, label, await service.completePastedCode(provider, pasted.trim()));
    return;
  }

  ctx.print(`Connecting ${label}...`);
  const result = how === 'device'
    ? await service.connectDeviceCode(provider, { onDeviceCode: (s) => ctx.print(deviceCodeMessage(label, s)) })
    : await service.connectAuto(provider, {
        openUrl: (url) => {
          ctx.print(authUrlMessage(label, url));
          bestEffortOpenBrowser(url);
        },
        onDeviceCode: (s) => ctx.print(deviceCodeMessage(label, s)),
      });

  if (result.pendingAuthorizationUrl) {
    ctx.print(pastedCodeMessage(label, word, result.pendingAuthorizationUrl));
    return;
  }
  printConnectResult(ctx, label, result);
}

function printConnectResult(ctx: CommandContext, label: string, result: ConnectResult): void {
  if (!result.ok) {
    throw commandRefusal([
      `Could not connect ${label} (${result.stage ?? 'unknown'} stage).`,
      `  ${result.error ?? 'unknown error'}`,
    ].join('\n'), undefined, 'COMMAND_FAILED');
  }
  const via = result.transport === 'device-code' ? 'device code' : result.transport === 'pasted-code' ? 'pasted sign-in' : 'browser sign-in';
  ctx.print([
    `Connected ${label}.`,
    `  account ${result.account?.label ?? label}`,
    `  via     ${via}`,
    `  scopes  ${(result.account?.scopes ?? []).join(', ') || '(none reported)'}`,
  ].join('\n'));
}

export async function disconnectCalendar(
  ctx: CommandContext,
  account: CalendarProvider,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<string> {
  const provider = providerOf(account);
  const label = PROVIDER_LABEL[provider];
  const service = factory(ctx);
  const { revokedRemotely } = await service.disconnect(provider);
  return [
    `Disconnected ${label}.`,
    revokedRemotely
      ? '  The access was revoked at the provider and local tokens were cleared.'
      : '  Local tokens were cleared. This provider offers no token-revocation endpoint, so revoke access in your account settings if desired.',
  ].join('\n');
}

export async function calendarAccounts(
  ctx: CommandContext,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<string> {
  const service = factory(ctx);
  const accounts = await service.listAccounts();
  if (accounts.length === 0) {
    return [
      'Connected calendar accounts',
      '  None. Connect one with /calendar connect google  or  /calendar connect outlook',
    ].join('\n');
  }
  return [
    `Connected calendar accounts (${accounts.length})`,
    ...accounts.map(({ account, state }) =>
      `  ${PROVIDER_LABEL[account.provider]}  ${account.label}  [${CONNECTION_STATE_NOTE[state] ?? state}]`,
    ),
  ].join('\n');
}

/**
 * Provider events for the upcoming window, source-labeled. A provider, or one
 * calendar of it, that could not be read (reconnect needed, rate limit, an
 * unshared calendar) is reported as a note beside the events of the rest.
 */
export async function fetchProviderUpcoming(
  ctx: CommandContext,
  window: EventWindow,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<{ readonly events: MergedCalendarEvent[]; readonly notes: string[] }> {
  const service = factory(ctx);
  const { events, failures } = await service.listEventsDetailed(window);
  const notes = failures.map((failure) =>
    `  ${PROVIDER_LABEL[failure.provider]}${failure.calendarLabel ? ` (${failure.calendarLabel})` : ''}: could not load events, ${failure.error}`);
  return { events, notes };
}

/** Render a source label for a merged event. */
export function sourceLabel(source: MergedCalendarEvent['source']): string {
  switch (source) {
    case 'google-api': return 'google';
    case 'microsoft-graph': return 'outlook';
    case 'ics-feed': return 'feed';
    default: return 'local';
  }
}
