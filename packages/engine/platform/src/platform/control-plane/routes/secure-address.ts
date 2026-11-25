/**
 * routes/secure-address.ts, the handlers behind the "Secure address" screen
 * (web UI, terminal app and Agent: Settings, General, Secure address).
 *
 *  - `secureAddress.get`: the four ways explained (secure-address-words.ts),
 *    which one is in force, what the https listener serves now and why not
 *    when it does not, Let's Encrypt's last attempt, the address record and
 *    the router check, the own files' check, and the group: the lead's line,
 *    or a node's "comes from <lead>".
 *  - `secureAddress.set`: the screen's one change. The person gives the name
 *    and, when none is stored, the Cloudflare token (Let's Encrypt), or the
 *    two file paths (their own certificate), or picks GoodVibes' own
 *    certificate, or switches https off. Checked before anything is written
 *    (a mismatched pair or a refused token changes nothing); then the web UI
 *    is served to the network when it is not yet (what `webui enable --lan`
 *    writes, the request itself being the person's yes), the settings are
 *    written, and the answer waits for the listener's sync and, for Let's
 *    Encrypt, the order's outcome.
 * Neither ever returns a key or a token.
 */
import type { ConfigManager } from '../../config/manager.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { LanHttpsListener } from '../../daemon/lan-https/listener.js';
import { LAN_HTTPS_PAGE_PATH } from '../../daemon/lan-https/page.js';
import { readOwnCertificate } from '../../daemon/lan-https/own-certificate.js';
import { primaryLanAddress } from '../../daemon/lan-https/secure-address.js';
import { DnsProviderError } from '../../daemon/lan-https/dns-provider.js';
import {
  SECURE_ADDRESS_GROUP_LINE, SECURE_ADDRESS_INTRO, SECURE_ADDRESS_LEAD_LINE, SECURE_ADDRESS_REISSUE_TITLE, secureAddressChoicesFor, secureAddressReissueLine, secureAddressNodeLine,
} from '../../daemon/lan-https/secure-address-words.js';

export interface SecureAddressRouteDeps {
  readonly listener: LanHttpsListener;
  readonly config: Pick<ConfigManager, 'get' | 'setDaemonValues'>;
  /** The https address `tailscale.serve.run` set up, while it is on record. */
  readonly tailscaleOrigin: () => string | null;
  /** Serve the web UI to the network and resolve once the listener is bound again (the pairing's serve-to-network). */
  readonly serveToNetwork?: (() => Promise<void>) | undefined;
}

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function servedToNetwork(config: Pick<ConfigManager, 'get'>): boolean {
  return config.get('controlPlane.hostMode') !== 'local' && config.get('controlPlane.enabled') === true;
}

async function status(deps: SecureAddressRouteDeps): Promise<Record<string, unknown>> {
  const { listener, config } = deps;
  const service = listener.secureAddress;
  const state = listener.state();
  const facts = await service.status();
  const following = facts.group.following;
  const host = state.hostName ?? primaryLanAddress();
  const address = state.serving && state.port !== undefined && host ? `https://${host}:${state.port}` : undefined;
  const authority = await service.localAuthority();
  const plainPort = Number(config.get('controlPlane.port'));
  const lan = primaryLanAddress();
  const groupLines = following
    ? [secureAddressNodeLine(following.name)]
    : facts.group.followers.length > 0 ? [SECURE_ADDRESS_LEAD_LINE, SECURE_ADDRESS_GROUP_LINE] : [];
  // A notice no owner channel carried (a node's own authority set aside): shown at the top of the screen, which marks it given.
  const notice = service.takeScreenNotice();
  return {
    ...(notice ? { notice } : {}),
    intro: SECURE_ADDRESS_INTRO,
    // On the lead of a group, the ways say what differs there: what GoodVibes' own certificate covers, what is sent where.
    choices: secureAddressChoicesFor(service.leadsGroup()).map((choice) => ({ ...choice })),
    groupLines,
    node: following !== undefined,
    inForce: {
      on: config.get('controlPlane.lanHttps.enabled') === true || following !== undefined,
      certificate: facts.source,
      servedToNetwork: servedToNetwork(config),
      serving: state.serving,
      ...(state.port !== undefined ? { port: state.port } : {}),
      ...(address ? { address } : {}),
      ...(state.names ? { names: [...state.names] } : {}),
      ...(state.notAfter !== undefined ? { notAfter: state.notAfter } : {}),
      ...(state.problem ? { problem: state.problem } : {}),
      ...(state.from ? { from: state.from } : {}),
      ...(state.source ? { servedSource: state.source } : {}),
    },
    letsEncrypt: facts.letsEncrypt,
    ownFiles: facts.ownFiles,
    localAuthority: { ...authority, ...(lan && Number.isInteger(plainPort) ? { page: `http://${lan}:${plainPort}${LAN_HTTPS_PAGE_PATH}` } : {}) },
    tailscale: { ...(deps.tailscaleOrigin() ? { address: deps.tailscaleOrigin()! } : {}) },
    group: facts.group,
    // The lead's "Issue a new certificate now" (secureAddress.reissue): shown where it can act.
    reissue: {
      title: SECURE_ADDRESS_REISSUE_TITLE,
      line: secureAddressReissueLine(service.leadsGroup(), facts.source),
      available: following === undefined && config.get('controlPlane.lanHttps.enabled') === true && facts.source !== 'own-files',
    },
  };
}

