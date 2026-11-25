/**
 * secure-address.ts, the one owner of "which certificate the daemon's https
 * listener serves" (listener.ts asks `resolve` at every sync and serves what
 * it answers), and everything that keeps that certificate current:
 *
 *  - `secureAddress.certificate` (read here and nowhere else) picks the
 *    source: the local authority (authority.ts, as in 3.5.0), the person's own
 *    files (own-certificate.ts), or Let's Encrypt (acme.ts with a DNS
 *    provider, Cloudflare first: cloudflare-dns.ts);
 *  - on a machine that joined a group whose lead has a secure address, the
 *    lead's certificate, received sealed over the group's channel
 *    (group-share.ts), replaces all of these while the machine is a node.
 *
 * When it is checked (no timer of its own):
 *  - every listener sync: each daemon start, each listener bind (a changed
 *    address, port or binding), each change of a `secureAddress.*` or
 *    `controlPlane.lanHttps.*` setting (config subscriptions in facade.ts);
 *  - each request the https listener serves: one comparison of the served
 *    certificate's renewal time with the clock;
 *  - each daemon heartbeat (the existing `daemon-heartbeat` watcher,
 *    `watchers.heartbeatIntervalMs`, 15 s by default): the same comparison,
 *    so a certificate is renewed although no phone asked and nothing rebound.
 * Let's Encrypt is renewed when under 30 days remain; a failed attempt is not
 * repeated by itself for an hour (Let's Encrypt limits failed proofs), and a
 * change made on the screen tries at once.
 *
 * Secrets (credential-scope-registry.ts): `secureAddress.acmeAccount` (the
 * ACME account key), `secureAddress.certificate` (this machine's Let's
 * Encrypt certificate and key), `secureAddress.groupCertificate` (the copy a
 * node received from its lead). None is logged, returned or written plain.
 * Non-secret facts (the last attempt, the notices given, the address records
 * written, whom the group certificate was shared with) are kept in
 * `<control-plane dir>/secure-address.json`.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import { CLOUDFLARE_API_TOKEN_KEY } from '../../cloudflare/constants.js';
import { readCloudflareConfig } from '../../cloudflare/config.js';
import { resolveApiToken, type TokenResolverContext } from '../../cloudflare/cloudflare-token-resolvers.js';
import type { Secret } from '../../security/secret.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import { AcmeClient, AcmeOrderError, newAccountKey, type AcmeAccount } from './acme.js';
import { X509Certificate } from 'node:crypto';
import { lanAuthorityCertificate, lanHostName, lanServerNames, loadOrCreateLanAuthority, type LanAuthoritySecrets } from './authority.js';
import { CloudflareDnsProvider } from './cloudflare-dns.js';
import { DnsProviderError, type DnsProvider } from './dns-provider.js';
import { checkCertificatePair, nameCovered, publicCheck, readOwnCertificate, ownCertificateStamp, type OwnCertificateCheck } from './own-certificate.js';
import { LETS_ENCRYPT_DIRECTORY } from './secure-address-words.js';
import { isLanAddress, issueLanServerCertificate } from './x509.js';
import { httpsCertificateSource, type HttpsCertificateSource } from './served-https.js';

export { httpsCertificateSource, type HttpsCertificateSource } from './served-https.js';

/** The certificate the https listener serves, with its key (held in memory by the listener only). */
export interface ServedCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly names: readonly string[];
  readonly notAfter: number;
  readonly source: HttpsCertificateSource;
  /** `group`: received from the lead of this machine's group. */
  readonly from: 'this-machine' | 'group';
  /** The name a phone opens, when the certificate is for a name rather than this machine's own addresses. */
  readonly hostName?: string | undefined;
  /** When to make or fetch a new one (epoch ms). */
  readonly renewAt: number;
}

export type CertificateResolution =
  | { readonly ok: true; readonly certificate: ServedCertificate }
  | { readonly ok: false; readonly problem: string };

/** The secret-store keys this file owns (classified in config/credential-scope-registry.ts). */
export const SECURE_ADDRESS_SECRET_KEYS = {
  acmeAccount: 'secureAddress.acmeAccount',
  certificate: 'secureAddress.certificate',
  groupCertificate: 'secureAddress.groupCertificate',
} as const;

/** The daemon's secret store as this file uses it: the authority's calls and what the Cloudflare token resolver reads. */
export type SecureAddressSecrets = LanAuthoritySecrets & NonNullable<TokenResolverContext['secretsManager']>;

/** This machine's Let's Encrypt certificate, as kept in the secret store. */
interface StoredLetsEncrypt {
  readonly version: 1;
  readonly domain: string;
  readonly directory: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly names: readonly string[];
  readonly notAfter: number;
  readonly issuedAt: number;
}

