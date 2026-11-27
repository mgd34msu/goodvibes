/**
 * daemon-accounts.ts, the calendar accounts (Google, Outlook) the daemon signs
 * in to and reads: one owner per connection, the daemon. The sign-in tokens
 * are in the daemon's secret store, where the Agent's 3.5.0 sign-in already
 * filed them (credential-scope-registry.ts), so an account signed in from a
 * 3.5.0 Agent is this daemon's with nothing carried; a 3.5.0 Agent after a
 * rollback reads the same tokens.
 *
 * A sign-in answers at once with what the person does next (a link opened in
 * the browser of the daemon's machine, a code to enter on another device, or a
 * link whose landing address is pasted back) and finishes in the daemon by
 * itself when the provider answers; the calendar lists are told then.
 */
import { CalendarConnector, type CalendarConnectorOptions } from './calendar-connector.js';
import { fetchAdapter } from './http-fetch-adapter.js';
import { GOOGLE_CALENDAR_ONLY_SCOPES, providerProfile } from './oauth-providers.js';
import type { AuthCodeFlowStart, CalendarProviderId, ConnectedAccount, ConnectionState, ResolvedClientConfig } from './oauth-types.js';
import { createOAuthLocalListener } from '../config/oauth-local-listener.js';
import { openExternalUrl } from '../utils/open-external.js';

/** The daemon's settings and secret store as the accounts need them. */
export interface CalendarAccountSources {
  /** One daemon setting. */
  get(key: string): unknown;
  /** Write one daemon setting (a client id). */
  set(key: string, value: unknown): void;
  /** Keep a client secret in the secret store; the setting holds its reference. */
  storeClientSecret(configKey: string, value: string): Promise<void>;
  /** The daemon's secret store, each value revealed for the calendar provider it goes to. */
  readonly secrets: CalendarConnectorOptions['secrets'];
  /** Told when an account was signed in or out (the calendar lists read again). */
  changed(): void;
}

export interface CalendarAccountStatus {
  readonly account: ConnectedAccount;
  readonly state: ConnectionState;
}

/**
 * What a sign-in asks of the person now; its end is told by itself. `shared`: Google is already connected (the one
 * Google connection of the Google tab, for mail and calendar), so the calendar reads it and nothing is asked.
 */
export type CalendarSignInStep =
  | { readonly kind: 'browser'; readonly link: string; readonly opened: boolean }
  | { readonly kind: 'device'; readonly code: string; readonly link: string }
  | { readonly kind: 'paste'; readonly link: string }
  | { readonly kind: 'connected'; readonly account: ConnectedAccount }
  | { readonly kind: 'shared'; readonly account: ConnectedAccount };

/** How a finished sign-in ended, for the next reading of the accounts. */
export interface CalendarSignInEnd {
  readonly provider: CalendarProviderId;
  readonly ok: boolean;
  readonly detail: string;
  readonly at: number;
}