function refuse(message: string, field?: string): never {
  throw new GatewayVerbError(message, 'SECURE_ADDRESS_INVALID', 400, field);
}

function createSetHandler(deps: SecureAddressRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const service = deps.listener.secureAddress;
    const following = service.groupFollowing();
    if (following) throw new GatewayVerbError(`${secureAddressNodeLine(following.name)} Set it up on ${following.name}.`, 'SECURE_ADDRESS_NODE', 409);
    const choice = params['certificate'];
    if (choice !== 'lets-encrypt' && choice !== 'own-files' && choice !== 'local-authority' && choice !== 'off') {
      refuse('certificate must be one of lets-encrypt, own-files, local-authority or off', 'certificate');
    }
    if (choice === 'off') {
      deps.config.setDaemonValues({ 'controlPlane.lanHttps.enabled': false });
      await deps.listener.resync();
      return status(deps);
    }
    const values: Record<string, unknown> = { 'secureAddress.certificate': choice, 'controlPlane.lanHttps.enabled': true };
    if (choice === 'lets-encrypt') {
      const domain = typeof params['domain'] === 'string' ? params['domain'].trim().toLowerCase().replace(/\.$/, '') : String(deps.config.get('secureAddress.domain') ?? '');
      if (!DOMAIN.test(domain)) refuse('Give the name phones will open, under a domain you own: for example gv.example.com (no https://, no port, no *).', 'domain');
      values['secureAddress.domain'] = domain;
      const token = typeof params['cloudflareToken'] === 'string' ? params['cloudflareToken'].trim() : '';
      try {
        // A token given here is stored only once Cloudflare accepted it for the name's zone.
        if (token) await service.storeCloudflareToken(token, domain);
        else {
          const known = (await service.status()).letsEncrypt;
          // A secret store this computer could not read is said as such: the token the person gave is not asked for again.
          if (!known.tokenStored && known.tokenUnreadable) refuse(known.tokenUnreadable, 'cloudflareToken');
          if (!known.tokenStored) refuse('No Cloudflare API token is stored: give one with the permission Zone, DNS, Edit on the zone that holds the name (dash.cloudflare.com, My Profile, API Tokens, template "Edit zone DNS").', 'cloudflareToken');
        }
      } catch (error) {
        if (error instanceof DnsProviderError) refuse(error.message, 'cloudflareToken');
        throw error;
      }
      service.forgetLastFailure();
    }
    if (choice === 'own-files') {
      const certFile = typeof params['certFile'] === 'string' ? params['certFile'].trim() : '';
      const keyFile = typeof params['keyFile'] === 'string' ? params['keyFile'].trim() : '';
      // Checked when given: a pair that cannot be served changes nothing.
      const check = readOwnCertificate({ certFile, keyFile });
      if (!check.ok) refuse(check.problem ?? 'These files cannot be served.', 'certFile');
      values['secureAddress.certFile'] = certFile;
      values['secureAddress.keyFile'] = keyFile;
    }
    if (!servedToNetwork(deps.config) && deps.serveToNetwork) await deps.serveToNetwork();
    deps.config.setDaemonValues(values);
    await deps.listener.resync();
    if (choice === 'lets-encrypt') {
      await service.startIssue(true).catch(() => {});
      await service.settled();
    }
    return status(deps);
  };
}

/**
 * `secureAddress.reissue`, the screen's "Issue a new certificate now": on a
 * lead or a machine of its own, a new certificate with a new key at once
 * (Let's Encrypt, or GoodVibes' own certificate), sent on to the machines that
 * follow it. Refused on a node, with https off, and for a certificate the
 * person made (they renew it themselves).
 */
function createReissueHandler(deps: SecureAddressRouteDeps): GatewayMethodHandler {
  return async () => {
    const service = deps.listener.secureAddress;
    const following = service.groupFollowing();
    if (following) throw new GatewayVerbError(`${secureAddressNodeLine(following.name)} A new certificate is issued on ${following.name}.`, 'SECURE_ADDRESS_NODE', 409);
    if (deps.config.get('controlPlane.lanHttps.enabled') !== true) {
      throw new GatewayVerbError('The https address is off: choose one of the ways on the Secure address screen first.', 'SECURE_ADDRESS_UNAVAILABLE', 409);
    }
    if (deps.config.get('secureAddress.certificate') === 'own-files') {
      throw new GatewayVerbError('This computer serves a certificate you made: GoodVibes cannot issue a new one for it. Put the renewed certificate and its key in the same files; they are read again at the next start of the https listener.', 'SECURE_ADDRESS_UNAVAILABLE', 409);
    }
    const outcome = await service.reissueNow();
    return { ok: outcome.ok, words: outcome.words, status: await status(deps) };
  };
}

export const SECURE_ADDRESS_METHOD_IDS: readonly string[] = ['secureAddress.get', 'secureAddress.set', 'secureAddress.reissue'];

export function registerSecureAddressGatewayMethods(catalog: GatewayMethodCatalog, deps: SecureAddressRouteDeps): void {
  attachHandler(catalog, 'secureAddress.get', () => status(deps));
  attachHandler(catalog, 'secureAddress.set', createSetHandler(deps));
  attachHandler(catalog, 'secureAddress.reissue', createReissueHandler(deps));
}