/** A node's copy of its lead's certificate, as kept in the secret store. */
export interface StoredGroupCertificate {
  readonly version: 1;
  readonly groupId: string;
  readonly lead: string;
  readonly leadName: string;
  readonly source: HttpsCertificateSource;
  readonly certPem: string;
  readonly keyPem: string;
  readonly names: readonly string[];
  readonly notAfter: number;
  readonly hostName?: string | undefined;
  readonly fingerprint: string;
  readonly receivedAt: number;
}

/** The non-secret facts kept beside the daemon's settings. */
interface SecureAddressState {
  version: 1;
  /** The certificate (sha-256 fingerprint) the person was told is ending within a fortnight. */
  expiryNoticeFor?: string | undefined;
  /** The last Let's Encrypt attempt. */
  lastAttempt?: { at: number; ok: boolean; words: string; pauses?: boolean | undefined } | undefined;
  /** Address records written: name to address. */
  addressRecords?: Record<string, string> | undefined;
  /** The group whose set-aside notice was given (a node's own authority kept while it follows the lead). */
  setAsideNoticeFor?: string | undefined;
  /** Whom this lead sent its Let's Encrypt certificate (issued at `issuedAt`) to, under which signing generation. */
  groupShare?: { groupId: string; generation: number; issuedAt: number; sharedWith: string[] } | undefined;
}

const DAY_MS = 86_400_000;
const LETS_ENCRYPT_RENEW_MS = 30 * DAY_MS;
const OWN_NOTICE_MS = 14 * DAY_MS;
const FAILURE_PAUSE_MS = 60 * 60 * 1000;