const LABEL: Record<CalendarProviderId, string> = { google: 'Google Calendar', microsoft: 'Outlook calendar' };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class DaemonCalendarAccounts {
  private readonly connector: CalendarConnector;
  private readonly pending = new Map<CalendarProviderId, { readonly start: AuthCodeFlowStart; readonly clientId: string; readonly onEnd?: () => void }>();
  /** The last sign-in that finished by itself, per account, said in the accounts until the next. */
  private readonly ended = new Map<CalendarProviderId, CalendarSignInEnd>();

  constructor(private readonly sources: CalendarAccountSources) {
    this.connector = new CalendarConnector({
      secrets: sources.secrets,
      fetchImpl: fetchAdapter(),
      listenerFactory: async ({ expectedState, host, port, timeoutMs }) => {
        const listener = await createOAuthLocalListener({ expectedState, ...(host ? { host } : {}), ...(typeof port === 'number' ? { port } : {}), ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}) });
        return {
          redirectUri: listener.redirectUri,
          async waitForCode() { const { code } = await listener.waitForCode(); return { code, state: expectedState }; },
          close() { listener.close(); },
        };
      },
    });
  }

  label(provider: CalendarProviderId): string { return LABEL[provider]; }

  private async config(provider: CalendarProviderId): Promise<ResolvedClientConfig> {
    return this.connector.resolveConfigFromSettings(provider, {
      config: { get: (key: string) => { try { return this.sources.get(key); } catch { return undefined; } } },
      secretGet: (key: string) => this.sources.secrets.get(key),
    });
  }

  /** The accounts signed in, each with its state; `unreadable` when the secret store could not be read. */
  async list(): Promise<{ readonly accounts: readonly CalendarAccountStatus[]; readonly unreadable: string | null; readonly ended: readonly CalendarSignInEnd[] }> {
    const accounts = await this.connector.listAccounts();
    const rows: CalendarAccountStatus[] = [];
    for (const account of accounts) rows.push({ account, state: await this.connector.connectionState(account.provider) });
    return { accounts: rows, unreadable: rows.length === 0 ? await this.connector.storeUnreadable() : null, ended: [...this.ended.values()] };
  }

  /** Whether the provider's app is set: its client id (GoodVibes ships none of its own). */
  async appSet(provider: CalendarProviderId): Promise<boolean> {
    return (await this.config(provider)).isConfigured;
  }

  private finish(provider: CalendarProviderId, run: Promise<ConnectedAccount>, onEnd?: () => void): void {
    void run.then((account) => {
      this.ended.set(provider, { provider, ok: true, detail: `${LABEL[provider]}: ${account.label} is signed in.`, at: Date.now() });
      this.sources.changed();
    }, (error: unknown) => {
      this.ended.set(provider, { provider, ok: false, detail: `${LABEL[provider]}: the sign-in did not finish (${describe(error)}).`, at: Date.now() });
      this.sources.changed();
    }).finally(() => { onEnd?.(); });
  }

  /**
   * The Google connection already on record (the Google tab's, for mail and calendar), as the calendar reads it; null
   * when there is none. One read of the stored record, no request to Google.
   */
  private async googleConnection(): Promise<CalendarAccountStatus | null> {
    const listed = await this.list();
    return listed.accounts.find((row) => row.account.provider === 'google') ?? null;
  }

  /**
   * Begin a sign-in, or finish one with what the person pasted (`how: 'code'`). `onEnd` is told once the sign-in is
   * over, whichever way it ended (the link posted for the owner is withdrawn then).
   *
   * Google is one connection for mail and calendar (the Google tab): once it is connected the calendar reads it and
   * nothing is asked; while it needs consent again, that consent is the Google tab's ("ask for consent again"), which
   * asks for mail and calendar together. A person who never connected Google may still sign in for the calendar alone,
   * with the calendar's scopes only.
   */
  async signIn(provider: CalendarProviderId, how: 'browser' | 'device' | 'code', pasted: string, onEnd?: () => void): Promise<CalendarSignInStep> {
    if (provider === 'google') {
      const connection = await this.googleConnection();
      if (connection && connection.state === 'reconnect-needed') {
        throw new Error('The Google connection, which the calendar reads, needs your consent again: press "ask for consent again" on the Google tab of Mail, calendar and channels; one consent covers mail and calendar.');
      }
      if (connection && how !== 'code') return { kind: 'shared', account: connection.account };
    }
    const resolved = await this.config(provider);
    // A calendar sign-in to Google asks for the calendar alone; the Google tab's connection asks for mail with it.
    const config: ResolvedClientConfig = provider === 'google' ? { ...resolved, scopes: GOOGLE_CALENDAR_ONLY_SCOPES } : resolved;
    if (!config.isConfigured) {
      throw new Error(provider === 'google'
        ? 'No Google app is set. Connect Google on the Google tab of Mail, calendar and channels (mail and calendar with one consent), or give your own app\'s client id with "Use your own calendar app to sign in" to sign in for the calendar alone.'
        : `No ${LABEL[provider]} app is set: GoodVibes ships none of its own. Register an app with Microsoft Entra and give its client id with "Use your own calendar app to sign in".`);
    }
    if (how === 'code') {
      const waiting = this.pending.get(provider);
      // A sign-in waits until it is answered or another is started; how long its code is good for is the provider's
      // to say (an expired one is refused by the provider's own answer below).
      if (!waiting) {
        throw new Error(`No ${LABEL[provider]} sign-in is waiting for its code (none was started, or it was answered already). Sign in again with "A code to enter on another device".`);
      }
      if (waiting.clientId !== config.clientId) { this.pending.delete(provider); throw new Error('The app\'s client id changed after the sign-in link was given; sign in again.'); }
      const account = await this.connector.completeConnectPastedCode(config, waiting.start, pasted.trim());
      this.pending.delete(provider);
      this.ended.delete(provider);
      waiting.onEnd?.();
      this.sources.changed();
      return { kind: 'connected', account };
    }
    if (how === 'device') {
      if (!config.usesDeviceGrant) {
        // Google grants calendar access to no device code: a link whose landing address is pasted back.
        const start = await this.connector.beginConnectPastedCode(config);
        this.pending.get(provider)?.onEnd?.();
        this.pending.set(provider, { start, clientId: config.clientId, ...(onEnd ? { onEnd } : {}) });
        return { kind: 'paste', link: start.authorizationUrl };
      }
      const start = await this.connector.beginConnectDeviceCode(config);
      this.finish(provider, this.connector.completeConnectDeviceCode(config, start), onEnd);
      return { kind: 'device', code: start.userCode, link: start.verificationUriComplete ?? start.verificationUri };
    }
    const begun = await this.connector.beginConnectAuthCode(config);
    const opened = await openExternalUrl(begun.start.authorizationUrl).catch(() => false);
    this.finish(provider, begun.waiter.waitForCode().then(
      ({ code }) => this.connector.completeConnectAuthCode(config, { code, verifier: begun.start.verifier, redirectUri: begun.start.redirectUri }),
    ).finally(() => begun.waiter.close()), onEnd);
    return { kind: 'browser', link: begun.start.authorizationUrl, opened };
  }

  /** Keep the owner's own app for a provider: its client id, and a client secret when it has one. */
  async useApp(provider: CalendarProviderId, clientId: string, clientSecret: string): Promise<void> {
    const profile = providerProfile(provider);
    this.sources.set(profile.clientIdConfigKey, clientId.trim());
    if (clientSecret.length > 0) await this.sources.storeClientSecret(profile.clientSecretRefConfigKey, clientSecret);
  }

  /** Sign out: the provider is asked to revoke where it can, and the stored tokens are deleted. */
  async signOut(provider: CalendarProviderId): Promise<{ readonly revokedRemotely: boolean }> {
    const clientId = (() => { try { const value = this.sources.get(providerProfile(provider).clientIdConfigKey); return typeof value === 'string' ? value.trim() : ''; } catch { return ''; } })();
    const result = await this.connector.disconnect(provider, clientId ? { clientId } : {});
    this.ended.delete(provider);
    this.sources.changed();
    return result;
  }
}

const ACCOUNTS = new Map<string, DaemonCalendarAccounts>();

/** One accounts holder per daemon home, so a sign-in begun through one door is finished through another. */
export function daemonCalendarAccounts(home: string, sources: CalendarAccountSources): DaemonCalendarAccounts {
  let accounts = ACCOUNTS.get(home);
  if (!accounts) {
    accounts = new DaemonCalendarAccounts(sources);
    ACCOUNTS.set(home, accounts);
  }
  return accounts;
}
