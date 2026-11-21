/**
 * The `retest` account action: one authenticated call to the provider, answered
 * with the provider's own reason.
 *
 * Each surface is asked the cheapest question that proves its credential: who
 * the token belongs to (Slack `auth.test`, Discord `/users/@me`, Telegram
 * `getMe`, Matrix `whoami`, Mattermost `users/me`), whether the account exists
 * for these credentials (Twilio, Meta Cloud), whether the server answers with
 * them (Home Assistant, BlueBubbles, ntfy, a bridge), or, for Teams, a Bot
 * Framework token for the app. Nothing is sent to anyone. A surface that can
 * only be checked by sending (an incoming webhook, Google Chat) says so and
 * reports `probed: false`.
 *
 * One request per explicit retest; nothing per message.
 */
import { DiscordIntegration, SlackIntegration, ntfyBaseUrl } from '../../integrations/index.js';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout.js';
import { TelegramApiError, TelegramBotApi } from '../telegram/api.js';
import { resolveMSTeamsAccessToken } from '../delivery/shared.js';
import type { ChannelSurface } from '../types.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import { resolveSurfaceSecret } from './surface-secrets.js';
import { channelCredentials, isCredentialRefusal } from '../credential-holder.js';

export interface CredentialProbeResult {
  /** The provider accepted the credentials (or, when nothing could be probed, the surface is configured). */
  readonly ok: boolean;
  /** An authenticated request was made. */
  readonly probed: boolean;
  /** What the provider said, or why nothing was asked. */
  readonly reason: string;
  /** The identity the provider reported, when it reported one. */
  readonly identity?: string | undefined;
  /** The provider refused the credential itself (not unreachable, not some other error). */
  readonly refused?: boolean | undefined;
}

const PROBE_TIMEOUT_MS = 10_000;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** GET `url` and read the answer; the reason quotes the provider's status and a short body. */
async function probeHttp(
  label: string,
  url: string,
  headers: Record<string, string>,
  identify: (body: Record<string, unknown>) => string = () => '',
): Promise<CredentialProbeResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method: 'GET', headers }, PROBE_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, probed: true, reason: `${label} could not be reached: ${errorText(error)}` };
  }
  const raw = await response.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* A non-JSON answer is quoted by status below. */ }
  if (response.status === 401 || response.status === 403) {
    const detail = text(body['message']) || text(body['error']) || text(body['detail']) || raw.slice(0, 160);
    return { ok: false, probed: true, refused: true, reason: `${label} refused the credentials (HTTP ${response.status}${detail ? `: ${detail}` : ''}).` };
  }
  if (!response.ok) {
    return { ok: false, probed: true, reason: `${label} answered HTTP ${response.status}${raw ? `: ${raw.slice(0, 160)}` : ''}.` };
  }
  const identity = identify(body);
  return { ok: true, probed: true, reason: `${label} accepted the credentials${identity ? ` (${identity})` : ''}.`, ...(identity ? { identity } : {}) };
}

function notProbed(ok: boolean, reason: string): CredentialProbeResult {
  return { ok, probed: false, reason };
}

function missing(label: string, what: string): CredentialProbeResult {
  return { ok: false, probed: false, reason: `${label} has no ${what} that resolves here, so there is nothing to test. Run setup to store it.` };
}

/**
 * Ask the provider whether the surface's credentials work. A refusal of a
 * credential this process held (one resolved from a password manager earlier)
 * releases what is held and asks once more with the value resolved now, so a
 * token rotated in the vault is tested as it is, not as it was.
 */
export async function probeBuiltinCredentials(
  deps: BuiltinChannelRuntimeDeps,
  surface: ChannelSurface,
): Promise<CredentialProbeResult> {
  const held = channelCredentials.size > 0;
  const probe = await probeOnce(deps, surface);
  if (probe.refused !== true || !held) return probe;
  channelCredentials.release();
  return probeOnce(deps, surface);
}

