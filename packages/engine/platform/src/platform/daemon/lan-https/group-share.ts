/**
 * group-share.ts, a machine group's one secure address: the machine that set
 * one up (the lead) provides it to every machine that joined, and those
 * machines (nodes) set nothing up of their own.
 *
 * Which machine leads: of the members whose https listener is on and who
 * announce it, the one admitted to the group first (the group's creator,
 * when it has one set up); a tie goes to the smaller node id. Every member
 * decides the same from the same announcements and the group's roster.
 *
 * One certificate for the whole group (the owner's ruling): Let's Encrypt for
 * the group's name and every name directly under it (each node is
 * `<its host name>.<group name>`, with its own address record the lead
 * writes); the person's own certificate, shared with each node it covers;
 * or the lead's local authority, whose one server certificate covers every
 * machine's names and addresses, so a phone installs one certificate and
 * trusts every machine. Tailscale is per machine and is not shared.
 *
 * The channel: the group's tenant messages (cluster/group-tenants.ts). Each
 * is signed with the sender's node identity key and checked against the
 * group's roster before it reaches here, inside a datagram signed with the
 * group key; the certificate and its key are sealed to the receiving node's
 * agreement key (cluster/group-crypto.ts sealForMember: x25519 and
 * AES-256-GCM), so only that node can read them. The node keeps them in its
 * own secret store (`secureAddress.groupCertificate`). Nothing here logs,
 * returns or writes a key in the clear.
 *
 * Messages (no timer anywhere):
 *  - SECURE_ADDRESS_LEAD, broadcast by a member whose https is on: at each of
 *    its listener syncs and when a member is heard after silence.
 *  - SECURE_ADDRESS_REPORT, node to lead: its host name and addresses, when
 *    it hears the lead and at each of its own listener binds (so the lead
 *    corrects its address record).
 *  - SECURE_ADDRESS_CERT, lead to one node: the sealed certificate, after each
 *    issue or renewal and when the node reports.
 */
import { X509Certificate } from 'node:crypto';
import { openSealedEnvelope, sealForMember, type NodeKeyPairMaterial } from '../../cluster/group-crypto.js';
import type { GroupTenantHost } from '../../cluster/group-tenants.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { lanHostName, lanServerNames } from './authority.js';
import { machineLabel, type GroupFollower, type HttpsCertificateSource, type SecureAddressGroupLink, type SecureAddressService } from './secure-address.js';

const SEAL_CONTEXT = 'goodvibes-secure-address-v1';
/** SECURE_ADDRESS_LEFT, a member to the group as it leaves (while it still holds the keys): its lead stops sharing with it. */
export const SECURE_ADDRESS_MESSAGE_TYPES = ['SECURE_ADDRESS_LEAD', 'SECURE_ADDRESS_REPORT', 'SECURE_ADDRESS_CERT', 'SECURE_ADDRESS_LEFT'] as const;
/** The most an authority certificate sent with the group's certificate may be (a PEM certificate is about 1 KB). */
const MAX_AUTHORITY_PEM = 8192;

/** What this needs from the group runtime (cluster/group-runtime.ts). */
export interface SecureAddressGroupAccess {
  readonly host: GroupTenantHost;
  /** The group's id, null outside a group. */
  groupId(): string | null;
  /** The current members of the group (this machine included). */
  members(): readonly { readonly nodeId: string; readonly displayName: string; readonly agreementKey: string; readonly admittedAt: number }[];
  /** This machine's agreement key pair, to open what is sealed to it. */
  selfAgreement(): NodeKeyPairMaterial | null;
  /** The generation of the group's signing key: a removal or `/cluster rotate --now` changes it. */
  signingGeneration(): number | null;
  /** Called at once when this machine stops being a member (left, forgotten, removed). */
  onMembershipCleared(listener: () => void): () => void;
  /** Called just before this machine leaves its group, while it still holds the keys (absent: an older runtime). */
  onLeaving?(listener: () => Promise<void>): () => void;
  /** Called when the group's machines, name or key changed, here or on another machine (absent: an older runtime). */
  onGroupChanged?(listener: () => void): () => void;
}

