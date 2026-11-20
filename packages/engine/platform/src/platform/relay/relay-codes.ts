/**
 * relay/relay-codes.ts, one relay code per paired device, listed and revoked
 * like a device token.
 *
 * A relay pairing (rendezvous id, relay URL, the daemon's public key) is the
 * same for every device, so on its own it could only be withdrawn from all of
 * them at once, by switching the relay off. Each pairing the daemon mints now
 * carries a code of its own (`relay.pairing.mint`), the relay client sends it
 * on every tunneled request, and the daemon serves a relayed request only when
 * its code is one it issued and has not revoked. Revoking one code
 * (`relay.codes.revoke`) ends that device's relay access on its next request;
 * every other device keeps working.
 *
 * Only a SHA-256 hash of each code is kept, in `relay-codes.json` beside the
 * other control-plane state; the code itself is returned once, inside the
 * pairing payload. A check is one hash and one map read, with no write: the
 * last-used time is kept in memory and written with the next mint or revoke.
 *
 * Each code is also a `relay-route` entry on the authority record
 * (cluster/authority-record.ts), good for this daemon only (the rendezvous is
 * this daemon's), and a child of the device token of the paired device that
 * asked for it. Revoking that device, on any machine of the group, revokes its
 * relay code with it: the record is checked on every relayed request (one
 * lstat and one map read), so the device is refused on its next one.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { AuthorityRecordFile } from '../cluster/authority-record-file.js';
import type { AuthorityKey } from '../cluster/authority-record.js';

const routeKey = (id: string): AuthorityKey => `relay-route:${id}`;

const RELAY_CODES_SCHEMA_VERSION = 1;
/** Cap on stored codes, so a loop of mints cannot grow the file without bound. */
const MAX_RELAY_CODES = 64;
const MAX_NAME_LENGTH = 80;

/** A relay code as it is listed: never the code itself. */
export interface PublicRelayCode {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** When a relayed request last presented it, since the daemon started or as last written. */
  readonly lastSeenAt?: number | undefined;
}

/** The one shape that carries the code, returned once by a mint. */
export interface MintedRelayCode extends PublicRelayCode {
  readonly code: string;
}

interface StoredRelayCode extends PublicRelayCode {
  readonly hash: string;
}

interface RelayCodesFile {
  readonly version: number;
  readonly codes: readonly StoredRelayCode[];
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function parseFile(value: unknown): RelayCodesFile {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { codes?: unknown }).codes)) {
    throw new Error('relay codes file is not an object with a codes list');
  }
  if ((value as { version?: unknown }).version !== RELAY_CODES_SCHEMA_VERSION) {
    throw new Error(`relay codes file was written by schema version ${String((value as { version?: unknown }).version)}, expected ${RELAY_CODES_SCHEMA_VERSION}`);
  }
  return value as RelayCodesFile;
}

function validEntry(value: unknown): StoredRelayCode | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.hash !== 'string' || !Number.isFinite(entry.createdAt)) return null;
  return {
    id: entry.id, name: entry.name, hash: entry.hash, createdAt: entry.createdAt as number,
    ...(Number.isFinite(entry.lastSeenAt) ? { lastSeenAt: entry.lastSeenAt as number } : {}),
  };
}

export class RelayCodeStore {
  private codes: Map<string, StoredRelayCode> | null = null;
  private readonly byHash = new Map<string, string>();
  private readonly seen = new Map<string, number>();

  private readonly authority: AuthorityRecordFile | undefined;

  constructor(private readonly filePath: string, options: { readonly authority?: AuthorityRecordFile | undefined } = {}) {
    this.authority = options.authority;
  }

  /**
   * Call `listener` when the authority record revokes a relay code or a device
   * token (here, in another process of this home, or on another machine of the
   * group), so the caller can end the relay connections whose code is no
   * longer held. Returns the unsubscribe.
   */
  onRecordRevocation(listener: () => void): () => void {
    if (!this.authority) return () => {};
    return this.authority.onChange((notice) => {
      if ([...notice.keys, ...notice.cascade].some((key) => key.startsWith('relay-route:') || key.startsWith('device-token:'))) listener();
    });
  }

  /** Whether the authority record holds this code as revoked (itself, or with the device it was issued to); an unreadable record refuses. */
  private revokedOnRecord(id: string): boolean {
    if (!this.authority) return false;
    const view = this.authority.view();
    return view === null || view.isRevoked(routeKey(id));
  }

  private load(): Map<string, StoredRelayCode> {
    if (this.codes) return this.codes;
    const codes = new Map<string, StoredRelayCode>();
    try {
      const file = readDocument<RelayCodesFile>(this.filePath, {
        label: 'relay-codes',
        recovery: 'Relay codes started empty: every device paired through the relay pairs again (/devices pair relay); the preserved copy is kept beside it.',
        validate: parseFile,
      });
      for (const raw of file?.codes ?? []) {
        const entry = validEntry(raw);
        if (entry) codes.set(entry.id, entry);
      }
    } catch (error) {
      // Fails closed: no code is known, so no relayed request is served until a device pairs again.
      logger.warn('Relay codes could not be read; relayed requests are refused until a device pairs again', { error: summarizeError(error) });
    }
    for (const entry of codes.values()) this.byHash.set(entry.hash, entry.id);
    this.codes = codes;
    return codes;
  }