async function probeOnce(
  deps: BuiltinChannelRuntimeDeps,
  surface: ChannelSurface,
): Promise<CredentialProbeResult> {
  const config = deps.configManager;
  switch (surface) {
    case 'tui':
    case 'web':
      return notProbed(true, 'This surface is served by this process and has no provider credential.');
    case 'slack': {
      const token = await resolveSurfaceSecret(deps, 'slack', 'primary');
      if (!token) {
        return (await resolveSurfaceSecret(deps, 'slack', 'webhookUrl'))
          ? notProbed(true, 'Slack sends through an incoming webhook, which can only be checked by sending a message; nothing was sent.')
          : missing('Slack', 'bot token or webhook URL');
      }
      try {
        const answer = await new SlackIntegration(undefined, token).authTest(token);
        if (!answer.ok) return { ok: false, probed: true, refused: true, reason: `Slack refused the bot token: ${answer.error ?? 'no reason given'}.` };
        const identity = [text(answer.user), text(answer.team)].filter(Boolean).join(' in ');
        return { ok: true, probed: true, reason: `Slack accepted the bot token${identity ? ` (${identity})` : ''}.`, ...(identity ? { identity } : {}) };
      } catch (error) {
        return { ok: false, probed: true, reason: `Slack auth.test failed: ${errorText(error)}` };
      }
    }
    case 'discord': {
      const token = await resolveSurfaceSecret(deps, 'discord', 'primary');
      if (!token) {
        return (await resolveSurfaceSecret(deps, 'discord', 'webhookUrl'))
          ? notProbed(true, 'Discord sends through a webhook, which can only be checked by sending a message; nothing was sent.')
          : missing('Discord', 'bot token or webhook URL');
      }
      try {
        const user = await new DiscordIntegration(undefined, token).getCurrentBotUser(token);
        const identity = text(user['username']);
        return { ok: true, probed: true, reason: `Discord accepted the bot token${identity ? ` (${identity})` : ''}.`, ...(identity ? { identity } : {}) };
      } catch (error) {
        return { ok: false, probed: true, refused: isCredentialRefusal(error), reason: `Discord refused the bot token: ${errorText(error)}` };
      }
    }
    case 'telegram': {
      const token = await resolveSurfaceSecret(deps, 'telegram', 'primary');
      if (!token) return missing('Telegram', 'bot token');
      try {
        const bot = await new TelegramBotApi(token, (input, init) => fetchWithTimeout(input, init, PROBE_TIMEOUT_MS)).getMe();
        const identity = bot.username ? `@${bot.username}` : `bot ${bot.id}`;
        return { ok: true, probed: true, reason: `Telegram accepted the bot token (${identity}).`, identity };
      } catch (error) {
        return { ok: false, probed: true, refused: error instanceof TelegramApiError && error.isUnauthorized, reason: `Telegram refused the bot token: ${errorText(error)}` };
      }
    }
    case 'ntfy': {
      const base = trimBase(ntfyBaseUrl(config));
      const token = await resolveSurfaceSecret(deps, 'ntfy', 'primary');
      return token
        ? probeHttp('ntfy', `${base}/v1/account`, { Authorization: `Bearer ${token}` }, (body) => text(body['username']))
        : probeHttp('ntfy', `${base}/v1/health`, {});
    }
    case 'webhook':
      return notProbed(Boolean(text(config.get('surfaces.webhook.defaultTarget'))),
        'A generic webhook has no account to ask; it is checked by its first delivery. Nothing was sent.');
    case 'google-chat':
      return (await resolveSurfaceSecret(deps, 'google-chat', 'webhookUrl'))
        ? notProbed(true, 'Google Chat sends through a space webhook, which can only be checked by sending a message; nothing was sent.')
        : missing('Google Chat', 'webhook URL');
    case 'homeassistant': {
      const base = text(config.get('surfaces.homeassistant.instanceUrl'));
      const token = await resolveSurfaceSecret(deps, 'homeassistant', 'primary');
      if (!base) return notProbed(false, 'Home Assistant has no instance URL, so its access token cannot be tested. Set surfaces.homeassistant.instanceUrl.');
      if (!token) return missing('Home Assistant', 'long-lived access token');
      return probeHttp('Home Assistant', `${trimBase(base)}/api/`, { Authorization: `Bearer ${token}` }, (body) => text(body['message']));
    }
    case 'signal':
    case 'imessage': {
      const label = surface === 'signal' ? 'The Signal bridge' : 'The iMessage bridge';
      const base = text(surface === 'signal' ? config.get('surfaces.signal.bridgeUrl') : config.get('surfaces.imessage.bridgeUrl'));
      if (!base) return notProbed(false, `${label} has no URL. Set it in the surface settings.`);
      const token = await resolveSurfaceSecret(deps, surface, 'primary');
      return probeHttp(label, base, token ? { Authorization: `Bearer ${token}` } : {});
    }
    case 'whatsapp': {
      if (text(config.get('surfaces.whatsapp.provider')) === 'bridge') {
        const base = text(config.get('surfaces.whatsapp.bridgeUrl')) || text(process.env.WHATSAPP_BRIDGE_URL);
        if (!base) return notProbed(false, 'The WhatsApp bridge has no URL. Set surfaces.whatsapp.bridgeUrl.');
        const token = await resolveSurfaceSecret(deps, 'whatsapp', 'primary');
        return probeHttp('The WhatsApp bridge', base, token ? { Authorization: `Bearer ${token}` } : {});
      }
      const token = await resolveSurfaceSecret(deps, 'whatsapp', 'primary');
      if (!token) return missing('WhatsApp', 'access token');
      const phoneNumberId = text(config.get('surfaces.whatsapp.phoneNumberId'));
      return probeHttp('Meta Cloud API', `https://graph.facebook.com/v20.0/${phoneNumberId ? encodeURIComponent(phoneNumberId) : 'me'}`,
        { Authorization: `Bearer ${token}` }, (body) => text(body['display_phone_number']) || text(body['name']));
    }
    case 'telephony': {
      const bridge = text(config.get('surfaces.telephony.provider')) === 'bridge' || text(config.get('surfaces.telephony.mode')) === 'bridge';
      if (bridge) {
        const base = text(config.get('surfaces.telephony.bridgeUrl'));
        if (!base) return notProbed(false, 'The telephony bridge has no URL. Set surfaces.telephony.bridgeUrl.');
        const token = await resolveSurfaceSecret(deps, 'telephony', 'primary');
        return probeHttp('The telephony bridge', base, token ? { Authorization: `Bearer ${token}` } : {});
      }
      const accountSid = text(config.get('surfaces.telephony.accountSid')) || text(process.env.TWILIO_ACCOUNT_SID);
      const authToken = await resolveSurfaceSecret(deps, 'telephony', 'authToken');
      if (!accountSid) return notProbed(false, 'Twilio has no account SID. Set surfaces.telephony.accountSid.');
      if (!authToken) return missing('Twilio', 'auth token');
      return probeHttp('Twilio', `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
        { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
        (body) => text(body['friendly_name']));
    }
    case 'msteams':
      try {
        await resolveMSTeamsAccessToken(config, deps.serviceRegistry, deps.secretsManager);
        return { ok: true, probed: true, reason: 'Microsoft issued a Bot Framework token for the Teams app id and password.' };
      } catch (error) {
        return { ok: false, probed: true, refused: isCredentialRefusal(error), reason: `Microsoft refused the Teams app credentials: ${errorText(error)}` };
      }
    case 'bluebubbles': {
      const base = text(config.get('surfaces.bluebubbles.serverUrl'));
      if (!base) return notProbed(false, 'BlueBubbles has no server URL. Set surfaces.bluebubbles.serverUrl.');
      const password = await resolveSurfaceSecret(deps, 'bluebubbles', 'password');
      if (!password) return missing('BlueBubbles', 'server password');
      return probeHttp('The BlueBubbles server', `${trimBase(base)}/api/v1/ping?password=${encodeURIComponent(password)}`, {});
    }
    case 'mattermost': {
      const base = text(config.get('surfaces.mattermost.baseUrl'));
      if (!base) return notProbed(false, 'Mattermost has no base URL. Set surfaces.mattermost.baseUrl.');
      const token = await resolveSurfaceSecret(deps, 'mattermost', 'primary');
      if (!token) return missing('Mattermost', 'bot token');
      return probeHttp('Mattermost', `${trimBase(base)}/api/v4/users/me`, { Authorization: `Bearer ${token}` }, (body) => text(body['username']));
    }
    case 'matrix': {
      const base = text(config.get('surfaces.matrix.homeserverUrl'));
      if (!base) return notProbed(false, 'Matrix has no homeserver URL. Set surfaces.matrix.homeserverUrl.');
      const token = await resolveSurfaceSecret(deps, 'matrix', 'primary');
      if (!token) return missing('Matrix', 'access token');
      return probeHttp('The Matrix homeserver', `${trimBase(base)}/_matrix/client/v3/account/whoami`, { Authorization: `Bearer ${token}` }, (body) => text(body['user_id']));
    }
  }
}