function revealJson<T>(secret: Secret | null): T | null {
  if (!secret) return null;
  try { return JSON.parse(secret.reveal('dispatch')) as T; } catch { return null; }
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** This machine's address on its home network: a private IPv4 address, preferring 192.168, then 10, then 172.16. */
export function primaryLanAddress(addresses: readonly string[] = lanServerNames().addresses): string | undefined {
  const rank = (address: string): number => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 9;
  return addresses.filter((address) => rank(address) < 9 && isLanAddress(address)).sort((a, b) => rank(a) - rank(b))[0];
}

/** A label for a machine under the group's name: its host name in lower case, letters, digits and hyphens. */
export function machineLabel(hostName: string, fallback: string): string {
  const label = hostName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return label || fallback.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'node';
}

/** The words for the router check, when this machine's own lookup does not return the address written. */
export function rebindingWords(name: string, address: string, found: readonly string[] | string): string {
  const seen = typeof found === 'string' ? `no answer (${found})` : found.length > 0 ? found.join(', ') : 'no address';
  return `This computer looked ${name} up and got ${seen}, although its address record says ${address}. Your router (or the DNS server your network uses) most likely refuses DNS answers that point at a local address, a protection called DNS rebinding protection, so phones on your network cannot open the name either. On the router, allow this one name: on a FRITZ!Box, Home Network, Network, Network Settings, DNS rebind protection, add ${name}; on OpenWrt or another dnsmasq router, add it to rebind_domain (or turn off "Rebind protection" under DHCP and DNS); on pfSense or OPNsense, add it to the DNS resolver's private domains; on other routers look for "DNS rebinding". If you only just set this up, the name may need a minute to reach your network; it is checked again at the next start of the https listener.`;
}

export interface SecureAddressDeps {
  readonly config: () => Pick<ConfigManager, 'get' | 'set' | 'setDaemonValues' | 'getControlPlaneConfigDir'>;
  readonly secrets: () => SecureAddressSecrets | null | undefined;
  /** Put one line in front of the owner (owner-alert.ts); never throws. */
  readonly alertOwner?: ((text: string) => void) | undefined;
  /** The DNS provider for the names (tests pass a stand-in); default: Cloudflare with the product's token. */
  readonly dnsProvider?: (() => DnsProvider) | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** This machine's DNS lookup, for the router check. */
  readonly lookup?: ((name: string) => Promise<readonly string[]>) | undefined;
  readonly now?: (() => number) | undefined;
}

/** What a lead needs from the group to share its certificate (group-share.ts implements it). */
export interface SecureAddressGroupLink {
  /** This machine leads: the members that follow it, with what they reported. */
  followers(): readonly GroupFollower[];
  /** The group's id and the generation of its signing key (changed by a removal or `/cluster rotate`). */
  groupFacts(): { readonly groupId: string; readonly generation: number } | null;
  /** Send the certificate in force to every follower (sealed to each). */
  share(): Promise<void>;
  /** The lead this machine follows, when it is a node. */
  following(): { readonly nodeId: string; readonly name: string } | null;
}

export interface GroupFollower {
  readonly nodeId: string;
  readonly name: string;
  readonly label: string;
  readonly hostName: string;
  readonly addresses: readonly string[];
}

export class SecureAddressService {
  private issuing: Promise<void> | null = null;
  private served: ServedCertificate | null = null;
  private ownStamp = '';
  private ownCheck: OwnCertificateCheck | null = null;
  private routerCheck: { readonly name: string; readonly ok: boolean; readonly words: string } | null = null;
  private addressProblem: string | null = null;
  private group: SecureAddressGroupLink | null = null;
  private resyncListener: (() => Promise<void>) | null = null;
  private dueCheckRunning = false;
  private lastGroupKey = '';

  /** The group facts a lead's certificate depends on, as one string ('' outside a group). */
  private groupKey(): string {
    const facts = this.group?.groupFacts();
    if (!facts || this.group?.following()) return '';
    return `${facts.groupId}:${(this.group?.followers() ?? []).map((follower) => follower.nodeId).sort().join(',')}`;
  }

  constructor(private readonly deps: SecureAddressDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** The listener's own resync, called when a new certificate is ready. */
  attachListener(resync: () => Promise<void>): void { this.resyncListener = resync; }

  attachGroup(link: SecureAddressGroupLink | null): void { this.group = link; }

  /** What the listener serves now (set by it after each sync). */
  noteServed(certificate: ServedCertificate | null): void { this.served = certificate; }

  servedCertificate(): ServedCertificate | null { return this.served; }

  /** The lead this machine follows, when it is a node of a group whose lead has a secure address. */
  groupFollowing(): { readonly nodeId: string; readonly name: string } | null { return this.group?.following() ?? null; }

  // ── state file ────────────────────────────────────────────────────────────

  private statePath(): string | null {
    try { return `${this.deps.config().getControlPlaneConfigDir()}/secure-address.json`; } catch { return null; }
  }

  private readState(): SecureAddressState {
    const path = this.statePath();
    if (!path || !existsSync(path)) return { version: 1 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SecureAddressState;
      return parsed.version === 1 ? parsed : { version: 1 };
    } catch { return { version: 1 }; }
  }

  private writeState(change: (state: SecureAddressState) => void): void {
    const path = this.statePath();
    if (!path) return;
    const state = this.readState();
    change(state);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      logger.warn('secure address: its state could not be saved', { error: summarizeError(error) });
    }
  }

  // ── what the listener serves ──────────────────────────────────────────────

  /**
   * The certificate to serve now. A node of a group serves its lead's copy;
   * otherwise the source the settings name. Starts a Let's Encrypt order in
   * the background when none is held (the listener is synced again when it
   * lands). Never throws.
   */
  async resolve(): Promise<CertificateResolution> {
    try {
      const copy = await this.groupCopy();
      const following = this.group?.following() ?? null;
      if (following) {
        if (copy && copy.groupId === this.group?.groupFacts()?.groupId) {
          return { ok: true, certificate: { certPem: copy.certPem, keyPem: copy.keyPem, names: copy.names, notAfter: copy.notAfter, source: copy.source, from: 'group', hostName: copy.hostName, renewAt: copy.notAfter } };
        }
        return { ok: false, problem: `This machine is a node of ${following.name}: its secure address comes from there, and ${following.name} has not sent it yet.` };
      }
      // Not a node (any more): a copy of a group's certificate is not kept.
      if (copy) await this.deleteGroupCopy();
      const config = this.deps.config();
      const source = httpsCertificateSource(config);
      if (source === 'own-files') return this.resolveOwnFiles();
      if (source === 'lets-encrypt') return await this.resolveLetsEncrypt();
      return await this.resolveLocalAuthority();
    } catch (error) {
      return { ok: false, problem: summarizeError(error) };
    }
  }

  private resolveOwnFiles(): CertificateResolution {
    const config = this.deps.config();
    const files = { certFile: String(config.get('secureAddress.certFile') ?? ''), keyFile: String(config.get('secureAddress.keyFile') ?? '') };
    const read = readOwnCertificate(files, this.now());
    this.ownStamp = read.stamp;
    this.ownCheck = publicCheck(read);
    if (!read.ok) return { ok: false, problem: read.problem ?? 'The certificate files cannot be served.' };
    const hostName = read.names.find((name) => !name.startsWith('*.') && !/^[\d.:]+$/.test(name));
    return { ok: true, certificate: { certPem: read.certPem, keyPem: read.keyPem, names: read.names, notAfter: read.notAfter!, source: 'own-files', from: 'this-machine', hostName, renewAt: read.notAfter! } };
  }

  private async resolveLocalAuthority(): Promise<CertificateResolution> {
    const secrets = this.deps.secrets();
    if (!secrets) return { ok: false, problem: 'this daemon has no secret store to keep the certificate authority in' };
    const authority = await loadOrCreateLanAuthority(secrets);
    const names = lanServerNames();
    // A lead's one server certificate covers every machine of its group as well.
    const dnsNames = new Set(names.dnsNames);
    const addresses = new Set(names.addresses);
    for (const follower of this.group?.followers() ?? []) {
      if (follower.hostName) { dnsNames.add(follower.hostName); dnsNames.add(`${follower.hostName}.local`); }
      for (const address of follower.addresses) if (isLanAddress(address)) addresses.add(address);
    }
    const certificate = issueLanServerCertificate(authority, { dnsNames: [...dnsNames].filter((name) => /^[a-z0-9.-]+$/.test(name)), addresses: [...addresses] });
    return { ok: true, certificate: { certPem: certificate.certPem, keyPem: certificate.keyPem, names: [...certificate.dnsNames, ...certificate.addresses], notAfter: certificate.notAfter, source: 'local-authority', from: 'this-machine', renewAt: certificate.notAfter - DAY_MS } };
  }

  /** The domain and the names its certificate covers: the name, and every name directly under it (one per machine of a group). */
  private letsEncryptNames(domain: string): string[] {
    return [domain, `*.${domain}`];
  }

  private async storedLetsEncrypt(): Promise<StoredLetsEncrypt | null> {
    const secrets = this.deps.secrets();
    if (!secrets) return null;
    return revealJson<StoredLetsEncrypt>(await secrets.get(SECURE_ADDRESS_SECRET_KEYS.certificate));
  }

  private async resolveLetsEncrypt(): Promise<CertificateResolution> {
    const config = this.deps.config();
    const domain = String(config.get('secureAddress.domain') ?? '').trim().toLowerCase();
    if (!domain) return { ok: false, problem: 'Let\'s Encrypt is chosen but no name is given: set the name under your domain that phones open (secureAddress.domain).' };
    const stored = await this.storedLetsEncrypt();
    const now = this.now();
    const usable = stored && stored.domain === domain && stored.notAfter > now && this.letsEncryptNames(domain).every((name) => stored.names.includes(name));
    if (!usable || this.reissueNeeded(stored)) void this.startIssue(false);
    if (!usable) {
      const last = this.readState().lastAttempt;
      return { ok: false, problem: this.issuing ? `Asking Let's Encrypt for a certificate for ${domain}; the https address starts as soon as it arrives.` : last && !last.ok ? last.words : `No certificate for ${domain} yet.` };
    }
    // The address record follows this machine's address: checked at each sync (start and bind).
    void this.syncAddressRecords(domain);
    return { ok: true, certificate: { certPem: stored.certPem, keyPem: stored.keyPem, names: stored.names, notAfter: stored.notAfter, source: 'lets-encrypt', from: 'this-machine', hostName: domain, renewAt: stored.notAfter - LETS_ENCRYPT_RENEW_MS } };
  }

  /** A lead reissues when a machine that held the certificate's key left the group or was removed from it. */
  private reissueNeeded(stored: StoredLetsEncrypt | null): boolean {
    const shared = this.readState().groupShare;
    if (!stored || !shared || shared.issuedAt !== stored.issuedAt) return false;
    const facts = this.group?.groupFacts();
    if (!facts || facts.groupId !== shared.groupId) return shared.sharedWith.length > 0;
    const current = new Set((this.group?.followers() ?? []).map((follower) => follower.nodeId));
    return shared.sharedWith.some((member) => !current.has(member));
  }

  /** Record whom the group certificate in force was sent to, so a member's removal reissues it. */
  noteShared(groupId: string, generation: number, sharedWith: readonly string[]): void {
    void this.storedLetsEncrypt().then((stored) => {
      const issuedAt = httpsCertificateSource(this.deps.config()) === 'lets-encrypt' ? stored?.issuedAt ?? 0 : 0;
      this.writeState((state) => {
        const before = state.groupShare && state.groupShare.issuedAt === issuedAt && state.groupShare.groupId === groupId ? state.groupShare.sharedWith : [];
        state.groupShare = { groupId, generation, issuedAt, sharedWith: [...new Set([...before, ...sharedWith])] };
      });
    });
  }

  private dnsProvider(): DnsProvider {
    if (this.deps.dnsProvider) return this.deps.dnsProvider();
    const config = this.deps.config();
    return new CloudflareDnsProvider(async () => (await this.cloudflareToken(config)).value);
  }

  /** The product's Cloudflare token (cloudflare-token-resolvers.ts): the setting's reference, the environment, the stored secret. */
  private async cloudflareToken(config: Pick<ConfigManager, 'get'>): Promise<{ readonly value: string | null; readonly source: string }> {
    return resolveApiToken({ secretsManager: this.deps.secrets(), readConfig: () => readCloudflareConfig(config) }, {});
  }

  /**
   * "Issue a new certificate now" (secureAddress.reissue): a new certificate
   * with a new key at once, served here and sent to the machines that follow
   * this one. Let's Encrypt is asked for one (an order already running is let
   * finish first); GoodVibes' own certificate makes a new server certificate.
   * The caller refuses a node, https switched off and a certificate the
   * person made. Returns the words for the screen; never a key.
   */
  async reissueNow(): Promise<{ readonly ok: boolean; readonly words: string }> {
    const source = httpsCertificateSource(this.deps.config());
    if (source === 'lets-encrypt') {
      if (this.issuing) await this.issuing;
      await this.startIssue(true);
      const last = this.readState().lastAttempt;
      return { ok: last?.ok === true, words: last?.words ?? 'Let\'s Encrypt did not answer.' };
    }
    await this.resyncListener?.();
    await this.group?.share();
    const served = this.served;
    return served
      ? { ok: true, words: `A new certificate from GoodVibes' own certificate authority is served, valid until ${day(served.notAfter)}; phones that installed the authority trust it as before.` }
      : { ok: false, words: 'No new certificate is served: the https address could not start (the screen says why).' };
  }

  /**
   * Ask Let's Encrypt for the certificate, once at a time. `now` (a change on
   * the screen) tries at once; otherwise a failure in the last hour waits.
   */
  startIssue(now: boolean): Promise<void> {
    if (this.issuing) return this.issuing;
    const last = this.readState().lastAttempt;
    if (!now && last && !last.ok && last.pauses !== false && this.now() - last.at < FAILURE_PAUSE_MS) return Promise.resolve();
    const run = this.issue().finally(() => { this.issuing = null; });
    this.issuing = run;
    return run;
  }

  private async issue(): Promise<void> {
    const config = this.deps.config();
    const secrets = this.deps.secrets();
    const domain = String(config.get('secureAddress.domain') ?? '').trim().toLowerCase();
    const directory = String(config.get('secureAddress.acmeDirectory') ?? '') || LETS_ENCRYPT_DIRECTORY;
    if (!secrets || !domain) return;
    const previous = await this.storedLetsEncrypt();
    try {
      const dns = this.dnsProvider();
      await dns.zoneFor(domain);
      const client = new AcmeClient({ directoryUrl: directory, fetch: this.deps.fetch });
      let account = revealJson<AcmeAccount>(await secrets.get(SECURE_ADDRESS_SECRET_KEYS.acmeAccount));
      if (!account || account.directory !== directory) {
        const keyPem = newAccountKey();
        const url = await client.account(keyPem);
        account = { version: 1, directory, keyPem, url };
        await secrets.set(SECURE_ADDRESS_SECRET_KEYS.acmeAccount, JSON.stringify(account));
      }
      const issued = await client.order(account, this.letsEncryptNames(domain), dns);
      const record: StoredLetsEncrypt = {
        version: 1, domain, directory, certPem: issued.certPem, keyPem: issued.keyPem, names: issued.names, notAfter: issued.notAfter, issuedAt: this.now(),
      };
      await secrets.set(SECURE_ADDRESS_SECRET_KEYS.certificate, JSON.stringify(record));
      const words = `Let's Encrypt issued the certificate for ${domain} and every name under it, valid until ${day(issued.notAfter)}; it is renewed by itself from ${day(issued.notAfter - LETS_ENCRYPT_RENEW_MS)}.`;
      this.writeState((state) => { state.lastAttempt = { at: this.now(), ok: true, words }; });
      logger.info('secure address: certificate issued', { domain, notAfter: issued.notAfter });
      await this.resyncListener?.();
      await this.group?.share();
    } catch (error) {
      const words = error instanceof AcmeOrderError || error instanceof DnsProviderError
        ? error.message
        : `The certificate for ${domain} could not be obtained: ${summarizeError(error)}. Nothing was issued.`;
      const keeps = previous && previous.notAfter > this.now() ? ` The https address keeps the certificate it has, valid until ${day(previous.notAfter)}; it is tried again in an hour or at the next change on the Secure address screen.` : '';
      // Only a refusal by the certificate authority pauses the automatic attempts for an hour (it limits failed proofs);
      // a missing token or an unreachable DNS service is tried again at the next check.
      const pauses = error instanceof AcmeOrderError;
      this.writeState((state) => { state.lastAttempt = { at: this.now(), ok: false, words: `${words}${keeps}`, pauses }; });
      logger.warn('secure address: the certificate was not issued', { domain, reason: words });
      // A renewal that fails close to the end is put in front of the owner; a first attempt is answered on the screen that asked.
      if (previous && previous.notAfter - this.now() < 7 * DAY_MS) this.deps.alertOwner?.(`The https certificate for ${domain} ends on ${day(previous.notAfter)} and could not be renewed: ${words}`);
    }
  }

  /**
   * Point `domain` (and each follower's name under it) at the machine's
   * address, when it differs from what was written; then look the name up
   * from this machine to catch a router that refuses local answers.
   */
  private async syncAddressRecords(domain: string): Promise<void> {
    const address = primaryLanAddress();
    if (!address) { this.addressProblem = 'This computer has no private network address (192.168.x.x, 10.x.x.x or 172.16-31.x.x) to point the name at.'; return; }
    const wanted: Record<string, string> = { [domain]: address };
    for (const follower of this.group?.followers() ?? []) {
      const followerAddress = primaryLanAddress(follower.addresses);
      if (followerAddress) wanted[`${follower.label}.${domain}`] = followerAddress;
    }
    const written = this.readState().addressRecords ?? {};
    try {
      const dns = this.dnsProvider();
      for (const [name, value] of Object.entries(wanted)) {
        if (written[name] === value) continue;
        await dns.setAddressRecord(name, value);
        this.writeState((state) => { state.addressRecords = { ...(state.addressRecords ?? {}), [name]: value }; });
      }
      // A follower that is gone: its record is removed, so its name no longer leads anywhere.
      for (const name of Object.keys(written)) {
        if (name in wanted || !name.endsWith(`.${domain}`)) continue;
        await dns.removeAddressRecord(name);
        this.writeState((state) => { if (state.addressRecords) delete state.addressRecords[name]; });
      }
      this.addressProblem = null;
    } catch (error) {
      this.addressProblem = error instanceof DnsProviderError ? error.message : `The address record could not be written: ${summarizeError(error)}`;
      return;
    }
    try {
      const found = await (this.deps.lookup ?? (async (name: string) => (await dnsLookup(name, { all: true, family: 4 })).map((entry) => entry.address)))(domain);
      this.routerCheck = found.includes(address)
        ? { name: domain, ok: true, words: `This computer looks ${domain} up and gets ${address}: phones on the same network get the same answer.` }
        : { name: domain, ok: false, words: rebindingWords(domain, address, found) };
    } catch (error) {
      this.routerCheck = { name: domain, ok: false, words: rebindingWords(domain, address, (error as NodeJS.ErrnoException).code ?? summarizeError(error)) };
    }
  }

  // ── when it is checked ────────────────────────────────────────────────────

  /**
   * One comparison of the served certificate's renewal time with the clock,
   * at each https request and each daemon heartbeat; the work it starts runs
   * in the background and syncs the listener again when it lands.
   */
  checkDue(): void {
    const served = this.served;
    const now = this.now();
    if (this.dueCheckRunning || served === null || served.from !== 'this-machine') return;
    const source = served.source;
    const due = now >= served.renewAt;
    // A lead's group changed (a member joined, left or was removed; a key rotation is not a change here): compared as one string, read again only when it differs.
    const groupKey = this.groupKey();
    const groupChanged = groupKey !== this.lastGroupKey;
    const ownFilesNear = source === 'own-files' && now >= served.notAfter - OWN_NOTICE_MS;
    if (!due && !groupChanged && !ownFilesNear) return;
    this.lastGroupKey = groupKey;
    this.dueCheckRunning = true;
    void (async () => {
      try {
        if (source === 'lets-encrypt' && (due || this.reissueNeeded(await this.storedLetsEncrypt()))) await this.startIssue(false);
        else if (source === 'local-authority' && (due || groupChanged)) { await this.resyncListener?.(); if (groupChanged) await this.group?.share(); }
        else if (source === 'own-files') await this.checkOwnFiles(served, now);
      } catch (error) {
        logger.warn('secure address: the certificate check failed', { error: summarizeError(error) });
      } finally { this.dueCheckRunning = false; }
    })();
  }

  private async checkOwnFiles(served: ServedCertificate, now: number): Promise<void> {
    const config = this.deps.config();
    const files = { certFile: String(config.get('secureAddress.certFile') ?? ''), keyFile: String(config.get('secureAddress.keyFile') ?? '') };
    // Once the served one has ended (browsers refuse it), the files are compared, and read again when they changed.
    if (now >= served.notAfter && ownCertificateStamp(files) !== this.ownStamp) { await this.resyncListener?.(); return; }
    if (now >= served.notAfter - OWN_NOTICE_MS) {
      const fingerprint = this.ownCheck?.fingerprint;
      if (fingerprint && this.readState().expiryNoticeFor !== fingerprint) {
        this.writeState((state) => { state.expiryNoticeFor = fingerprint; });
        this.deps.alertOwner?.(`The https certificate you gave GoodVibes (${files.certFile}) ends on ${day(served.notAfter)}. Put the renewed certificate and its key in the same files before then; they are read again at the next start of the https listener, or once the old one has ended.`);
      }
    }
  }

  // ── a node's copy ─────────────────────────────────────────────────────────

  async groupCopy(): Promise<StoredGroupCertificate | null> {
    const secrets = this.deps.secrets();
    if (!secrets) return null;
    return revealJson<StoredGroupCertificate>(await secrets.get(SECURE_ADDRESS_SECRET_KEYS.groupCertificate));
  }

  /** Keep a copy received from the lead (checked: the key belongs to the certificate) and serve it. */
  async keepGroupCopy(copy: Omit<StoredGroupCertificate, 'version' | 'receivedAt' | 'fingerprint'>): Promise<{ readonly ok: boolean; readonly problem?: string | undefined }> {
    const secrets = this.deps.secrets();
    if (!secrets) return { ok: false, problem: 'this daemon has no secret store' };
    const check = checkCertificatePair(copy.certPem, copy.keyPem, '', this.now());
    if (!check.ok) return { ok: false, problem: check.problem };
    const record: StoredGroupCertificate = { version: 1, ...copy, fingerprint: check.fingerprint ?? '', receivedAt: this.now() };
    const before = await this.groupCopy();
    if (before?.fingerprint === record.fingerprint && before.groupId === record.groupId) return { ok: true };
    await secrets.set(SECURE_ADDRESS_SECRET_KEYS.groupCertificate, JSON.stringify(record));
    await this.noteSetAside(copy.groupId, copy.leadName);
    await this.resyncListener?.();
    return { ok: true };
  }

  /** Drop the copy received from a lead (this machine left its group, was removed, or the lead stopped). */
  async dropGroupCopy(): Promise<boolean> {
    if (!(await this.deleteGroupCopy())) return false;
    await this.resyncListener?.();
    return true;
  }

  private async deleteGroupCopy(): Promise<boolean> {
    const secrets = this.deps.secrets();
    if (!secrets || !(await this.groupCopy())) return false;
    await secrets.delete(SECURE_ADDRESS_SECRET_KEYS.groupCertificate);
    logger.info('secure address: the copy of the group\'s certificate was dropped');
    return true;
  }

  /** The one carried-forward notice: this machine's own authority is kept, set aside while it follows the lead. */
  private async noteSetAside(groupId: string, leadName: string): Promise<void> {
    if (this.readState().setAsideNoticeFor === groupId) return;
    const secrets = this.deps.secrets();
    const own = secrets ? await secrets.get('controlPlane.lanHttps.authority') : null;
    this.writeState((state) => { state.setAsideNoticeFor = groupId; });
    if (own) this.deps.alertOwner?.(`This machine now serves https with the certificate of its group's lead, ${leadName}. Its own GoodVibes certificate authority is kept, set aside: phones that installed it trust this machine again if it leaves the group; while it is a node they trust it through the lead's certificate.`);
  }

  // ── for the screen ────────────────────────────────────────────────────────

  /** The facts the Secure address screen shows; no key, no token. */
  async status(): Promise<SecureAddressStatusFacts> {
    const config = this.deps.config();
    const stored = await this.storedLetsEncrypt();
    const copy = await this.groupCopy();
    const state = this.readState();
    const domain = String(config.get('secureAddress.domain') ?? '');
    const tokenSource = (await this.cloudflareToken(config).catch(() => ({ source: 'missing' }))).source;
    const followers = this.group?.followers() ?? [];
    const servedNames = this.served?.names ?? [];
    return {
      source: httpsCertificateSource(config),
      letsEncrypt: {
        domain,
        tokenStored: tokenSource !== 'missing',
        ...(stored ? { certificate: { names: stored.names, notAfter: stored.notAfter, issuedAt: stored.issuedAt } } : {}),
        issuing: this.issuing !== null,
        ...(state.lastAttempt ? { lastAttempt: { at: state.lastAttempt.at, ok: state.lastAttempt.ok, words: state.lastAttempt.words } } : {}),
        ...(this.addressProblem ? { addressProblem: this.addressProblem } : {}),
        ...(this.routerCheck ? { routerCheck: this.routerCheck } : {}),
        addressRecords: state.addressRecords ?? {},
      },
      ownFiles: {
        certFile: String(config.get('secureAddress.certFile') ?? ''),
        keyFile: String(config.get('secureAddress.keyFile') ?? ''),
        ...(this.ownCheck ? { check: { ok: this.ownCheck.ok, ...(this.ownCheck.problem ? { problem: this.ownCheck.problem } : {}), names: [...this.ownCheck.names], ...(this.ownCheck.notAfter ? { notAfter: this.ownCheck.notAfter } : {}) } } : {}),
      },
      group: {
        ...(this.group?.following() ? { following: this.group.following()! } : {}),
        ...(copy ? { received: { leadName: copy.leadName, names: copy.names, notAfter: copy.notAfter, receivedAt: copy.receivedAt, source: copy.source } } : {}),
        followers: followers.map((follower) => {
          const name = this.followerName(follower, domain);
          return { name: follower.name, address: name ?? '', covered: name !== undefined && (servedNames.length === 0 || nameCovered(name, servedNames) || follower.addresses.some((address) => servedNames.includes(address))), needs: this.followerNeeds(follower, domain) };
        }),
      },
    };
  }

  /** The name a follower is opened at under the certificate in force. */
  followerName(follower: GroupFollower, domain = String(this.deps.config().get('secureAddress.domain') ?? '')): string | undefined {
    const source = httpsCertificateSource(this.deps.config());
    if (source === 'lets-encrypt') return domain ? `${follower.label}.${domain}` : undefined;
    if (source === 'own-files') {
      const names = this.served?.names ?? this.ownCheck?.names ?? [];
      const base = names.find((name) => name.startsWith('*.'))?.slice(2);
      const candidates = [...(base ? [`${follower.label}.${base}`] : []), follower.hostName, `${follower.hostName}.local`, ...follower.addresses].filter(Boolean);
      return candidates.find((candidate) => nameCovered(candidate, names) || names.includes(candidate));
    }
    return primaryLanAddress(follower.addresses) ?? follower.hostName;
  }

  /** For a certificate you made that does not cover a follower: the names it would need to cover, in plain words. */
  followerNeeds(follower: GroupFollower, domain?: string): string | undefined {
    if (httpsCertificateSource(this.deps.config()) !== 'own-files' || this.followerName(follower, domain) !== undefined) return undefined;
    const names = this.served?.names ?? this.ownCheck?.names ?? [];
    const base = names.find((name) => name.startsWith('*.'))?.slice(2) ?? names.find((name) => name.includes('.') && !/^[\d.]+$/.test(name));
    const wanted = [base ? `${follower.label}.${base}` : undefined, follower.hostName ? `${follower.hostName}.local` : undefined, primaryLanAddress(follower.addresses)].filter(Boolean).join(', or ');
    return `Your certificate does not cover ${follower.name}, so it is not shared with it. For ${follower.name} to serve https with it, the certificate must also cover one of: ${wanted}${base ? ` (a certificate for *.${base} covers every machine)` : ''}.`;
  }

  /** The name phones open, for the screen and pairing. */
  hostNameFor(config = this.deps.config()): string | undefined {
    if (this.served?.hostName) return this.served.hostName;
    if (httpsCertificateSource(config) === 'lets-encrypt') return String(config.get('secureAddress.domain') ?? '') || undefined;
    return undefined;
  }

  /** Store a Cloudflare token given on the screen, once Cloudflare accepted it for the name's zone. */
  async storeCloudflareToken(token: string, domain: string): Promise<void> {
    const secrets = this.deps.secrets();
    if (!secrets) throw new DnsProviderError('this daemon has no secret store to keep the token in', 'refused');
    const provider = this.deps.dnsProvider ? this.deps.dnsProvider() : new CloudflareDnsProvider(async () => token);
    await provider.zoneFor(domain);
    await secrets.set(CLOUDFLARE_API_TOKEN_KEY, token);
    this.deps.config().set('cloudflare.apiTokenRef', `goodvibes://secrets/goodvibes/${CLOUDFLARE_API_TOKEN_KEY}`);
  }

  /** Whether this machine's own local authority was made, and its public fingerprint (for the screen). */
  async localAuthority(): Promise<{ readonly made: boolean; readonly fingerprint?: string | undefined }> {
    const secrets = this.deps.secrets();
    const pem = secrets ? await lanAuthorityCertificate(secrets) : null;
    return pem ? { made: true, fingerprint: new X509Certificate(pem).fingerprint256 } : { made: false };
  }

  /** The group changed (a node joined, moved or started following): sync the listener again with it. */
  async refreshForGroup(): Promise<void> { await this.resyncListener?.(); }

  /** Wait for an order in flight (the screen's change waits for its outcome). */
  async settled(): Promise<void> { await this.issuing; }

  /** Clear the record of the last failure, so a change on the screen tries at once. */
  forgetLastFailure(): void { this.writeState((state) => { if (state.lastAttempt && !state.lastAttempt.ok) delete state.lastAttempt; }); }

  lanHostName(): string { return lanHostName(); }
}

/** The status facts (the method adds the listener's state and the words). */
export interface SecureAddressStatusFacts {
  readonly source: HttpsCertificateSource;
  readonly letsEncrypt: {
    readonly domain: string;
    readonly tokenStored: boolean;
    readonly certificate?: { readonly names: readonly string[]; readonly notAfter: number; readonly issuedAt: number } | undefined;
    readonly issuing: boolean;
    readonly lastAttempt?: { readonly at: number; readonly ok: boolean; readonly words: string } | undefined;
    readonly addressProblem?: string | undefined;
    readonly routerCheck?: { readonly name: string; readonly ok: boolean; readonly words: string } | undefined;
    readonly addressRecords: Readonly<Record<string, string>>;
  };
  readonly ownFiles: {
    readonly certFile: string;
    readonly keyFile: string;
    readonly check?: { readonly ok: boolean; readonly problem?: string | undefined; readonly names: readonly string[]; readonly notAfter?: number | undefined } | undefined;
  };
  readonly group: {
    readonly following?: { readonly nodeId: string; readonly name: string } | undefined;
    readonly received?: { readonly leadName: string; readonly names: readonly string[]; readonly notAfter: number; readonly receivedAt: number; readonly source: HttpsCertificateSource } | undefined;
    readonly followers: readonly { readonly name: string; readonly address: string; readonly covered: boolean; readonly needs?: string | undefined }[];
  };
}