  private persist(): void {
    const codes = this.load();
    writeDocument(this.filePath, {
      version: RELAY_CODES_SCHEMA_VERSION,
      codes: [...codes.values()].map((entry) => {
        const lastSeenAt = this.seen.get(entry.id) ?? entry.lastSeenAt;
        return { ...entry, ...(lastSeenAt !== undefined ? { lastSeenAt } : {}) };
      }),
    });
  }

  private publicView(entry: StoredRelayCode): PublicRelayCode {
    const lastSeenAt = this.seen.get(entry.id) ?? entry.lastSeenAt;
    return { id: entry.id, name: entry.name, createdAt: entry.createdAt, ...(lastSeenAt !== undefined ? { lastSeenAt } : {}) };
  }

  /**
   * Issue a new code for one device. The code is returned here and never again.
   * `deviceTokenId` is the paired device asking for it, when one is: revoking
   * that device revokes this code with it.
   */
  mint(name: string | undefined, deviceTokenId?: string): MintedRelayCode {
    const codes = this.load();
    if (codes.size >= MAX_RELAY_CODES) {
      throw Object.assign(new Error(`This daemon already holds ${MAX_RELAY_CODES} relay codes. Revoke the ones no device uses (relay.codes.list, relay.codes.revoke), then pair again.`), {
        code: 'RELAY_CODE_LIMIT', status: 409,
      });
    }
    const createdAt = Date.now();
    const trimmed = (name ?? '').trim().slice(0, MAX_NAME_LENGTH);
    const code = `gvr_${randomBytes(24).toString('base64url')}`;
    const stored: StoredRelayCode = {
      id: `rc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: trimmed.length > 0 ? trimmed : `Relay device ${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')}`,
      createdAt,
      hash: hashCode(code),
    };
    codes.set(stored.id, stored);
    this.byHash.set(stored.hash, stored.id);
    try {
      this.persist();
    } catch (error) {
      codes.delete(stored.id);
      this.byHash.delete(stored.hash);
      throw error;
    }
    const authority = this.authority;
    if (authority) {
      const deviceKey: AuthorityKey | null = deviceTokenId ? `device-token:${deviceTokenId}` : null;
      void authority.write((view) => ({ kind: 'issue', value: null, entries: [{
        kind: 'relay-route', id: stored.id, audience: { nodeId: view.nodeId },
        parent: deviceKey && view.entry('device-token', deviceTokenId!) ? deviceKey : null,
        public: { routeHash: stored.hash, deviceKey, label: stored.name },
      }] })).catch((error: unknown) => logger.warn('A relay code could not be written to the authority record; revoking its device does not revoke it until it is', { id: stored.id, error: summarizeError(error) }));
    }
    return { ...this.publicView(stored), code };
  }

  /** Every code still in force, oldest first, without the code itself. */
  list(): PublicRelayCode[] {
    return [...this.load().values()].filter((entry) => !this.revokedOnRecord(entry.id))
      .sort((a, b) => a.createdAt - b.createdAt).map((entry) => this.publicView(entry));
  }

  /** Revoke one code: the device holding it is refused on its next relayed request. False for an unknown id. */
  revoke(id: string): boolean {
    const codes = this.load();
    const entry = codes.get(id);
    if (!entry) return false;
    codes.delete(id);
    this.byHash.delete(entry.hash);
    this.seen.delete(id);
    try {
      this.persist();
    } catch (error) {
      // The code stays refused in this process; the file still names it until the next write succeeds.
      logger.warn('A revoked relay code could not be removed from the file; it stays refused while the daemon runs', { id, error: summarizeError(error) });
      throw error;
    }
    void this.authority?.write((view) => (view.entry('relay-route', id) && !view.entry('relay-route', id)!.revoked
      ? { kind: 'revoke', key: routeKey(id), by: 'owner', reason: 'revoked by the owner', value: null }
      : { kind: 'none', value: null })).catch((error: unknown) => logger.warn('A relay code revocation could not be written to the authority record', { id, error: summarizeError(error) }));
    return true;
  }

  /** Whether `code` is one this daemon issued and still holds; records nothing. */
  holds(code: string): boolean {
    this.load();
    const id = this.byHash.get(hashCode(code));
    return id !== undefined && !this.revokedOnRecord(id);
  }

  /** The id of the code a relayed request presented, or null when it is not one this daemon issued and still holds. */
  verify(code: string | null): string | null {
    if (!code) return null;
    this.load();
    const id = this.byHash.get(hashCode(code)) ?? null;
    // Revoked on the authority record, itself or with the device it was issued to.
    if (id === null || this.revokedOnRecord(id)) return null;
    this.seen.set(id, Date.now());
    return id;
  }
}