/** The access, read from the group's own runtime. */
export function secureAddressGroupAccess(runtime: {
  tenantHost(): GroupTenantHost;
  readonly groupState: { readonly members: readonly { readonly nodeId: string; readonly displayName: string; readonly agreementKey: string; readonly admittedAt: number }[] } | null;
  readonly keyMaterial: { readonly groupId: string; readonly node: { readonly agreement: NodeKeyPairMaterial }; readonly groupSigning: { readonly generation: number } } | null;
  onMembershipCleared(listener: () => void): () => void;
  onLeaving?(listener: () => Promise<void>): () => void;
  onGroupChanged?(listener: () => void): () => void;
}): SecureAddressGroupAccess {
  return {
    host: runtime.tenantHost(),
    groupId: () => runtime.keyMaterial?.groupId ?? null,
    members: () => runtime.keyMaterial ? runtime.groupState?.members ?? [] : [],
    selfAgreement: () => runtime.keyMaterial?.node.agreement ?? null,
    signingGeneration: () => runtime.keyMaterial?.groupSigning.generation ?? null,
    onMembershipCleared: (listener) => runtime.onMembershipCleared(listener),
    ...(runtime.onLeaving ? { onLeaving: (listener: () => Promise<void>) => runtime.onLeaving!(listener) } : {}),
    ...(runtime.onGroupChanged ? { onGroupChanged: (listener: () => void) => runtime.onGroupChanged!(listener) } : {}),
  };
}

/**
 * The authority certificate the lead sent, kept only when it is a certificate authority that signed the leaf it came
 * with: what a member's page offers phones must be the one that vouches for what that member serves.
 */
function issuingAuthority(raw: unknown, leafPem: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_AUTHORITY_PEM || !raw.includes('-----BEGIN CERTIFICATE-----')) return undefined;
  try {
    const authority = new X509Certificate(raw);
    const leaf = new X509Certificate(leafPem);
    return authority.ca && leaf.checkIssued(authority) && leaf.verify(authority.publicKey) ? raw : undefined;
  } catch { return undefined; }
}

interface Announcement { readonly nodeId: string; readonly on: boolean; readonly source: HttpsCertificateSource; readonly groupName: string }
interface Report { readonly hostName: string; readonly addresses: readonly string[]; readonly port?: number | undefined }

export class SecureAddressGroupShare implements SecureAddressGroupLink {
  private readonly announcements = new Map<string, Announcement>();
  private readonly reports = new Map<string, Report>();
  private selfOn = false;
  private disposers: (() => void)[] = [];

  constructor(private readonly access: SecureAddressGroupAccess, private readonly service: SecureAddressService) {}

  start(): () => void {
    const { host } = this.access;
    this.disposers.push(host.register({ types: SECURE_ADDRESS_MESSAGE_TYPES, handle: (envelope, from) => this.handle(envelope.type, envelope.body, from.nodeId) }));
    this.disposers.push(host.onMemberHeard(() => { void this.announce(); }));
    // A machine that left or was forgotten drops its copy of the group's certificate at once.
    this.disposers.push(this.access.onMembershipCleared(() => {
      this.announcements.clear();
      this.reports.clear();
      void this.service.dropGroupCopy().catch((error: unknown) => logger.warn('secure address: the group copy could not be dropped', { error: summarizeError(error) }));
    }));
    // Leaving: the lead is told while this machine still holds the keys, so it stops sharing its certificate with it and
    // makes a new one with a new key (the roster keeps this machine until a member removes it).
    const leaving = this.access.onLeaving?.(async () => {
      if (!this.following()) return;
      try { await this.access.host.send('SECURE_ADDRESS_LEFT', {}); } catch { /* a lead that missed it reissues once this machine is removed */ }
    });
    if (leaving) this.disposers.push(leaving);
    // A machine joined, left or was removed (here or on another machine): the lead's certificate is compared at once,
    // not at the next heartbeat, so a machine no longer in the group stops holding a current one.
    // A machine that joined (or joined again) learns at once which machine leads: this one says so again.
    const changed = this.access.onGroupChanged?.(() => { this.service.checkDue(); if (this.selfOn && !this.following()) void this.announce(); });
    if (changed) this.disposers.push(changed);
    this.service.attachGroup(this);
    return () => { for (const stop of this.disposers.splice(0)) stop(); this.service.attachGroup(null); };
  }

  private self(): string { return this.access.host.selfNode; }

  private member(nodeId: string) { return this.access.members().find((member) => member.nodeId === nodeId); }

  /** The lead among the members that announce https on, and this machine when its own is on. */
  private leadId(): string | null {
    const candidates = [...this.announcements.values()].filter((entry) => entry.on && this.access.host.isCurrentMember(entry.nodeId)).map((entry) => entry.nodeId);
    if (this.selfOn) candidates.push(this.self());
    const ranked = candidates.map((nodeId) => ({ nodeId, admittedAt: this.member(nodeId)?.admittedAt ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.admittedAt - b.admittedAt || a.nodeId.localeCompare(b.nodeId));
    return ranked[0]?.nodeId ?? null;
  }

  // ── SecureAddressGroupLink ────────────────────────────────────────────────

  following(): { readonly nodeId: string; readonly name: string } | null {
    if (!this.access.groupId()) return null;
    const lead = this.leadId();
    if (!lead || lead === this.self()) return null;
    return { nodeId: lead, name: this.member(lead)?.displayName ?? lead };
  }

  followers(): readonly GroupFollower[] {
    const groupId = this.access.groupId();
    if (!groupId || this.following() || !this.selfOn) return [];
    const used = new Set<string>();
    // A member that said it left follows no more, although the roster keeps it until a member removes it.
    const left = new Set(this.service.leftNodes(groupId));
    return this.access.members().filter((member) => member.nodeId !== this.self() && !left.has(member.nodeId)).map((member) => {
      const report = this.reports.get(member.nodeId);
      let label = machineLabel(report?.hostName ?? member.displayName, member.nodeId);
      if (used.has(label)) label = `${label}-${member.nodeId.slice(0, 4).toLowerCase()}`;
      used.add(label);
      return { nodeId: member.nodeId, name: member.displayName, label, hostName: report?.hostName ?? '', addresses: report?.addresses ?? [], ...(report?.port !== undefined ? { port: report.port } : {}) };
    });
  }

  groupFacts(): { readonly groupId: string; readonly generation: number } | null {
    const groupId = this.access.groupId();
    const generation = this.access.signingGeneration();
    return groupId && generation !== null ? { groupId, generation } : null;
  }

  /** Send the certificate in force to every follower it covers, sealed to each. */
  async share(): Promise<void> {
    const served = this.service.servedCertificate();
    const facts = this.groupFacts();
    if (!served || served.from !== 'this-machine' || !facts || this.following()) return;
    const leadName = this.member(this.self())?.displayName ?? this.self();
    // GoodVibes' own certificate: its authority's certificate (public, never its key) goes with it, so the member's page
    // /lan-https offers phones the authority that signed what that member serves.
    const authorityPem = served.source === 'local-authority' ? await this.service.ownAuthorityPem() : null;
    const authority = authorityPem ? new X509Certificate(authorityPem).fingerprint256 : undefined;
    const sent: { nodeId: string; name: string }[] = [];
    for (const follower of this.followers()) {
      const member = this.member(follower.nodeId);
      const name = this.service.followerName(follower);
      if (!member || (served.source === 'own-files' && name === undefined)) continue;
      const sealed = sealForMember(member.agreementKey, JSON.stringify({ certPem: served.certPem, keyPem: served.keyPem }), `${SEAL_CONTEXT}:${facts.groupId}:${follower.nodeId}`);
      try {
        await this.access.host.send('SECURE_ADDRESS_CERT', {
          groupId: facts.groupId, leadName, source: served.source, names: [...served.names], notAfter: served.notAfter,
          ...(name && served.source !== 'local-authority' ? { hostName: name } : {}), sealed: { ...sealed },
          ...(authorityPem ? { authorityPem } : {}),
        }, follower.nodeId);
        sent.push({ nodeId: follower.nodeId, name: follower.name });
      } catch (error) {
        logger.warn('secure address: the group certificate could not be sent to a node', { node: follower.nodeId, error: summarizeError(error) });
      }
    }
    if (sent.length > 0) {
      this.service.noteShared(facts.groupId, facts.generation, sent.map((node) => node.nodeId));
      // What each one now holds and until when: said on the screen if it stops following before its copy ends.
      this.service.noteHolders(sent, served, authority);
    }
  }

  // ── announcements and reports ─────────────────────────────────────────────

  /** Called by the listener after each sync: whether this machine's own https is on, and what it serves. */
  async noteSynced(on: boolean, source: HttpsCertificateSource, groupName: string): Promise<void> {
    this.selfOn = on;
    if (!this.access.groupId()) return;
    await this.announce(source, groupName);
    const lead = this.following();
    if (lead) await this.report(lead.nodeId);
    else await this.share();
  }

  private lastAnnounced: { source: HttpsCertificateSource; groupName: string } = { source: 'local-authority', groupName: '' };

  private async announce(source = this.lastAnnounced.source, groupName = this.lastAnnounced.groupName): Promise<void> {
    if (!this.access.groupId()) return;
    this.lastAnnounced = { source, groupName };
    try { await this.access.host.send('SECURE_ADDRESS_LEAD', { on: this.selfOn && !this.following(), source, groupName }); } catch { /* the next sync or member heard announces again */ }
  }

  private async report(lead: string): Promise<void> {
    const names = lanServerNames();
    // Its own https port too: each machine has its own setting, which the lead's screen shows with its address.
    const port = this.service.httpsPort();
    try { await this.access.host.send('SECURE_ADDRESS_REPORT', { hostName: lanHostName(), addresses: names.addresses.filter((address) => address !== '127.0.0.1'), ...(port !== undefined ? { port } : {}) }, lead); } catch { /* the next bind reports again */ }
  }

  private async handle(type: string, body: Readonly<Record<string, unknown>>, from: string): Promise<void> {
    if (type === 'SECURE_ADDRESS_LEAD') {
      const wasFollowing = this.following()?.nodeId ?? null;
      const source = body['source'] === 'own-files' || body['source'] === 'lets-encrypt' ? body['source'] : 'local-authority';
      this.announcements.set(from, { nodeId: from, on: body['on'] === true, source, groupName: typeof body['groupName'] === 'string' ? body['groupName'] : '' });
      const now = this.following()?.nodeId ?? null;
      // A member announcing its own https while this machine leads (it joined again before hearing this one): told who
      // leads, once; once it follows it announces "off" and nothing is answered.
      if (body['on'] === true && now === null && this.selfOn) await this.announce();
      if (now !== wasFollowing) {
        // The lead changed or stopped: the old copy is not served any more.
        if (wasFollowing) await this.service.dropGroupCopy();
        else await this.service.refreshForGroup();
        if (now) await this.report(now);
      }
      if (now === from) await this.report(from);
      return;
    }
    if (type === 'SECURE_ADDRESS_REPORT') {
      if (this.following() || !this.selfOn) return;
      const hostName = typeof body['hostName'] === 'string' ? body['hostName'].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63) : '';
      const addresses = Array.isArray(body['addresses']) ? body['addresses'].filter((value): value is string => typeof value === 'string').slice(0, 16) : [];
      const port = typeof body['port'] === 'number' && Number.isInteger(body['port']) && body['port'] > 0 && body['port'] < 65536 ? body['port'] : undefined;
      // A member that said it left and reports again joined again: it follows once more.
      this.service.clearLeft(from);
      const before = this.reports.get(from);
      this.reports.set(from, { hostName, addresses, ...(port !== undefined ? { port } : {}) });
      const changed = !before || before.hostName !== hostName || before.addresses.join(',') !== addresses.join(',');
      // A new or moved node: the local authority's one certificate is made again to cover it; its address record follows.
      if (changed) await this.service.refreshForGroup();
      await this.share();
      return;
    }
    if (type === 'SECURE_ADDRESS_LEFT') {
      // A member leaving by itself: it is no longer a follower here, and the certificate is made again with a new key
      // (a lead only; anyone else has nothing it shared).
      const groupId = this.access.groupId();
      if (this.following() || !this.selfOn || !groupId) return;
      this.service.noteLeft(groupId, from);
      this.reports.delete(from);
      this.service.checkDue();
      return;
    }
    if (type === 'SECURE_ADDRESS_CERT') {
      const lead = this.following();
      const agreement = this.access.selfAgreement();
      const groupId = this.access.groupId();
      if (!lead || lead.nodeId !== from || !agreement || !groupId || body['groupId'] !== groupId) return;
      const sealed = body['sealed'];
      const opened = sealed && typeof sealed === 'object'
        ? openSealedEnvelope(agreement, sealed as Parameters<typeof openSealedEnvelope>[1], `${SEAL_CONTEXT}:${groupId}:${this.self()}`)
        : null;
      if (!opened) { logger.warn('secure address: a certificate from the lead could not be opened'); return; }
      let pair: { certPem?: unknown; keyPem?: unknown };
      try { pair = JSON.parse(opened) as typeof pair; } catch { return; }
      if (typeof pair.certPem !== 'string' || typeof pair.keyPem !== 'string') return;
      const source = body['source'] === 'own-files' || body['source'] === 'lets-encrypt' ? body['source'] : 'local-authority';
      const authorityPem = source === 'local-authority' ? issuingAuthority(body['authorityPem'], pair.certPem) : undefined;
      const kept = await this.service.keepGroupCopy({
        groupId, lead: from, leadName: typeof body['leadName'] === 'string' ? body['leadName'] : lead.name, source,
        certPem: pair.certPem, keyPem: pair.keyPem,
        names: Array.isArray(body['names']) ? body['names'].filter((value): value is string => typeof value === 'string') : [],
        notAfter: typeof body['notAfter'] === 'number' ? body['notAfter'] : 0,
        ...(typeof body['hostName'] === 'string' ? { hostName: body['hostName'] } : {}),
        ...(authorityPem ? { authorityPem } : {}),
      });
      if (!kept.ok) logger.warn('secure address: the certificate from the lead was not kept', { reason: kept.problem });
    }
  }
}
