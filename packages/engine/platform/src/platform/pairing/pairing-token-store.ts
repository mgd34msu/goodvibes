/**
 * pairing/pairing-token-store.ts
 *
 * Per-pairing operator tokens: every device/browser that pairs mints its OWN
 * named, individually-revocable token, instead of everyone sharing the one
 * operator token. Revoking one device leaves the others working.
 *
 * Custody: only a SHA-256 hash of each token is persisted. The plaintext secret
 * is returned exactly once, at mint time (for the QR / pairing hand-off); after
 * that the daemon authenticates by hashing the presented token and looking the
 * hash up, so the listable record never contains the secret. `list()` hands
 * back name / created / last-seen only, never the hash, never the secret.
 *
 * Revocation is immediate: `revoke()` deletes the record, so the very next
 * `authenticate()` of that token misses and the request is unauthorized. A
 * token minted by a paired device records that device (`mintedBy`), and
 * revoking the device revokes every token it minted, so cutting off a lost
 * phone cannot leave a credential it handed out behind.
 *
 * The shared operator token (authenticated elsewhere) keeps working until it
 * is revoked here via `revokeLegacyShared()`; a client on the shared token
 * calls `mintForMigration()` once to move to its own per-device token.
 * Revoking replaces the token: the serving daemon writes a new value to its
 * home, where this machine's own apps read it, and this store keeps that
 * value's hash, so every copy handed to another device is dead and the apps
 * on the daemon's machine stay signed in.
 *
 * The owner's own machine needs no pairing: its apps hold the shared token,
 * and the transport, having seen that token arrive from the daemon's own
 * machine, asks for the local native owner (`ensureLocalNativeOwner`). That
 * is one stable record, made once, which native work, the work ledger and
 * continuation grants are bound to the way they are bound to a pairing. A
 * revocation of the shared token ends it; the next use makes a new one.
 *
 * A pairing minted with `client: 'agent'` is the GoodVibes Agent's credential
 * for the calls it makes on the owner's behalf. The transport reports it as
 * its own credential kind, so a call made with it is judged as the Agent's
 * whatever its body says. It is not a device: it does not count toward
 * `device.nodes.maxPaired`.
 *
 * A minted token is an offer until its first use: it is not listed as a
 * device and does not count toward `device.nodes.maxPaired`, and when nobody
 * uses it within {@link PAIRING_OFFER_LIFETIME_MS} it stops authenticating and
 * is dropped at the next write. A pairing screen that mints again replaces its
 * own earlier unused offer, and a client that repeats a pairing attempt whose
 * reply it lost gets that attempt's offer re-issued, so neither adds a second
 * live credential. The first authentication claims it (one write
 * per device); that claim adds a device, so it is bounded by
 * `device.nodes.maxPaired` exactly as a mint is, and a refused claim leaves the
 * offer usable until it expires. After that, last-seen is stamped in memory and written with the
 * next write or by a timer, never inside a request. With managed token rotation
 * on ({@link PairingTokenManager.setRotationLimit}), a device token older than
 * the limit is refused here, the owner of "may this token authenticate", and
 * {@link PairingTokenManager.describeRefusal} names its age and the re-pair step.
 *
 * Storage is synchronous JSON at mode 0600 (the same custody posture as the
 * shared operator token file), because the auth path that consults it is itself
 * synchronous. Every writer reloads under a shared ownership lock, persists
 * atomically, then publishes its new in-memory index. Native launches hold the
 * same lock across their final authorization/launch boundary.
 */
import type { AuthorityChange, AuthorityRecordFile } from '../cluster/authority-record-file.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AtomicWriteDurabilityError, confirmFileDurable, readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { SettingsAuthorityUnavailableError, runSynchronousSettingsOperation } from '../security/settings-authority.js';
import { NativeContinuationOwner, nativeContinuationParents, type NativeContinuationParents } from './native-continuation-owner.js';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes/judgment/decisions';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';
import { describeOwnerLock, reclaimDeadOwnerLock, recordOwnerLockHolder, removeOwnerLockDirectory, waitWhileLockIsBeingTaken } from '../config/durable-policy-epoch.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { matchesSharedToken, type CredentialRefusal } from '../security/http-auth.js';
import { LOCAL_OWNER_PRINCIPAL, pairingPrincipalId } from './principal-ids.js';

const TOKEN_PREFIX = 'gvp_';
/** How a shared operator token begins (pairing/companion-token.ts mints them). */
const SHARED_TOKEN_PREFIX = 'gv_';
/** The identity recorded for a pairing file that does not exist. */
const ABSENT_FILE = 'absent';

/**
 * The owner's own machine as a native credential. Only the transport passes
 * it, after it established that the daemon's operator token arrived from the
 * daemon's own machine; no payload can name it.
 */
export const LOCAL_OWNER_CREDENTIAL: unique symbol = Symbol('goodvibes.local-owner-credential');
/** A pairing token, or the owner's own machine. */
export type NativeCredential = string | typeof LOCAL_OWNER_CREDENTIAL;
const LOCAL_OWNER_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a presented credential has the pairing-token shape (not whether it is valid). */
export function isPairingTokenShape(token: string): boolean {
  return token.trim().startsWith(TOKEN_PREFIX);
}
/** Stamped last-seen times are written with the next write, or after this long when nothing else writes. */
const LAST_SEEN_FLUSH_INTERVAL_MS = 5 * 60_000;
/** How long a minted token waits for its first use before it expires unused. */
export const PAIRING_OFFER_LIFETIME_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const OWNER_LOCK_NAMESPACE_VERSION = 'goodvibes-pairing-owner-lock-v2\n';

/** A per-pairing token as stored on disk, the hash, never the secret. */
interface StoredPairingToken {
  readonly id: string;
  name: string;
  /** SHA-256 hex of the token value. The plaintext is never persisted. */
  readonly tokenHash: string;
  readonly createdAt: number;
  lastSeenAt?: number | undefined;
  /** Set while the token is an offer nobody has used; it expires unused at this time. Cleared by the first use. */
  offeredUntil?: number | undefined;
  /** The pairing that minted this one, when a paired device (not the owner's own machine) asked. */
  mintedBy?: string | undefined;
  /**
   * The client's pairing attempt this offer answers. The same attempt asked
   * again (its reply was lost) gets this offer with a new secret instead of a
   * second offer. Cleared by the first use.
   */
  attemptId?: string | undefined;
  /** Issued once per exact credential incarnation; never derived by hashing
   * another hash. Kept private alongside its original verifier, not listable. */
  nativeContinuationRevision?: { readonly id: string; readonly createdAt: number; readonly tokenHash: string };
  /** `agent`: the GoodVibes Agent's credential for the calls it makes on the owner's behalf. */
  client?: 'agent' | undefined;
  /**
   * `owner-pairing`: the owner paired this device himself, through the
   * owner's pairing flow (the QR or `pair` command confirmed at his terminal
   * or an admin sign-in, the relay included). Written when the token is
   * minted and never changed afterwards. Absent: automation (a token minted
   * through the API by another token, or with narrowed scopes, or for a named
   * client), which does not make the owner's own acts.
   */
  readonly origin?: 'owner-pairing' | undefined;
  /**
   * Set on an offer minted for a device moving off the shared token: its first
   * use is exempt from `device.nodes.maxPaired`, as its mint was. Cleared by
   * the first use.
   */
  capExempt?: true | undefined;
  /**
   * The operator scopes this device holds, when it was paired with a narrower
   * list than full operator authority (`*` in the list is full authority).
   * Absent: full authority.
   */
  scopes?: string[] | undefined;
}

/**
 * The owner's own machine as a native authority: the stable id native work,
 * the ledger and continuation grants are bound to. `tokenHash` is a random
 * incarnation marker in the place a pairing keeps its verifier; no credential
 * hashes to it, so it never authenticates anything.
 */
interface StoredLocalOwner {
  readonly id: string;
  readonly createdAt: number;
  readonly tokenHash: string;
  nativeContinuationRevision?: { readonly id: string; readonly createdAt: number; readonly tokenHash: string };
}

/** What a continuation grant is held by: a pairing, or the owner's own machine. */
type NativeCustodian = StoredPairingToken | StoredLocalOwner;

interface PairingOwnerLock {
  assertOwned(): void;
  release(): void;
}

/** Private delegation receipt. The identifier alone grants nothing. */
export interface NativeContinuationGrant { readonly id: string; readonly binding: string; }
export interface NativeContinuationAuthority extends AuthenticatedNativePairingToken { readonly scopes: readonly string[]; }
interface StoredNativeContinuationGrant extends NativeContinuationGrant {
  /** New writers supply the actual native action token as the source binding. */
  readonly sourceBindingVersion?: 2;
  readonly sourceBinding: string;
  readonly successorSourceBinding: string | null;
  readonly parent: (NativeContinuationGrant & { readonly consumption: string }) | null;
  readonly tokenId: string;
  readonly tokenRevision: string;
  readonly ownerRoot: string;
  readonly watchBinding: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly consumption: string | null;
  readonly revoked: boolean;
}

interface PairingTokenSnapshot {
  /** Host-issued only, retained as tombstones after consumption/revocation. */
  continuations?: StoredNativeContinuationGrant[];
  /** Explicit native cancellation is irreversible for this exact source incarnation. */
  revokedNativeSources?: string[];

  tokens: StoredPairingToken[];
  /**
   * Once true, the shared operator token handed out before no longer
   * authenticates: only the value {@link localSharedHash} names does.
   */
  legacyRevoked?: boolean | undefined;
  /**
   * SHA-256 of the shared token value written to this machine's daemon home
   * when the old one was revoked. Absent while revoked: no shared value
   * authenticates until the serving daemon writes its replacement.
   */
  localSharedHash?: string | undefined;
  /** The owner's own machine, once one of its apps used native work. */
  localOwner?: StoredLocalOwner | undefined;
}
class UnsupportedNativeSourceBindingError extends Error {}

/**
 * Continuation grants are tombstones: a consumed or revoked grant must stay so
 * its source cannot be issued again. They stop mattering only when the pairing
 * they were issued under no longer exists, because every use of such a grant
 * (read, consume, issue a child) first needs that pairing's record, and a new
 * pairing gets a new random id. So exactly the grants whose pairing is gone are
 * dropped, together with the cancelled-source tombstones that only those grants
 * referenced. Grants of a live pairing, and cancelled sources no grant ever
 * referenced, are never dropped: nothing proves they cannot be presented again.
 */
function pruneUnpresentableContinuations(snapshot: PairingTokenSnapshot): void {
  const grants = snapshot.continuations;
  if (!grants?.length) return;
  const live = new Set(snapshot.tokens.map(token => token.id));
  if (snapshot.localOwner) live.add(snapshot.localOwner.id);
  const kept = grants.filter(grant => live.has(grant.tokenId));
  if (kept.length === grants.length) return;
  const sourcesOf = (list: readonly StoredNativeContinuationGrant[]) =>
    new Set(list.flatMap(grant => [grant.sourceBinding, grant.successorSourceBinding]).filter((value): value is string => value !== null));
  const stillReferenced = sourcesOf(kept);
  const dropped = new Set([...sourcesOf(grants.filter(grant => !live.has(grant.tokenId)))].filter(source => !stillReferenced.has(source)));
  snapshot.continuations = kept;
  if (snapshot.revokedNativeSources) snapshot.revokedNativeSources = snapshot.revokedNativeSources.filter(source => !dropped.has(source));
}

/** The redacted, wire-safe view of a pairing token, no hash, no secret. */
export interface PublicPairingToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number | undefined;
  /** The paired device that minted this token; revoking it revokes this one too. */
  readonly mintedBy?: string | undefined;
  /** `agent`: the GoodVibes Agent's credential for the calls it makes on the owner's behalf. */
  readonly client?: 'agent' | undefined;
  /** The scopes this device holds when it was paired with a narrower list; absent means full operator authority. */
  readonly scopes?: readonly string[] | undefined;
  /**
   * How the token came to exist: `owner-pairing`, a device the owner paired
   * himself, which makes the owner's own acts; `automation`, a token minted
   * through the API, with narrowed scopes or for a named client, which does not.
   */
  readonly origin: PairingTokenOrigin;
}

/** How a pairing token came to exist; see {@link PublicPairingToken.origin}. */
export type PairingTokenOrigin = 'owner-pairing' | 'automation';

/** The result of minting a token, the ONLY time the plaintext secret is exposed. */
export interface MintedPairingToken {
  readonly id: string;
  readonly name: string;
  /** The plaintext token, returned once, never stored, never listed again. */
  readonly token: string;
  readonly createdAt: number;
}

export interface MintPairingInput {
  readonly name: string;
  /** The pairing id of the paired device asking; absent when the owner's own machine or the shared token mints. */
  readonly mintedBy?: string | undefined;
  /**
   * The offer this producer showed before (a pairing screen's previous QR).
   * If nobody has used it, it is removed in the same write, so one screen
   * holds one live offer however often it is opened or refreshed. A device
   * that already used it is untouched.
   */
  readonly replacesOffer?: string | undefined;
  /**
   * The client's id for this pairing attempt, sent again when it repeats a
   * request whose reply it lost. While the offer that attempt produced is
   * unused, the repeat re-issues that offer (same id, new secret; the lost
   * secret stops working) instead of adding a second one.
   */
  readonly attemptId?: string | undefined;
  /** `agent` marks the GoodVibes Agent's credential for the calls it makes on the owner's behalf. */
  readonly client?: 'agent' | undefined;
  /**
   * The operator scopes the paired device will hold, narrower than full
   * operator authority; absent (or containing `*`) is full authority.
   */
  readonly scopes?: readonly string[] | undefined;
  /**
   * `owner-pairing` only from the owner's own pairing flow. A token with
   * narrowed scopes or a named client is automation whatever is asked.
   */
  readonly origin?: PairingTokenOrigin | undefined;
}

/**
 * Private native authority identity. It never carries the token or its hash.
 * `local` is the owner's own machine; its principal is the operator token's.
 */
export interface AuthenticatedNativePairingToken {
  readonly kind: 'pairing-token' | 'local';
  readonly tokenId: string;
  readonly principalId: string;
  readonly authorityId: string;
  /** The unique persisted pairing ID is its incarnation, not an invented epoch. */
  readonly authorityRevision: string;
}

declare const settingsPairingAuthorityBrand: unique symbol;
/** Opaque owner-current precondition, not permission to execute an effect. */
export interface SettingsPairingAuthority {
  readonly kind: 'shared-token' | 'pairing-token';
  readonly [settingsPairingAuthorityBrand]: true;
}
interface SettingsPairingAuthorityRecord {
  readonly kind: 'shared-token' | 'pairing-token';
  readonly hash?: string;
  readonly id?: string;
  readonly createdAt?: number;
}

/**
 * Whether the pairing store at `filePath` records the shared operator token as
 * revoked, read without opening the store: no lock, no write, no directory. A
 * missing or unreadable file reads as not revoked; the daemon that owns the
 * store is still the authority on every request.
 */
export function readLegacySharedRevoked(filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && (parsed as { legacyRevoked?: unknown }).legacyRevoked === true;
  } catch {
    return false;
  }
}

export class PairingTokenStoreBusyError extends Error {
  readonly code = 'PAIRING_TOKEN_STORE_BUSY';
  /** @param detail Which lock, and who holds it, when that is known. */
  constructor(detail?: string) {
    super(`Pairing token authority is busy or its ownership lock needs recovery${detail ? `: ${detail}` : ''}`);
    this.name = 'PairingTokenStoreBusyError';
  }
}

const PAIRING_ID_PATTERN = /^pair-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A client's pairing attempt id: opaque, short, printable. */
const PAIRING_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Whether `value` can name a pairing attempt (see {@link MintPairingInput.attemptId}). */
export function isPairingAttemptId(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_ATTEMPT_ID_PATTERN.test(value);
}

function validateSnapshot(parsed: unknown): PairingTokenSnapshot {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pairing token store is not a JSON object');
  }
  const snapshot = parsed as Partial<PairingTokenSnapshot>;
  if (Array.isArray(snapshot.continuations) && snapshot.continuations.some(grant => grant
    && Object.hasOwn(grant, 'sourceBindingVersion') && grant.sourceBindingVersion !== 2)) {
    throw new UnsupportedNativeSourceBindingError('Unsupported native source binding');
  }
  if (!Array.isArray(snapshot.tokens)) throw new Error('pairing token store is missing its tokens array');
  if (snapshot.legacyRevoked !== undefined && typeof snapshot.legacyRevoked !== 'boolean') {
    throw new Error('pairing token store has an invalid legacy revocation flag');
  }
  if (snapshot.localSharedHash !== undefined && (typeof snapshot.localSharedHash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.localSharedHash))) {
    throw new Error('pairing token store has an invalid replacement shared token');
  }
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const record of snapshot.tokens) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.id !== 'string' || !PAIRING_ID_PATTERN.test(record.id)
      || typeof record.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenHash)
      || typeof record.name !== 'string' || !record.name.trim()
      || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
      || (record.offeredUntil !== undefined && (typeof record.offeredUntil !== 'number' || !Number.isFinite(record.offeredUntil)))
      || (record.lastSeenAt !== undefined && (typeof record.lastSeenAt !== 'number' || !Number.isFinite(record.lastSeenAt)))
      || (record.mintedBy !== undefined && (typeof record.mintedBy !== 'string' || !PAIRING_ID_PATTERN.test(record.mintedBy)))
      || (record.attemptId !== undefined && (typeof record.attemptId !== 'string' || !PAIRING_ATTEMPT_ID_PATTERN.test(record.attemptId)))
      || (record.client !== undefined && record.client !== 'agent')
      || (record.origin !== undefined && record.origin !== 'owner-pairing')
      || (record.scopes !== undefined && (!Array.isArray(record.scopes) || record.scopes.some(scope => typeof scope !== 'string' || !scope)))
      || ids.has(record.id) || hashes.has(record.tokenHash)) {
      throw new Error('pairing token store has an invalid or duplicate record');
    }
    ids.add(record.id); hashes.add(record.tokenHash);
    const revision = record.nativeContinuationRevision;
    if (revision !== undefined && (!revision || typeof revision !== 'object' || Array.isArray(revision)
      || Object.keys(revision).length !== 3 || typeof revision.id !== 'string' || !/^[0-9a-f]{64}$/.test(revision.id)
      || typeof revision.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(revision.tokenHash)
      || typeof revision.createdAt !== 'number' || !Number.isFinite(revision.createdAt))) throw new Error('Invalid native credential incarnation');
  }
  const local = snapshot.localOwner;
  if (local !== undefined && (!local || typeof local !== 'object' || Array.isArray(local)
    || typeof local.id !== 'string' || !LOCAL_OWNER_ID_PATTERN.test(local.id)
    || typeof local.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(local.tokenHash) || hashes.has(local.tokenHash)
    || typeof local.createdAt !== 'number' || !Number.isFinite(local.createdAt)
    || (local.nativeContinuationRevision !== undefined && (!local.nativeContinuationRevision || typeof local.nativeContinuationRevision !== 'object'
      || typeof local.nativeContinuationRevision.id !== 'string' || !/^[0-9a-f]{64}$/.test(local.nativeContinuationRevision.id)
      || local.nativeContinuationRevision.tokenHash !== local.tokenHash || local.nativeContinuationRevision.createdAt !== local.createdAt)))) {
    throw new Error('pairing token store has an invalid local owner record');
  }
  // Published reader width; newly issued values are ordinary opaque IDs.
  const isStoredBinding = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (snapshot.revokedNativeSources !== undefined && (!Array.isArray(snapshot.revokedNativeSources)
    || snapshot.revokedNativeSources.some(value => !isStoredBinding(value))
    || new Set(snapshot.revokedNativeSources).size !== snapshot.revokedNativeSources.length)) throw new Error('Invalid native source tombstones');
  if (snapshot.continuations !== undefined) {
    if (!Array.isArray(snapshot.continuations)) throw new Error('Invalid native continuation grants');
    const grants = new Set<string>();
    for (const grant of snapshot.continuations) {
      if (!grant || Object.keys(grant).length !== (grant.sourceBindingVersion === 2 ? 14 : 13) || typeof grant.id !== 'string' || !/^continuation-[0-9a-f-]{36}$/.test(grant.id)
        || !isStoredBinding(grant.binding) || !isStoredBinding(grant.sourceBinding)
        || (grant.successorSourceBinding !== null && !isStoredBinding(grant.successorSourceBinding))
        || ((grant.consumption === null) !== (grant.successorSourceBinding === null)) || !isStoredBinding(grant.tokenRevision)
        || !isStoredBinding(grant.ownerRoot) || (grant.watchBinding !== null && !isStoredBinding(grant.watchBinding)) || typeof grant.tokenId !== 'string'
        || !Array.isArray(grant.scopes) || !grant.scopes.length || grant.scopes.some(scope => typeof scope !== 'string' || !scope)
        || new Set(grant.scopes).size !== grant.scopes.length || typeof grant.revoked !== 'boolean'
        || !Number.isFinite(grant.createdAt) || (grant.consumption !== null && !isStoredBinding(grant.consumption))
        || (grant.parent !== null && (!grant.parent || Object.keys(grant.parent).length !== 3 || typeof grant.parent.id !== 'string'
          || !isStoredBinding(grant.parent.binding) || !isStoredBinding(grant.parent.consumption)))
        || grants.has(grant.id)) throw new Error('Invalid native continuation grant');
      grants.add(grant.id);
    }
  }
  return { tokens: snapshot.tokens, legacyRevoked: snapshot.legacyRevoked === true,
    ...(snapshot.legacyRevoked === true && snapshot.localSharedHash !== undefined ? { localSharedHash: snapshot.localSharedHash } : {}),
    ...(local ? { localOwner: local } : {}),
    ...(snapshot.continuations ? { continuations: snapshot.continuations } : {}),
    ...(snapshot.revokedNativeSources ? { revokedNativeSources: snapshot.revokedNativeSources } : {}) };
}

/** What ordinary authentication resolves to: the identity behind the token. */
export interface AuthenticatedPairingToken {
  readonly id: string;
  readonly name: string;
  /** Stable per-token principal id (`pairing:<id>`), so step-up keys per token. */
  readonly principalId: string;
  /** `agent`: the GoodVibes Agent's credential for the calls it makes on the owner's behalf. */
  readonly client?: 'agent' | undefined;
  /** The scope list the pairing stores, when it was issued a narrower one than full operator authority. */
  readonly scopes?: readonly string[] | undefined;
  /** True for a device the owner paired himself (see {@link PublicPairingToken.origin}). */
  readonly ownerDevice?: true | undefined;
}

/**
 * Whether a shared token value still authenticates: it was never revoked, or
 * it was revoked and replaced by the value this machine's apps now hold.
 */
function sharedTokenUsable(snapshot: PairingTokenSnapshot): boolean {
  return snapshot.legacyRevoked !== true || snapshot.localSharedHash !== undefined;
}

/** The pairing or local owner record a continuation grant names, while it is live. */
function custodianOf(snapshot: PairingTokenSnapshot, id: string): NativeCustodian | undefined {
  return snapshot.tokens.find(item => item.id === id)
    ?? (snapshot.localOwner?.id === id && sharedTokenUsable(snapshot) ? snapshot.localOwner : undefined);
}

/** The native identity a custodian authenticates as. */
function nativeIdentityOf(custodian: NativeCustodian): AuthenticatedNativePairingToken {
  if (LOCAL_OWNER_ID_PATTERN.test(custodian.id)) {
    return Object.freeze({ kind: 'local', tokenId: custodian.id, principalId: LOCAL_OWNER_PRINCIPAL,
      authorityId: LOCAL_OWNER_PRINCIPAL, authorityRevision: custodian.id });
  }
  const principalId = pairingPrincipalId(custodian.id);
  return Object.freeze({ kind: 'pairing-token', tokenId: custodian.id, principalId, authorityId: principalId, authorityRevision: custodian.id });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** When a device token on the authority record was issued, for its rotation age: its rotation stamp, or its creation when an older write left none. */
function recordIssuedAt(entry: { readonly createdAt: number; readonly rotationIssuedAt?: unknown }): number {
  return typeof entry.rotationIssuedAt === 'number' && Number.isFinite(entry.rotationIssuedAt) ? entry.rotationIssuedAt : entry.createdAt;
}

/**
 * What grants or limits access. A last-seen stamp is telemetry and changes no
 * access; an absent and a false legacy revocation, or an absent and an empty
 * grant list, are the same authority however the file was last written.
 */
function authorityText(snapshot: PairingTokenSnapshot): string {
  return JSON.stringify(snapshot, (key, value: unknown) => key === 'lastSeenAt'
    || (key === 'legacyRevoked' && value !== true)
    || (key === 'continuations' && Array.isArray(value) && value.length === 0) ? undefined : value);
}

/** An offer nobody used in time: it never authenticates and goes at the next write. */
function isExpiredOffer(record: StoredPairingToken, now: number): boolean {
  return record.offeredUntil !== undefined && record.offeredUntil <= now;
}

/** Drop expired offers; rides on a write that is happening anyway. */
function dropExpiredOffers(snapshot: PairingTokenSnapshot, now: number): void {
  if (snapshot.tokens.some(record => isExpiredOffer(record, now))) {
    snapshot.tokens = snapshot.tokens.filter(record => !isExpiredOffer(record, now));
  }
}

/** The later of the written and the not yet written last-seen time, as an optional field. */
function lastSeenField(written: number | undefined, pending: number | undefined): { readonly lastSeenAt?: number } {
  const latest = Math.max(written ?? 0, pending ?? 0);
  return latest > 0 ? { lastSeenAt: latest } : {};
}

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

/** `id` and every pairing minted, directly or through another, by it. */
function withMintedDescendants(tokens: readonly StoredPairingToken[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const token of tokens) {
      if (token.mintedBy !== undefined && ids.has(token.mintedBy) && !ids.has(token.id)) { ids.add(token.id); grew = true; }
    }
  }
  return ids;
}

/**
 * A paired device asked for a token, but its own pairing is gone (revoked in
 * the meantime). Nothing is minted: a revoked device cannot hand out access.
 */
export class PairingMinterRevokedError extends Error {
  readonly code = 'PAIRING_TOKEN_NOT_FOUND';
  constructor() {
    super('This device is no longer paired, so it cannot pair another. Pair it again from the owner\'s machine.');
    this.name = 'PairingMinterRevokedError';
  }
}

/** Principals whose credential the move from `before` to `after` ended. */
function revokedPrincipals(before: PairingTokenSnapshot, after: PairingTokenSnapshot): string[] {
  const kept = new Set(after.tokens.map(token => `${token.id}\0${token.tokenHash}`));
  const revoked = before.tokens.filter(token => !kept.has(`${token.id}\0${token.tokenHash}`)).map(token => pairingPrincipalId(token.id));
  // A revocation, and every later replacement, ends the shared value in use before it.
  if (after.legacyRevoked === true && (before.legacyRevoked !== true || before.localSharedHash !== after.localSharedHash)) revoked.push('shared-token');
  return revoked;
}

/**
 * A pairing was refused because the paired-node cap is full.
 *
 * Carries the setting name, the cap and the live count so the refusal a caller
 * renders says what to change and what the current state is, rather than a bare
 * "failed". `code` is what the control-plane verbs map to their wire error.
 */
export class PairingLimitReachedError extends Error {
  readonly code = 'DEVICE_NODES_MAX_PAIRED';
  readonly setting = 'device.nodes.maxPaired';
  constructor(readonly maxPaired: number, readonly pairedCount: number) {
    super(
      `Cannot pair another device: device.nodes.maxPaired is ${maxPaired} and ${pairedCount} `
      + `${pairedCount === 1 ? 'device is' : 'devices are'} already paired. `
      + 'Unpair a device, or raise device.nodes.maxPaired.',
    );
    this.name = 'PairingLimitReachedError';
  }
}

/** How the store learns the live cap. Absent ⇒ unbounded, exactly as before. */
export interface PairingTokenManagerOptions {
  readonly nativeDataWriter?: NativeDataWriteOwner | undefined;
  /**
   * Reads `device.nodes.maxPaired` at mint time. A function, not a number, so a
   * cap change takes effect on the next pairing without re-constructing the
   * store, and so this module never has to depend on ConfigManager.
   */
  readonly maxPaired?: (() => number | undefined) | undefined;
  /**
   * The authority record (cluster/authority-record-file.ts). A claimed device
   * token is written to it and its revocation is a terminal record entry, so a
   * device paired on one machine of a group works on every machine and a
   * revocation made on any machine holds on all of them. With it, this file is
   * never the only thing that says yes: a token the record holds as revoked is
   * refused whatever the file says, and a token the record holds as live is
   * accepted though this file never saw it.
   */
  readonly authority?: AuthorityRecordFile | undefined;
}

/**
 * The serving daemon's hold on the shared operator token, bound so that
 * revoking the shared token replaces it: every copy handed to another device
 * stops signing in, and this machine's own apps read the new value from the
 * daemon home and stay signed in.
 */
export interface SharedTokenCustody {
  /** The value the daemon serves with now, or null when it serves none. */
  current(): string | null;
  /** Why the served value cannot be replaced here, or null when it can. */
  replacementRefusal(): string | null;
  /**
   * Make a new value and hand it to `commit`, which records it in this store
   * before anything else changes; then write it where this machine's apps read
   * it and serve with it. A throw from `commit` leaves the old value in place.
   */
  replace(commit: (token: string) => void): void;
}

/** The shared token cannot be revoked here, because the daemon cannot replace the value it serves with. */
export class SharedTokenNotReplaceableError extends Error {
  readonly code = 'SHARED_TOKEN_NOT_REPLACEABLE';
  constructor(reason: string) {
    super(`The shared operator token was not revoked: ${reason}`);
    this.name = 'SharedTokenNotReplaceableError';
  }
}

export class PairingTokenManager {
  private readonly filePath: string;
  private snapshot: PairingTokenSnapshot;
  /** Live hash -> identity index, paired with fresh disk proof for native auth. */
  private index = new Map<string, StoredPairingToken>();
  private lastSeenFailureLogged = false;
  /** Last-seen times stamped in memory since the last write, by pairing id. */
  readonly #pendingLastSeen = new Map<string, number>();
  #lastSeenTimer: ReturnType<typeof setTimeout> | undefined;
  /** Device tokens whose rotation refusal was already logged in this process. */
  readonly #rotationRefusalsLogged = new Set<string>();
  /** The managed rotation limit in ms, read at each authentication; null or absent: no limit. */
  #rotationLimit: (() => number | null) | undefined;
  /**
   * Any failed write blocks native admission. A failed owner write (revoke,
   * mint, rename, native grants) or an unconfirmed native read clears only on
   * a later successful owner mutation; a failed last-seen stamp, which changes
   * no authority, also clears on the next stamp that writes durably.
   */
  private nativePersistenceFailed: false | 'owner' | 'last-seen' = false;
  // Same-serving-owner evidence only; no reconstruction of prior process history.
  // These flags never weaken ordinary/manual authentication or native behavior.
  // A read fault, or a start that could not take the lock, is re-checked under
  // the owner lock at the next settings capture, so a transient cause recovers
  // without a restart. A failed owner write (a revoke that may not have landed)
  // or a lost owner lock stays a hold for this serving owner. An observed store
  // or legacy revocation never un-happens, and an unverified start never
  // certifies an absent store as fresh.
  private settingsInitializationVerified = false;
  private settingsCleanInitialAbsence = false;
  private settingsObservedStore = false;
  private settingsObservedLegacyRevocation = false;
  private settingsFaulted: false | 'read' | 'owner' = false;
  /** True while settings authority is held by a read or owner-write fault. */
  get settingsAuthorityFaulted(): boolean { return this.settingsFaulted !== false; }
  private readonly settingsAuthorities = new WeakMap<SettingsPairingAuthority, SettingsPairingAuthorityRecord>();
  private readonly readMaxPaired: (() => number | undefined) | null;
  private readonly nativeDataWriter: NativeDataWriteOwner | undefined;
  private readonly continuationOwner: NativeContinuationOwner;
  // Read-only compatibility with actually issued v1 grants. Cache the exact
  // published inputs; normal native reads/issuance do not enter this path.
  private readonly publishedTokenRevisions = new Map<string, { createdAt: number; tokenHash: string; digest: string }>();
  private publishedRoot: { parents: NativeContinuationParents; digest: string } | undefined;
  /** Moves when the published pairings, grants or legacy revocation change, by this process or another one it read. */
  #authorityRevision = 0;
  #publishedAuthority = '';
  readonly #revisionSource = revisionSource('device pairings', () => this.#authorityRevision);
  /** The file identity the published snapshot was read from or written as; undefined forces the next read. */
  #observedIdentity: string | undefined;
  /** The last read of a changed file failed: pairing tokens do not authenticate until a read succeeds. */
  #readFaulted = false;
  /** The file identity native authority last confirmed durable; native reads confirm a new identity once. */
  #durableIdentity: string | undefined;
  readonly #revocationListeners = new Set<(principalIds: readonly string[]) => void>();
  readonly #changeListeners = new Set<() => void>();
  private readonly authority: AuthorityRecordFile | undefined;
  /** The serving daemon's shared token, while one is bound (see {@link bindSharedTokenCustody}). */
  #sharedCustody: SharedTokenCustody | undefined;

  constructor(filePath: string, options: PairingTokenManagerOptions = {}) {
    this.filePath = filePath;
    this.authority = options.authority;
    // A revocation another machine made (or another process of this home)
    // reaches whatever holds a session or a connection under that device.
    this.authority?.onChange((notice) => {
      if (notice.local && notice.change !== 'revoked') return;
      const view = this.authority?.view();
      if (!view) return;
      const principals = [...notice.keys, ...notice.cascade]
        .filter((key) => key.startsWith('device-token:') && view.isRevoked(key))
        .map((key) => pairingPrincipalId(key.slice('device-token:'.length)));
      if (principals.length === 0) return;
      for (const listener of [...this.#revocationListeners]) {
        try { listener(principals); }
        catch (error) { logger.warn('Pairing revocation listener failed', { error: String(error) }); }
      }
    });
    this.continuationOwner = new NativeContinuationOwner(filePath);
    this.readMaxPaired = options.maxPaired ?? null;
    this.nativeDataWriter = options.nativeDataWriter;
    this.snapshot = { tokens: [] };
    let lock: PairingOwnerLock | undefined;
    try {
      lock = this.acquireOwnerLock();
      // Use the strict observed snapshot itself. A second recovery-capable read
      // could observe different bytes and manufacture fresh absence after recovery.
      try {
        const observed = this.readPersisted();
        this.settingsCleanInitialAbsence = observed === null;
        this.settingsInitializationVerified = true;
        this.snapshot = observed ?? { tokens: [] };
      } catch (error) {
        this.faultSettings('read');
        // Retain ordinary recovery, with the observed strict failure recorded.
        if (!(error instanceof UnsupportedNativeSourceBindingError)) this.snapshot = this.load();
      }
    } catch {
      // A live owner may be launching, or this process may lack write access.
      // Reading a complete file is safe; quarantining/repairing it without
      // ownership is not. Ordinary auth retains its read-only startup behavior.
      // Settings authority stays unverified until a capture verifies it under the lock.
      try { this.snapshot = this.readPersisted() ?? { tokens: [] }; } catch { /* fail closed */ }
    } finally { lock?.release(); }
    this.reindex();
    this.#publishedAuthority = authorityText(this.snapshot);
  }

  /**
   * Pairing authority as a revision source. Another process's change shows
   * once this owner reads the file (authenticate, list, a mutation).
   */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  /**
   * Told the principal ids whose credential stopped being valid: a revoked or
   * replaced pairing (`pairing:<id>`) and `shared-token` when the legacy token
   * is revoked. Fires for this process's changes and for another process's
   * changes once this owner reads them. Returns the unsubscribe.
   */
  onRevoked(listener: (principalIds: readonly string[]) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => { this.#revocationListeners.delete(listener); };
  }

  /**
   * Told after the pairings changed (a device paired, an offer minted, a rename or a revoke): this
   * process's changes, and another process's once this owner reads them. Called after the write
   * that made the change has returned, never inside it. Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => { this.#changeListeners.delete(listener); };
  }

  /** The pairing file's identity now: ABSENT_FILE when missing, undefined when it cannot be stated. */
  #statIdentity(): string | undefined {
    try { return fileObservationIdentity(this.filePath); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT_FILE : undefined; }
  }

  /**
   * One lstat on the request path. The file is read and published again only
   * when its identity (inode, size, times) moved since this owner last read or
   * wrote it, so another process's mint or revoke is still taken in on the
   * next request. False while the last read failed: pairing tokens then fail
   * closed until a read succeeds.
   */
  private refreshIfChanged(): boolean {
    const identity = this.#statIdentity();
    if (identity !== undefined && identity === this.#observedIdentity) return !this.#readFaulted;
    try {
      const snapshot = this.readPersisted();
      // A missing file holds no pairings; a legacy revocation already seen stays
      // revoked, and the replacement this machine's apps hold stays theirs.
      const seen = this.snapshot;
      this.publish(snapshot ?? { tokens: [], ...(seen.legacyRevoked === true ? { legacyRevoked: true,
        ...(seen.localSharedHash !== undefined ? { localSharedHash: seen.localSharedHash } : {}) } : {}) });
      this.#readFaulted = false;
      this.#observedIdentity = identity;
    } catch {
      this.#readFaulted = true;
      this.#observedIdentity = undefined;
    }
    return !this.#readFaulted;
  }

  /**
   * The configured cap, or null when there is none / it is unusable.
   *
   * A non-positive or non-finite value is treated as "no cap" rather than "no
   * device may ever pair": a broken setting must not lock the owner out of
   * their own daemon.
   */
  private currentCap(): number | null {
    if (!this.readMaxPaired) return null;
    let raw: number | undefined;
    try {
      raw = this.readMaxPaired();
    } catch {
      return null;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
  }

  /**
   * How many paired device nodes exist right now, one record per node; an
   * offer nobody has used is not one, and neither is the Agent's credential.
   */
  pairedCount(): number {
    return this.snapshot.tokens.filter(record => record.offeredUntil === undefined && record.client !== 'agent').length;
  }

  /**
   * Managed token rotation: `read` returns the oldest a device token may be (ms)
   * to authenticate, or null for no limit. Read at each authentication, so a
   * settings change applies on the next request. Undefined removes the limit.
   */
  setRotationLimit(read: (() => number | null) | undefined): void {
    this.#rotationLimit = read;
  }

  /**
   * What claiming `offer` against `tokens` does under `device.nodes.maxPaired`.
   * The first use of an offer adds a paired node, so it is bounded as a mint
   * is: below the cap it adds; at the cap a node already paired under the same
   * name is superseded by it; any other node is refused, and the offer stays
   * usable until it expires, so it works once a device is unpaired. The
   * Agent's credential and an offer minted for a shared-token migration are
   * exempt, as their mints were. One filter, only for an unclaimed offer.
   */
  private capAtClaim(offer: StoredPairingToken, tokens: readonly StoredPairingToken[]):
    { readonly refused: CredentialRefusal } | { readonly supersedes: StoredPairingToken | undefined } {
    if (offer.offeredUntil === undefined || offer.client === 'agent' || offer.capExempt === true) return { supersedes: undefined };
    const cap = this.currentCap();
    if (cap === null) return { supersedes: undefined };
    const paired = tokens.filter(record => record.offeredUntil === undefined && record.client !== 'agent');
    if (paired.length < cap) return { supersedes: undefined };
    const normalized = offer.name.trim().toLowerCase();
    const existing = normalized ? paired.find(record => record.name.trim().toLowerCase() === normalized) : undefined;
    if (existing) return { supersedes: existing };
    return {
      refused: {
        code: 'DEVICE_NODES_MAX_PAIRED',
        state: `device.nodes.maxPaired is ${cap} and ${paired.length} ${paired.length === 1 ? 'device is' : 'devices are'} already paired, so this pairing code cannot add another`,
        reason: 'The paired-device limit is reached',
        next: [
          "Unpair a device on the owner's machine, or raise device.nodes.maxPaired, then use this pairing code again before it expires",
        ],
      },
    };
  }

  /** Why this record does not authenticate now, or null when it does. */
  private refusalOf(record: StoredPairingToken, now: number): CredentialRefusal | null {
    if (isExpiredOffer(record, now)) {
      return {
        code: 'PAIRING_OFFER_EXPIRED',
        state: `this pairing code was not used within ${Math.round(PAIRING_OFFER_LIFETIME_MS / 60_000)} minutes of being made, so it expired`,
        reason: 'The pairing code expired unused',
        next: ["Show a new pairing code on the owner's machine and use it right away"],
      };
    }
    if (record.offeredUntil !== undefined) {
      const atCap = this.capAtClaim(record, this.snapshot.tokens);
      return 'refused' in atCap ? atCap.refused : null;
    }
    return this.#rotationRefusal(record.name, record.createdAt, now);
  }

  /**
   * The managed-rotation refusal for a device token issued at `issuedAt`, or
   * null while it is inside the age `security.tokenAudit.managed` allows (or
   * no limit is set). The same rule for a token known here and one known only
   * from the authority record, so every machine of the group refuses alike.
   */
  #rotationRefusal(name: string, issuedAt: number, now: number): CredentialRefusal | null {
    let limit: number | null = null;
    try { limit = this.#rotationLimit?.() ?? null; } catch { limit = null; }
    if (limit === null || !Number.isFinite(limit) || limit <= 0 || now - issuedAt <= limit) return null;
    const ageDays = Math.floor((now - issuedAt) / DAY_MS);
    return {
      code: 'PAIRING_TOKEN_ROTATION_DUE',
      state: `the token of "${name}" is ${ageDays} days old and managed token rotation (security.tokenAudit.managed) allows ${Math.floor(limit / DAY_MS)} days`,
      reason: 'This device token is past its rotation age and no longer authenticates',
      next: ["Pair this device again from the owner's machine to get a new token, then revoke the old one"],
    };
  }

  /**
   * Why a token this store knows does not authenticate (an offer that expired
   * unused, or a device token past the managed rotation age), or null. A token
   * known only from the authority record (paired on another machine of the
   * group) is checked against the same rotation rule. For the refusal a caller
   * answers after authentication failed; never grants access.
   */
  describeRefusal(token: string): CredentialRefusal | null {
    const normalized = token.trim();
    if (!normalized.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(normalized);
    const record = this.index.get(hash);
    if (record) return this.refusalOf(record, Date.now());
    const entry = this.authority?.view()?.deviceTokenByHash(hash);
    return entry ? this.#rotationRefusal(entry.public.name, recordIssuedAt(entry.public), Date.now()) : null;
  }

  /**
   * Why a presented credential is refused, when this store is what refuses it:
   * a device token it knows (see {@link describeRefusal}), or a shared
   * operator token after the shared token was revoked here. `sharedToken` is
   * the daemon's own copy, null when it has none. Asked only on the 401 path;
   * never grants access.
   */
  describePresentedRefusal(token: string, sharedToken: string | null): CredentialRefusal | null {
    const device = this.describeRefusal(token);
    if (device) return device;
    const normalized = token.trim();
    if (!normalized || isPairingTokenShape(normalized) || !this.isLegacyRevoked()) return null;
    const served = sharedToken !== null && matchesSharedToken(normalized, sharedToken);
    // A served value that is still refused: the revocation is recorded, its replacement not yet written.
    if (served && !this.refusesSharedToken(normalized)) return null;
    if (!served && !normalized.startsWith(SHARED_TOKEN_PREFIX)) return null;
    return {
      code: 'SHARED_TOKEN_REVOKED',
      state: served
        ? 'the shared operator token was revoked on this daemon and its replacement is not written yet'
        : 'this is not the daemon\'s shared operator token: the shared token was revoked and replaced, and only the daemon\'s own machine holds the new one',
      reason: 'This request presented a shared operator token that this daemon no longer accepts.',
      next: served
        ? ['Restart the daemon so it writes the replacement token, then retry from this machine.']
        : ['Pair this device for its own token: run /devices pair in the GoodVibes terminal on the daemon\'s machine (or goodvibes-daemon pair there), then use the new link.'],
    };
  }

  /**
   * Whether the shared operator token value `token` is refused here: the
   * shared token was revoked and `token` is not the replacement written for
   * this machine's own apps. One `lstat` (the file is read only when it moved)
   * and, while revoked, one hash.
   */
  refusesSharedToken(token: string): boolean {
    this.refreshIfChanged();
    if (this.snapshot.legacyRevoked !== true) return false;
    const replacement = this.snapshot.localSharedHash;
    return replacement === undefined || hashToken(token.trim()) !== replacement;
  }

  /** Take in the last-seen times stamped since the last write; true when a record moved. */
  #applyPendingLastSeen(snapshot: PairingTokenSnapshot): boolean {
    let moved = false;
    for (const record of snapshot.tokens) {
      const seen = this.#pendingLastSeen.get(record.id);
      if (seen !== undefined && (record.lastSeenAt ?? 0) < seen) { record.lastSeenAt = seen; moved = true; }
    }
    return moved;
  }

  #stampLastSeen(record: StoredPairingToken, now: number): void {
    record.lastSeenAt = now;
    this.#pendingLastSeen.set(record.id, now);
    if (this.#lastSeenTimer !== undefined) return;
    this.#lastSeenTimer = setTimeout(() => { this.#lastSeenTimer = undefined; this.flushLastSeen(); }, LAST_SEEN_FLUSH_INTERVAL_MS);
    this.#lastSeenTimer.unref?.();
  }

  /**
   * Write the last-seen times stamped in memory. Runs on a timer when nothing
   * else wrote; a host may call it at shutdown. A failure keeps the stamps for
   * the next try and is logged once per run of failures.
   */
  flushLastSeen(): void {
    if (this.#pendingLastSeen.size === 0) return;
    try {
      this.mutate(current => ({ value: undefined, changed: this.#applyPendingLastSeen(current) }), false);
      this.#pendingLastSeen.clear();
      this.lastSeenFailureLogged = false;
    } catch (error) {
      if (!this.lastSeenFailureLogged) {
        logger.warn('Pairing token last-seen update failed', { path: this.filePath, error: String(error) });
        this.lastSeenFailureLogged = true;
      }
      if (this.#lastSeenTimer === undefined) {
        this.#lastSeenTimer = setTimeout(() => { this.#lastSeenTimer = undefined; this.flushLastSeen(); }, LAST_SEEN_FLUSH_INTERVAL_MS);
        this.#lastSeenTimer.unref?.();
      }
    }
  }

  private load(): PairingTokenSnapshot {
    // A corrupt file must not brick auth: start clean rather than throw. The
    // unreadable file is quarantined (moved aside with a receipt) instead of
    // being silently overwritten by the next flush, so the operator can see
    // which device tokens were lost and re-pair those devices.
    try {
      return (
        readJsonFileOrQuarantine<PairingTokenSnapshot>(this.filePath, {
          label: 'pairing/pairing-token-store',
          recovery: 'Every previously paired device must pair again; no device keeps access on a token this store can no longer verify.',
          validate: validateSnapshot,
        }) ?? { tokens: [] }
      );
    } catch {
      this.faultSettings('read');
      return { tokens: [] };
    }
  }

  /** A failed owner write or a lost lock outranks a read fault; nothing downgrades it. */
  private faultSettings(kind: 'read' | 'owner'): void {
    if (this.settingsFaulted !== 'owner') this.settingsFaulted = kind;
  }

  private reindex(): void {
    this.index = new Map(this.snapshot.tokens.map((t) => [t.tokenHash, t]));
  }

  /** Never quarantine or repair as a side effect of authenticating a request. */
  private readPersisted(): PairingTokenSnapshot | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      this.settingsObservedStore = true;
      const snapshot = validateSnapshot(JSON.parse(raw));
      if (snapshot.legacyRevoked === true) this.settingsObservedLegacyRevocation = true;
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Something is there, even if unreadable: a later absence is not a clean one.
      this.settingsObservedStore = true;
      this.faultSettings('read');
      throw error;
    }
  }

  /**
   * One owner lock for EVERY writer and the native launch boundary, including
   * other managers/processes. Acquisition never waits on the JS thread. No
   * age-based stealing: a suspended live owner is still an owner. A crash leaves
   * a fail-closed lock requiring explicit recovery, never guessed authority.
   */
  private acquireOwnerLock(): PairingOwnerLock {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Initialize once, before any native request captures its target ancestry.
    // The permanent marker fences older mkdir-based writers without changing
    // the target directory's revision for every final publication lease.
    const markerPath = `${this.filePath}.owner-lock`;
    try { writeFileSync(markerPath, OWNER_LOCK_NAMESPACE_VERSION, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const marker = lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || (marker.mode & 0o077) !== 0
      || readFileSync(markerPath, 'utf8') !== OWNER_LOCK_NAMESPACE_VERSION) throw new PairingTokenStoreBusyError();
    const namespacePath = join(dirname(this.filePath), '.pairing-owner-locks');
    try { mkdirSync(namespacePath, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const namespace = lstatSync(namespacePath);
    if (!namespace.isDirectory() || namespace.isSymbolicLink() || (namespace.mode & 0o077) !== 0) throw new PairingTokenStoreBusyError();
    const lockPath = join(namespacePath, `${basename(this.filePath)}.lock`);
    for (let attempt = 0;; attempt++) {
      try { mkdirSync(lockPath); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A lock left by a crash is reclaimed only when its recorded holder is proven dead.
        if (reclaimDeadOwnerLock(lockPath)) continue;
        // A holder still writing its record is taking the lock right now, not a crash leftover: wait for it.
        if (waitWhileLockIsBeingTaken(lockPath, attempt)) continue;
        throw new PairingTokenStoreBusyError(describeOwnerLock(lockPath));
      }
    }
    const owned = lstatSync(lockPath);
    try { recordOwnerLockHolder(lockPath); }
    catch (error) { rmdirSync(lockPath); throw error; }
    const assertOwned = () => {
      let current;
      try { current = lstatSync(lockPath); } catch { throw new PairingTokenStoreBusyError(); }
      const currentMarker = lstatSync(markerPath), currentNamespace = lstatSync(namespacePath);
      if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.birthtimeMs !== owned.birthtimeMs || currentMarker.dev !== marker.dev || currentMarker.ino !== marker.ino
        || currentMarker.ctimeMs !== marker.ctimeMs || currentMarker.size !== marker.size
        || !currentMarker.isFile() || currentMarker.isSymbolicLink() || currentMarker.nlink !== 1 || (currentMarker.mode & 0o077) !== 0
        || readFileSync(markerPath, 'utf8') !== OWNER_LOCK_NAMESPACE_VERSION
        || !currentNamespace.isDirectory() || currentNamespace.isSymbolicLink()
        || (currentNamespace.mode & 0o077) !== 0
        || currentNamespace.dev !== namespace.dev || currentNamespace.ino !== namespace.ino) throw new PairingTokenStoreBusyError();
    };
    return { assertOwned, release: () => { assertOwned(); removeOwnerLockDirectory(lockPath); } };
  }

  private publish(snapshot: PairingTokenSnapshot): void {
    const authority = authorityText(snapshot);
    const moved = authority !== this.#publishedAuthority;
    const revoked = moved && this.#revocationListeners.size > 0 ? revokedPrincipals(this.snapshot, snapshot) : [];
    if (moved) { this.#publishedAuthority = authority; this.#authorityRevision++; }
    this.snapshot = snapshot;
    if (snapshot.legacyRevoked === true) this.settingsObservedLegacyRevocation = true;
    this.reindex();
    const ids = new Set(snapshot.tokens.map(token => token.id));
    for (const id of this.publishedTokenRevisions.keys()) if (!ids.has(id)) this.publishedTokenRevisions.delete(id);
    // Deferred: publish runs inside a write that still holds the owner lock.
    if (moved && this.#changeListeners.size > 0) {
      const listeners = [...this.#changeListeners];
      queueMicrotask(() => {
        for (const listener of listeners) {
          try { listener(); }
          catch (error) { logger.warn('Pairing change listener failed', { error: String(error) }); }
        }
      });
    }
    if (revoked.length === 0) return;
    for (const listener of [...this.#revocationListeners]) {
      try { listener(revoked); }
      catch (error) { logger.warn('Pairing revocation listener failed', { error: String(error) }); }
    }
  }

  /** Reload under ownership, persist, THEN expose a successful mutation. */
  private mutate<T>(operation: (snapshot: PairingTokenSnapshot) => { readonly value: T; readonly changed: boolean }, nativeRecovery = true,
    /**
     * True when the operation only ADDED authority (a new pairing replacing nothing). A write that
     * fails then cannot have left a revocation unrecorded, so the settings fault is the re-verifiable
     * kind: the next capture re-reads the disk under the lock. A revoke, rename or grant that fails
     * to persist keeps the strict hold until restart.
     */
    additiveOnly: () => boolean = () => false): T {
    const lock = this.acquireOwnerLock();
    let durable = false;
    try {
      const persisted = this.readPersisted();
      const snapshot = persisted ?? { tokens: [] };
      const result = operation(snapshot);
      // Rides on a write that is happening anyway; a read never rewrites the file.
      if (result.changed) {
        pruneUnpresentableContinuations(snapshot);
        dropExpiredOffers(snapshot, Date.now());
        this.#applyPendingLastSeen(snapshot);
      }
      try {
        lock.assertOwned();
        if (result.changed) {
          if (snapshot.continuations?.some(grant => grant.sourceBindingVersion === 2)) {
            try {
              assertSynchronousJudgmentGuard(() => this.nativeDataWriter?.declare('pairing-native-source-bindings-v2'), () => new Error('Native source binding declaration must be synchronous'));
            } catch (error) { drainOwned(error); throw error; }
            lock.assertOwned();
          }
          writeJsonFileAtomic(this.filePath, snapshot, { mode: 0o600, trailingNewline: false, durable: true });
          this.settingsObservedStore = true;
          this.#pendingLastSeen.clear();
          durable = true;
        } else if (nativeRecovery && persisted !== null) {
          // Retrying an indeterminate revoke can find the record already absent.
          // Readable bytes alone do not clear uncertainty; confirm the full
          // publication even when the retry has no new bytes to write.
          confirmFileDurable(this.filePath);
          durable = true;
        }
      } catch (error) {
        this.nativePersistenceFailed = nativeRecovery || this.nativePersistenceFailed === 'owner' ? 'owner' : 'last-seen';
        // A last-seen stamp changes no authority, so its failure is re-verifiable like an additive write.
        this.faultSettings(additiveOnly() || !nativeRecovery ? 'read' : 'owner');
        throw error;
      }
      if (nativeRecovery ? result.changed || persisted !== null : result.changed && this.nativePersistenceFailed === 'last-seen') {
        this.nativePersistenceFailed = false;
      }
      lock.assertOwned();
      // Read or written under the owner lock, so this is the identity of what is published.
      this.#observedIdentity = this.#statIdentity();
      if (durable) this.#durableIdentity = this.#observedIdentity;
      this.#readFaulted = false;
      this.publish(snapshot);
      return result.value;
    } finally { lock.release(); }
  }

  /**
   * Read without fallback, repair, telemetry, or native-only substitution.
   * Called only under the owner lock. A read fault, or a start that could not
   * take the lock, is re-verified here: a valid, durably confirmed snapshot
   * clears it. An owner-write fault is never cleared here.
   */
  private readSettingsSnapshot(): PairingTokenSnapshot | null {
    if (this.settingsFaulted === 'owner') throw new SettingsAuthorityUnavailableError();
    const recovering = this.settingsFaulted !== false || !this.settingsInitializationVerified;
    const recovered = () => {
      if (recovering) logger.info('Pairing settings authority verified under the owner lock', { path: this.filePath });
      this.settingsInitializationVerified = true;
      this.settingsFaulted = false;
    };
    try {
      const snapshot = this.readPersisted();
      if (snapshot === null) {
        // Only a start verified under the lock can certify a fresh absence.
        if (!this.settingsInitializationVerified || !this.settingsCleanInitialAbsence || this.settingsObservedStore) throw new SettingsAuthorityUnavailableError();
        recovered();
        return null;
      }
      confirmFileDurable(this.filePath);
      // The owner lock fences supported pairing writers. This re-read also
      // rejects a publication changed during durability confirmation.
      const confirmed = this.readPersisted();
      if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(snapshot)) throw new SettingsAuthorityUnavailableError();
      recovered();
      return confirmed;
    } catch {
      this.faultSettings('read');
      throw new SettingsAuthorityUnavailableError();
    }
  }

  /**
   * Whether the shared token value hashing to `hash` may hold settings
   * authority in `snapshot`: never revoked (and no revocation was ever seen
   * here), or revoked and `hash` names its replacement.
   */
  private sharedSettingsAllowed(snapshot: PairingTokenSnapshot | null, hash: string): boolean {
    if (snapshot?.legacyRevoked === true) return snapshot.localSharedHash === hash;
    return !this.settingsObservedLegacyRevocation;
  }

  captureSettingsAuthority(input: { readonly kind: 'shared-token'; readonly token: string }
    | { readonly kind: 'pairing-token'; readonly token: string }): SettingsPairingAuthority | null {
    if (input.kind === 'pairing-token' && !isPairingTokenShape(input.token)) return null;
    let lock: PairingOwnerLock | undefined;
    try {
      lock = this.acquireOwnerLock();
      const snapshot = this.readSettingsSnapshot();
      let record: SettingsPairingAuthorityRecord;
      if (input.kind === 'shared-token') {
        const hash = hashToken(input.token.trim());
        if (!this.sharedSettingsAllowed(snapshot, hash)) return null;
        record = { kind: 'shared-token', hash };
      } else {
        if (!snapshot?.tokens.length) return null;
        const hash = hashToken(input.token.trim());
        const paired = snapshot?.tokens.find(item => item.tokenHash === hash);
        if (!paired || this.refusalOf(paired, Date.now())) return null;
        record = { kind: 'pairing-token', hash, id: paired.id, createdAt: paired.createdAt };
      }
      lock.assertOwned();
      const handle = Object.freeze({ kind: record.kind }) as SettingsPairingAuthority;
      this.settingsAuthorities.set(handle, record);
      return handle;
    } catch { return null; }
    finally { lock?.release(); }
  }

  /**
   * One-use, synchronous current-auth boundary. The effect owner MUST call the
   * supplied check after its reentrant preparation and immediately before its
   * effect. No post-effect check may misreport an already committed operation.
   */
  withSettingsAuthority<T>(authority: SettingsPairingAuthority,
    operation: (assertCurrent: () => void) => T): T {
    const expected = this.settingsAuthorities.get(authority);
    this.settingsAuthorities.delete(authority);
    if (!expected) throw new SettingsAuthorityUnavailableError();
    const lock = this.acquireOwnerLock();
    let active = true;
    let completed = false;
    try {
      const assertCurrent = () => {
        if (!active) throw new SettingsAuthorityUnavailableError();
        lock.assertOwned();
        const current = this.readSettingsSnapshot();
        if (expected.kind === 'shared-token') {
          if (expected.hash === undefined || !this.sharedSettingsAllowed(current, expected.hash)) throw new SettingsAuthorityUnavailableError();
        } else if (!current?.tokens.some(item => item.tokenHash === expected.hash
          && item.id === expected.id && item.createdAt === expected.createdAt)) {
          throw new SettingsAuthorityUnavailableError();
        }
      };
      assertCurrent();
      const result = runSynchronousSettingsOperation(operation, assertCurrent);
      completed = true;
      return result;
    } finally {
      active = false;
      try { lock.release(); }
      catch (error) {
        this.faultSettings('owner');
        // Cleanup cannot undo an effect or replace its truthful receipt with a
        // refusal. A leftover/lost lock and this owner fault block later work.
        if (!completed) throw error;
      }
    }
  }

  /**
   * Native authority reads the published snapshot once the file it came from
   * is known durable: one `lstat` per check (the file is read again only when
   * its identity moved), and one durability confirmation per new identity.
   * Last-seen and labels are not authority generations. A failed confirmation
   * never grants authority.
   */
  #nativeSnapshotCurrent(): boolean {
    if (!this.refreshIfChanged()) return false;
    const identity = this.#observedIdentity;
    if (identity === undefined || identity === ABSENT_FILE) return false;
    if (identity === this.#durableIdentity) return true;
    try {
      // A fresh manager cannot treat post-rename, unconfirmed bytes as durable
      // authority. Confirmation also makes recovery after restart explicit.
      confirmFileDurable(this.filePath);
    } catch (error) {
      if (error instanceof AtomicWriteDurabilityError) this.nativePersistenceFailed = 'owner';
      this.faultSettings('read');
      return false;
    }
    // Replaced while it was confirmed: the next check reads the new file.
    if (this.#statIdentity() !== identity) return false;
    this.#durableIdentity = identity;
    return true;
  }

  /**
   * The native identity of a pairing token, or of the owner's own machine
   * ({@link LOCAL_OWNER_CREDENTIAL}, which the transport passes only after it
   * established that credential). Never writes and never stamps last-seen.
   */
  authenticateNative(credential: NativeCredential): AuthenticatedNativePairingToken | null {
    if (this.nativePersistenceFailed) return null;
    if (credential === LOCAL_OWNER_CREDENTIAL) {
      if (!this.#nativeSnapshotCurrent()) return null;
      const owner = this.snapshot.localOwner;
      return owner && sharedTokenUsable(this.snapshot) ? nativeIdentityOf(owner) : null;
    }
    const normalized = credential.trim();
    if (!normalized.startsWith(TOKEN_PREFIX) || !this.#nativeSnapshotCurrent() || this.index.size === 0) return null;
    const live = this.index.get(hashToken(normalized));
    if (!live || this.refusalOf(live, Date.now())) return null;
    return nativeIdentityOf(live);
  }

  /**
   * Whether a native principal can still act here: the owner's own machine
   * always can (its principal id outlives a replaced shared token), and a
   * pairing's principal can while its pairing is listed. A pairing that was
   * revoked or replaced by a re-pair is gone for good, since a new pairing
   * gets a new principal. A snapshot that cannot be read answers true, so
   * nothing is treated as gone on missing evidence. Never writes.
   */
  nativePrincipalCurrent(principalId: string): boolean {
    if (principalId === LOCAL_OWNER_PRINCIPAL) return true;
    if (this.nativePersistenceFailed || !this.#nativeSnapshotCurrent()) return true;
    return this.snapshot.tokens.some(token => pairingPrincipalId(token.id) === principalId);
  }

  /**
   * The owner's own machine's native identity, made the first time one of its
   * apps uses native work (one durable write, once) and read after that. A
   * revocation of the shared token ends it, and the next use after the
   * replacement makes a new one. Null while the shared token is revoked and
   * not yet replaced, or when the record cannot be written; the refusal the
   * caller gives then names pairing as the way on.
   */
  ensureLocalNativeOwner(): AuthenticatedNativePairingToken | null {
    const current = this.authenticateNative(LOCAL_OWNER_CREDENTIAL);
    if (current || this.nativePersistenceFailed || !sharedTokenUsable(this.snapshot)) return current;
    try {
      const made = this.mutate(snapshot => {
        if (!sharedTokenUsable(snapshot)) return { value: false, changed: false };
        if (snapshot.localOwner) return { value: true, changed: false };
        snapshot.localOwner = { id: `local-${randomUUID()}`, createdAt: Date.now(), tokenHash: randomBytes(32).toString('hex') };
        return { value: true, changed: true };
      }, true, () => true);
      return made ? this.authenticateNative(LOCAL_OWNER_CREDENTIAL) : null;
    } catch (error) {
      logger.warn('The local native owner could not be recorded; native work from this machine is refused until it can be', { path: this.filePath, error: String(error) });
      return null;
    }
  }

  /** Hold native ownership through the caller's workspace/ledger/launch boundary. */
  async withNativeAuthority<T>(credential: NativeCredential, expected: AuthenticatedNativePairingToken,
    operation: (assertCurrent: () => AuthenticatedNativePairingToken) => T | Promise<T>): Promise<T> {
    const lock = this.acquireOwnerLock();
    let active = true;
    try {
      const assertCurrent = () => {
        lock.assertOwned();
        const current = active ? this.authenticateNative(credential) : null;
        if (!current || current.kind !== expected.kind || current.tokenId !== expected.tokenId
          || current.principalId !== expected.principalId || current.authorityId !== expected.authorityId
          || current.authorityRevision !== expected.authorityRevision) {
          throw new Error('Persisted native authority is no longer valid');
        }
        return current;
      };
      assertCurrent();
      return await operation(assertCurrent);
    } finally { active = false; lock.release(); }
  }

  private continuationCustodyMatches(grant: StoredNativeContinuationGrant, token: NativeCustodian): boolean {
    const revision = token.nativeContinuationRevision;
    if (revision?.id === grant.tokenRevision) {
      return revision.createdAt === token.createdAt && revision.tokenHash === token.tokenHash
        && this.continuationOwner.current() === grant.ownerRoot;
    }
    // Existing v1 bytes are verified against their original representation,
    // never rewritten as newly issued authority. New grants use random IDs.
    let published = this.publishedTokenRevisions.get(token.id);
    if (!published || published.createdAt !== token.createdAt || published.tokenHash !== token.tokenHash) {
      published = { createdAt: token.createdAt, tokenHash: token.tokenHash,
        digest: hashToken(JSON.stringify([token.createdAt, token.tokenHash])) };
      this.publishedTokenRevisions.set(token.id, published);
    }
    if (grant.tokenRevision !== published.digest) return false;
    const parents = nativeContinuationParents(this.filePath);
    if (!this.publishedRoot || !isDeepStrictEqual(this.publishedRoot.parents, parents)) {
      this.publishedRoot = { parents, digest: hashToken(JSON.stringify(parents)) };
    }
    return grant.ownerRoot === this.publishedRoot.digest;
  }

  /**
   * Issue under the authenticating owner's private lock. The caller supplies its
   * exact source/scope/policy validator; persistence precedes any successful receipt.
   * No plaintext credential or signing material enters the issued record.
   */
  issueNativeContinuation(credential: NativeCredential, expected: NativeContinuationAuthority, binding: string, assertCurrent: () => void, sourceBinding = binding): NativeContinuationGrant {
    if (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding) || !/^[0-9a-f]{64}$/.test(binding) || !Array.isArray(expected.scopes) || !expected.scopes.length
      || expected.scopes.some(scope => typeof scope !== 'string' || !scope) || new Set(expected.scopes).size !== expected.scopes.length) throw new Error('Invalid continuation binding');
    return this.mutate(snapshot => {
      const current = this.authenticateNative(credential);
      if (!current || current.kind !== expected.kind || current.authorityId !== expected.authorityId || current.tokenId !== expected.tokenId || current.principalId !== expected.principalId
        || current.authorityRevision !== expected.authorityRevision) throw new Error('Native continuation owner is no longer current');
      assertCurrent();
      return this.appendNativeContinuation(snapshot, expected, binding, null, assertCurrent, sourceBinding);
    });
  }

  /** A consumed successor may transfer only its own current native source. */
  issueNativeContinuationFromGrant(parent: NativeContinuationGrant, consumption: string,
    expected: NativeContinuationAuthority, binding: string, assertCurrent: () => void, sourceBinding?: string): NativeContinuationGrant {
    if ((sourceBinding !== undefined && (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding))) || !/^[0-9a-f]{64}$/.test(binding) || !/^[0-9a-f]{64}$/.test(consumption)) throw new Error('Invalid continuation lineage');
    return this.mutate(snapshot => {
      const current = this.readNativeContinuation(parent, consumption);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Native continuation parent is no longer current');
      const consumedSource = snapshot.continuations?.find(item => item.id === parent.id && item.binding === parent.binding)?.successorSourceBinding;
      if (!consumedSource || (sourceBinding !== undefined && sourceBinding !== consumedSource)) throw new Error('Native continuation child source differs from consumed successor');
      assertCurrent();
      return this.appendNativeContinuation(snapshot, expected, binding, { ...parent, consumption }, assertCurrent, consumedSource);
    });
  }

  private appendNativeContinuation(snapshot: PairingTokenSnapshot, expected: NativeContinuationAuthority, binding: string,
    parent: StoredNativeContinuationGrant['parent'], assertCurrent: () => void, sourceBinding: string): { changed: boolean; value: NativeContinuationGrant } {
    if (snapshot.revokedNativeSources?.includes(sourceBinding)) throw new Error('Native continuation source was cancelled');
    const tokenRecord = custodianOf(snapshot, expected.tokenId);
    if (!tokenRecord) throw new Error('Native continuation pairing is unavailable');
    const previous = snapshot.continuations?.find(item => item.tokenId === expected.tokenId && item.binding === binding);
    if (previous) {
      if (previous.sourceBinding !== sourceBinding || previous.revoked || !this.continuationCustodyMatches(previous, tokenRecord)
        || JSON.stringify(previous.parent) !== JSON.stringify(parent)
        || JSON.stringify(previous.scopes) !== JSON.stringify([...expected.scopes].sort())) throw new Error('Native continuation issuance was revoked or changed');
      assertCurrent(); return { changed: false, value: Object.freeze({ id: previous.id, binding: previous.binding }) };
    }
    let tokenRevision: string, ownerRoot: string;
    if (parent) {
      // A descendant retains its validated parent's exact credential/root
      // incarnation, including an existing v1 lineage. No new digest is made.
      const ancestor = snapshot.continuations?.find(item => item.id === parent.id && item.binding === parent.binding && item.consumption === parent.consumption);
      if (!ancestor || !this.continuationCustodyMatches(ancestor, tokenRecord)) throw new Error('Native continuation parent custody changed');
      tokenRevision = ancestor.tokenRevision; ownerRoot = ancestor.ownerRoot;
    } else {
      if (!tokenRecord.nativeContinuationRevision || tokenRecord.nativeContinuationRevision.createdAt !== tokenRecord.createdAt
        || tokenRecord.nativeContinuationRevision.tokenHash !== tokenRecord.tokenHash) {
        tokenRecord.nativeContinuationRevision = { id: randomBytes(32).toString('hex'), createdAt: tokenRecord.createdAt, tokenHash: tokenRecord.tokenHash };
      }
      tokenRevision = tokenRecord.nativeContinuationRevision.id;
      try { ownerRoot = this.continuationOwner.ensure(); }
      catch (error) { this.nativePersistenceFailed = 'owner'; this.faultSettings('owner'); throw error; }
    }
    const grant: StoredNativeContinuationGrant = { id: `continuation-${randomUUID()}`, binding, sourceBindingVersion: 2, sourceBinding, successorSourceBinding: null, parent, tokenId: expected.tokenId,
      tokenRevision, ownerRoot, watchBinding: null, scopes: [...expected.scopes].sort(), createdAt: Date.now(), consumption: null, revoked: false };
    (snapshot.continuations ??= []).push(grant); assertCurrent();
    return { changed: true, value: Object.freeze({ id: grant.id, binding: grant.binding }) };
  }

  /**
   * Strict restart lookup of an actually issued grant, never adoption by token
   * ID. Reads the published snapshot once its file is known durable (one
   * `lstat` per lookup; the file is read again only when it changed).
   */
  readNativeContinuation(grant: NativeContinuationGrant, consumption?: string, watchBinding?: string): NativeContinuationAuthority | null {
    if (this.nativePersistenceFailed) return null;
    try {
      if (!this.#nativeSnapshotCurrent()) return null;
      const snapshot = this.snapshot;
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      const token = issued && custodianOf(snapshot, issued.tokenId);
      if (!issued || !token || !this.continuationCustodyMatches(issued, token)
        || (watchBinding !== undefined && issued.watchBinding !== watchBinding)
        || snapshot.revokedNativeSources?.includes(issued.sourceBinding) || (issued.successorSourceBinding !== null && snapshot.revokedNativeSources?.includes(issued.successorSourceBinding))
        || issued.revoked || (consumption !== undefined && issued.consumption !== consumption)) return null;
      const visited = new Set<string>([issued.id]); let child = issued;
      while (child.parent) {
        const parent = snapshot.continuations?.find(item => item.id === child.parent!.id && item.binding === child.parent!.binding);
        if (!parent || visited.has(parent.id) || parent.revoked
          || snapshot.revokedNativeSources?.includes(parent.sourceBinding) || (parent.successorSourceBinding !== null && snapshot.revokedNativeSources?.includes(parent.successorSourceBinding))
          || parent.consumption !== child.parent.consumption
          || parent.tokenId !== issued.tokenId || parent.tokenRevision !== issued.tokenRevision || parent.ownerRoot !== issued.ownerRoot
          || JSON.stringify(parent.scopes) !== JSON.stringify(issued.scopes)) return null;
        visited.add(parent.id); child = parent;
      }
      return Object.freeze({ ...nativeIdentityOf(token), scopes: Object.freeze([...issued.scopes]) });
    } catch { return null; }
  }

  async withNativeContinuation<T>(grant: NativeContinuationGrant, expected: NativeContinuationAuthority,
    operation: (assertCurrent: () => NativeContinuationAuthority) => T | Promise<T>): Promise<T> {
    const lock = this.acquireOwnerLock(); let active = true;
    try {
      const assertCurrent = () => {
        lock.assertOwned(); const current = active ? this.readNativeContinuation(grant) : null;
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Native continuation authority is no longer current');
        return current;
      };
      assertCurrent(); return await operation(assertCurrent);
    } finally { active = false; lock.release(); }
  }

  /** The exact resolved watch is independently retained by the issuing owner. */
  bindNativeContinuationWatch(grant: NativeContinuationGrant, watchBinding: string, assertCurrent: () => void): void {
    if (!/^[0-9a-f]{64}$/.test(watchBinding)) throw new Error('Invalid continuation watch binding');
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked
        || !custodianOf(snapshot, issued.tokenId)
        || (issued.watchBinding !== null && issued.watchBinding !== watchBinding)) throw new Error('Native continuation watch is unavailable or already bound');
      if (!this.readNativeContinuation(grant)) throw new Error('Native continuation lineage is unavailable');
      assertCurrent(); const changed = issued.watchBinding === null;
      if (changed) snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, watchBinding };
      assertCurrent(); return { changed, value: undefined };
    });
  }

  /** One immutable successor binding. Repeated delivery can only reconcile it. */
  consumeNativeContinuation(grant: NativeContinuationGrant, consumption: string, assertCurrent: () => void, successorSourceBinding = consumption): void {
    if (typeof successorSourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(successorSourceBinding) || !/^[0-9a-f]{64}$/.test(consumption)) throw new Error('Invalid continuation consumption');
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked || !custodianOf(snapshot, issued.tokenId)
        || snapshot.revokedNativeSources?.includes(successorSourceBinding)
        || (issued.consumption !== null && (issued.consumption !== consumption || issued.successorSourceBinding !== successorSourceBinding))) throw new Error('Native continuation is unavailable or already consumed');
      assertCurrent();
      if (!this.readNativeContinuation(grant)) throw new Error('Native continuation lineage is unavailable');
      const changed = issued.consumption === null;
      if (changed) snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, consumption, successorSourceBinding };
      assertCurrent(); return { changed, value: undefined };
    });
  }

  /** Only an authenticated native owner supplies the exact source-incarnation guard. */
  revokeNativeContinuationsForSource(sourceBinding: string, assertCurrent: () => void, compatibility?: {
    readonly authority: NativeContinuationAuthority;
    readonly legacyBinding: () => string;
  }): void {
    if (typeof sourceBinding !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBinding)) throw new Error('Invalid native source binding');
    this.mutate(snapshot => {
      assertCurrent();
      const bindings = new Set([sourceBinding]);
      if (compatibility) {
        const expected = compatibility.authority, token = custodianOf(snapshot, expected.tokenId);
        const identity = token && nativeIdentityOf(token);
        if (!token || !identity || expected.kind !== identity.kind || expected.authorityId !== expected.principalId
          || expected.principalId !== identity.principalId || expected.authorityRevision !== token.id) throw new Error('Native source owner changed');
        // Only actual pre-marker root grants can have the earlier producer bug.
        // A current marked grant never causes a historical recipe calculation.
        const candidates = snapshot.continuations?.filter(grant => !grant.revoked && grant.parent === null
          && grant.sourceBindingVersion === undefined && grant.tokenId === token.id
          && grant.sourceBinding !== sourceBinding && grant.successorSourceBinding !== sourceBinding
          && JSON.stringify(grant.scopes) === JSON.stringify([...expected.scopes].sort())
          && this.continuationCustodyMatches(grant, token)) ?? [];
        if (candidates.length) {
          let legacy: unknown;
          try { legacy = compatibility.legacyBinding(); } catch (error) { drainOwned(error); throw error; }
          if (typeof legacy !== 'string' || !/^[0-9a-f]{64}$/.test(legacy)) { drainOwned(legacy); throw new Error('Invalid historical native source binding'); }
          assertCurrent();
          if (candidates.some(grant => grant.sourceBinding === legacy)) bindings.add(legacy);
        }
      }
      const sources = snapshot.revokedNativeSources ??= []; let changed = false;
      for (const binding of bindings) if (!sources.includes(binding)) { sources.push(binding); changed = true; }
      if (snapshot.continuations) snapshot.continuations = snapshot.continuations.map(grant =>
        bindings.has(grant.sourceBinding) || (grant.successorSourceBinding !== null && bindings.has(grant.successorSourceBinding)) ? { ...grant, revoked: true } : grant);
      assertCurrent(); return { changed, value: undefined };
    });
  }

  revokeNativeContinuation(grant: NativeContinuationGrant, watchBinding?: string): void {
    this.mutate(snapshot => {
      const issued = snapshot.continuations?.find(item => item.id === grant.id && item.binding === grant.binding);
      if (!issued || issued.revoked) return { changed: false, value: undefined };
      if (watchBinding !== undefined && issued.watchBinding !== watchBinding) throw new Error('Native continuation revocation watch changed');
      snapshot.continuations![snapshot.continuations!.indexOf(issued)] = { ...issued, revoked: true };
      return { changed: true, value: undefined };
    });
  }

  /**
   * Mint a new named per-device token. The plaintext is returned only here.
   *
   * Bounded by `device.nodes.maxPaired` when the host supplied a reader for it.
   * The rules, all of which are exercised by tests:
   *
   * - Below the cap nothing changes at all, same append, same result.
   * - At the cap, a NEW node is refused with {@link PairingLimitReachedError},
   *   which names the setting, the cap and the live count.
   * - At the cap, a node that is ALREADY paired (same name) is never refused.
   *   Its working pairing is NOT touched here: the offer supersedes it only at
   *   its first use (see {@link capAtClaim}), so a code that expires unused, or
   *   is never used, leaves the device paired and working, and the count does
   *   not creep past the cap. Nobody else's pairing is touched.
   * - Lowering the cap below the current count unpairs NO ONE: existing tokens
   *   keep authenticating; only the next NEW pairing is refused, until enough
   *   devices are unpaired to fit under the cap again.
   */
  /**
   * `mintedBy` is the pairing id of the paired device asking (from its
   * principal); absent when the owner's own machine or shared token mints.
   */
  mint(input: MintPairingInput): MintedPairingToken {
    return this.mintInternal(input, { enforceCap: true });
  }

  private mintInternal(input: MintPairingInput, options: { readonly enforceCap: boolean }): MintedPairingToken {
    let replaced = false;
    const scopes = input.scopes === undefined ? undefined : [...new Set(input.scopes.map(scope => scope.trim()).filter(Boolean))];
    return this.mutate((snapshot) => {
      replaced = false;
      if (input.mintedBy !== undefined && !snapshot.tokens.some(record => record.id === input.mintedBy)) {
        throw new PairingMinterRevokedError();
      }
      const now = Date.now();
      dropExpiredOffers(snapshot, now);
      if (input.replacesOffer !== undefined) {
        const before = snapshot.tokens.length;
        snapshot.tokens = snapshot.tokens.filter(record => record.id !== input.replacesOffer || record.offeredUntil === undefined);
        if (snapshot.tokens.length !== before) replaced = true;
      }
      const attemptId = input.attemptId;
      const repeated = attemptId === undefined ? undefined
        : snapshot.tokens.find(record => record.offeredUntil !== undefined && record.attemptId === attemptId
          && record.mintedBy === input.mintedBy && record.client === input.client);
      if (repeated) {
        // The reply to this attempt was lost: the same offer goes out again under a
        // new secret, so nothing is added and the secret nobody received never works.
        // A new secret is a new credential incarnation, so no earlier one is carried over.
        const token = generateTokenValue();
        const reissued: StoredPairingToken = { ...repeated, tokenHash: hashToken(token), offeredUntil: now + PAIRING_OFFER_LIFETIME_MS };
        delete reissued.nativeContinuationRevision;
        snapshot.tokens = snapshot.tokens.map(record => record === repeated ? reissued : record);
        replaced = true;
        return { value: { id: reissued.id, name: reissued.name, token, createdAt: reissued.createdAt }, changed: true };
      }
      // The Agent's credential is not a device node, so the node cap does not apply to it.
      const cap = options.enforceCap && input.client !== 'agent' ? this.currentCap() : null;
      // An offer nobody has used yet is not a paired device and does not count toward the cap.
      const paired = snapshot.tokens.filter(record => record.offeredUntil === undefined && record.client !== 'agent');
      if (cap !== null && paired.length >= cap) {
        const normalized = input.name.trim().toLowerCase();
        const existing = normalized ? paired.find(record => record.name.trim().toLowerCase() === normalized) : undefined;
        if (!existing) throw new PairingLimitReachedError(cap, paired.length);
        // The working pairing stays until this offer is first used, which
        // supersedes it then; an offer that expires unused changes nothing.
        logger.info('Pairing at the device.nodes.maxPaired cap: an offer to re-pair an already paired node; it replaces that pairing at its first use', {
          name: existing.name, maxPaired: cap, pairedCount: paired.length,
        });
      }
      const token = generateTokenValue();
      const record: StoredPairingToken = {
        id: `pair-${randomUUID()}`, name: input.name.trim() || 'Unnamed device',
        tokenHash: hashToken(token), createdAt: now, offeredUntil: now + PAIRING_OFFER_LIFETIME_MS,
        ...(input.mintedBy !== undefined ? { mintedBy: input.mintedBy } : {}),
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(input.client === 'agent' ? { client: 'agent' as const } : {}),
        // The owner's own device only through his pairing flow, never with a narrowed list or a named client.
        ...(input.origin === 'owner-pairing' && scopes === undefined && input.client === undefined ? { origin: 'owner-pairing' as const } : {}),
        // A migration's mint skipped the cap; its first use does too.
        ...(!options.enforceCap ? { capExempt: true as const } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      };
      snapshot.tokens.push(record);
      return { value: { id: record.id, name: record.name, token, createdAt: record.createdAt }, changed: true };
    }, true, () => !replaced);
  }

  /**
   * A client currently on the legacy shared token moves to its own per-device
   * token. The "one receipt" is this single return; it does NOT revoke the
   * shared token (that is a separate, explicit step).
   *
   * Deliberately EXEMPT from `device.nodes.maxPaired`: this device is already
   * using this daemon on the shared token. Refusing it would strand a working
   * device on a credential it is being asked to give up, which is a worse
   * outcome than being one over a cap that no longer describes reality. A new
   * device pairing for the first time is still bounded.
   */
  mintForMigration(input: MintPairingInput): MintedPairingToken {
    // `origin` is the caller's to state: pairing.tokens.migrate (a direct API mint) states none,
    // so its token is automation; the owner's pairing hand-off states owner-pairing.
    return this.mintInternal(input, { enforceCap: false });
  }

  /** Whether `id` is an offer nobody has used yet and that has not expired. */
  isOpenOffer(id: string): boolean {
    this.refreshIfChanged();
    const offeredUntil = this.snapshot.tokens.find(item => item.id === id)?.offeredUntil;
    return offeredUntil !== undefined && offeredUntil > Date.now();
  }

  /**
   * Authenticate a presented token by hashing it and looking the hash up.
   * Immediate revocation: a revoked (deleted) token misses here and the caller
   * treats the request as unauthorized. An expired offer or a token past the
   * managed rotation age is refused ({@link describeRefusal} says why). The
   * first use of an offer claims it, written at once (one write per device);
   * later uses stamp last-seen in memory only.
   */
  authenticate(token: string): AuthenticatedPairingToken | null {
    const normalized = token.trim();
    if (!normalized.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(normalized);
    // The authority record answers first: revoked there is refused here,
    // whatever this file says; an unreadable record authenticates nothing.
    const view = this.authority ? this.authority.view() : null;
    if (this.authority && !view) return null;
    if (view?.deviceTokenRevoked(hash)) return null;
    const localReadable = this.refreshIfChanged();
    let record = localReadable ? this.index.get(hash) : undefined;
    if (!record) {
      // Paired on another machine of the group: the record says it is live.
      const entry = view?.deviceTokenByHash(hash);
      if (!entry) return null;
      // The managed rotation age holds on every machine of the group, not only the one that paired it.
      const rotation = this.#rotationRefusal(entry.public.name, recordIssuedAt(entry.public), Date.now());
      if (rotation) {
        if (!this.#rotationRefusalsLogged.has(entry.id)) {
          this.#rotationRefusalsLogged.add(entry.id);
          logger.warn('A paired device token past its rotation age was refused', { tokenId: entry.id, state: rotation.state, next: rotation.next[0] });
        }
        return null;
      }
      const extra = entry.public as Record<string, unknown>;
      return { id: entry.id, name: entry.public.name, principalId: pairingPrincipalId(entry.id),
        ...(entry.public.client === 'agent' ? { client: 'agent' as const } : {}),
        ...(entry.public.scopes !== null ? { scopes: Object.freeze([...entry.public.scopes]) } : {}),
        ...(extra['origin'] === 'owner-pairing' ? { ownerDevice: true as const } : {}) };
    }
    const now = Date.now();
    const refusal = this.refusalOf(record, now);
    if (refusal) {
      if (refusal.code === 'PAIRING_TOKEN_ROTATION_DUE' && !this.#rotationRefusalsLogged.has(record.id)) {
        this.#rotationRefusalsLogged.add(record.id);
        logger.warn('A paired device token past its rotation age was refused', { tokenId: record.id, state: refusal.state, next: refusal.next[0] });
      }
      return null;
    }
    if (record.offeredUntil !== undefined) {
      let superseded = false;
      let supersededId: string | undefined;
      try {
        // Adds a device (and at the cap may supersede the same node's older record),
        // so a failed claim that replaced nothing is re-verifiable like a mint.
        record = this.mutate(current => {
          superseded = false;
          const found = current.tokens.find(item => item.tokenHash === hash);
          if (!found || isExpiredOffer(found, now)) return { value: undefined, changed: false };
          // The cap is judged on the file as it is now, so two offers used at once cannot both pass it.
          const atCap = this.capAtClaim(found, current.tokens);
          if ('refused' in atCap) return { value: undefined, changed: false };
          const replaced = atCap.supersedes;
          if (replaced) {
            logger.info('Pairing at the device.nodes.maxPaired cap: a pairing code re-pairs an already paired node', {
              name: replaced.name, maxPaired: this.currentCap(),
            });
            current.tokens = current.tokens.filter(item => item.id !== replaced.id);
            if (found.mintedBy === replaced.id) found.mintedBy = undefined;
            // A device paired again keeps answering for what its old pairing minted.
            for (const item of current.tokens) if (item.mintedBy === replaced.id) item.mintedBy = found.id;
            superseded = true;
          }
          found.offeredUntil = undefined;
          found.attemptId = undefined;
          found.capExempt = undefined;
          found.lastSeenAt = now;
          if (replaced) supersededId = replaced.id;
          return { value: found, changed: true };
        }, true, () => !superseded);
        // The device is paired: it is on the authority record from now on, for
        // every machine of the group; a record it superseded is revoked there.
        if (record) this.#publishToRecord(record, supersededId);
      } catch (error) {
        // Unclaimed, the offer would expire under a device that is using it; refuse instead.
        logger.warn('Pairing token first use could not be recorded; the request is refused', { path: this.filePath, error: String(error) });
        return null;
      }
      if (!record) return null;
    } else {
      this.#stampLastSeen(record, now);
    }
    return { id: record.id, name: record.name, principalId: pairingPrincipalId(record.id), ...(record.client === 'agent' ? { client: 'agent' as const } : {}),
      ...(record.scopes !== undefined ? { scopes: Object.freeze([...record.scopes]) } : {}),
      ...(record.origin === 'owner-pairing' ? { ownerDevice: true as const } : {}) };
  }

  /** Every per-pairing token, redacted (name / created / last-seen), never the secret. */
  list(): PublicPairingToken[] {
    // Pick up a mint or revoke made by another process; an unreadable file keeps the last good view.
    this.refreshIfChanged();
    const view = this.authority?.view() ?? null;
    const local = this.snapshot.tokens.filter(t => t.offeredUntil === undefined && !(view?.deviceTokenRevoked(t.tokenHash) ?? false));
    const localIds = new Set(local.map((t) => t.id));
    // Devices paired on another machine of the group, live on the record.
    const elsewhere: PublicPairingToken[] = (view?.list('device-token') ?? [])
      .filter((entry) => !localIds.has(entry.id) && view!.deviceTokenByHash(entry.public.tokenHash) !== null)
      .map((entry) => {
        const extra = entry.public as Record<string, unknown>;
        return {
          id: entry.id, name: entry.public.name, createdAt: entry.public.createdAt,
          ...(typeof extra['mintedBy'] === 'string' ? { mintedBy: extra['mintedBy'] } : {}),
          ...(entry.public.client === 'agent' ? { client: 'agent' as const } : {}),
          ...(entry.public.scopes !== null ? { scopes: Object.freeze([...entry.public.scopes]) } : {}),
          origin: extra['origin'] === 'owner-pairing' ? 'owner-pairing' as const : 'automation' as const,
        };
      });
    return [...local.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      ...lastSeenField(t.lastSeenAt, this.#pendingLastSeen.get(t.id)),
      ...(t.mintedBy !== undefined ? { mintedBy: t.mintedBy } : {}),
      ...(t.client === 'agent' ? { client: 'agent' as const } : {}),
      ...(t.scopes !== undefined ? { scopes: Object.freeze([...t.scopes]) } : {}),
      origin: t.origin === 'owner-pairing' ? 'owner-pairing' as const : 'automation' as const,
    })), ...elsewhere];
  }

  /**
   * Rename a token's user-visible label. False when the id is unknown.
   * Resolves once the name is on the authority record too, so a device paired
   * on another machine is renamed when this answers; a failed write throws.
   */
  async rename(id: string, name: string): Promise<boolean> {
    const renamed = this.mutate(snapshot => {
      const record = snapshot.tokens.find(item => item.id === id);
      if (!record) return { value: false, changed: false };
      record.name = name.trim() || record.name;
      return { value: true, changed: true };
    });
    const entry = this.authority?.view()?.entry('device-token', id);
    if (entry && !entry.revoked && name.trim()) {
      // A rename does not move authority: work admitted under the device stays current.
      await this.authority!.write(() => ({ kind: 'update', key: `device-token:${id}`, patch: { name: name.trim() }, narrowsOrWidens: false, value: null }));
      return true;
    }
    return renamed;
  }

  /**
   * Revoke a device everywhere: here, and on the authority record, so every
   * machine of the group refuses it and a machine that was away refuses it
   * when it returns. Resolves once the revocation is durable here; `alsoRevoked`
   * names what it minted, which the record revokes with it.
   */
  async revokeEverywhere(id: string): Promise<{ readonly revoked: boolean; readonly alsoRevoked: readonly string[] }> {
    const local = this.revokeWithMinted(id);
    if (!this.authority) return local;
    const result = await this.authority.write((view) => {
      const entry = view.entry('device-token', id);
      if (!entry || entry.revoked) return { kind: 'none', value: false };
      return { kind: 'revoke', key: `device-token:${id}`, by: 'owner', reason: 'revoked by the owner', value: true };
    });
    const view = this.authority.view();
    // Devices it minted (a relay code or a push subscription revoked with it is not a device).
    const cascade = view ? view.descendants(`device-token:${id}`).filter((key) => key.startsWith('device-token:')).map((key) => key.slice('device-token:'.length)) : [];
    return { revoked: local.revoked || result.value, alsoRevoked: [...new Set([...local.alsoRevoked, ...cascade])] };
  }

  /** Write a newly paired device to the authority record; failures are logged, the device keeps working here. */
  #publishToRecord(record: StoredPairingToken, supersededId: string | undefined): void {
    const authority = this.authority;
    if (!authority) return;
    void authority.write((view) => {
      const changes: AuthorityChange<null>[] = [];
      if (!view.entry('device-token', record.id)) {
        changes.push({ kind: 'issue', value: null, entries: [{
          kind: 'device-token', id: record.id,
          parent: record.mintedBy !== undefined && view.entry('device-token', record.mintedBy) ? `device-token:${record.mintedBy}` : null,
          public: {
            name: record.name, tokenHash: record.tokenHash, createdAt: record.createdAt,
            client: record.client === 'agent' ? 'agent' : 'device', scopes: record.scopes ?? null, rotationIssuedAt: record.createdAt,
            ...(record.origin === 'owner-pairing' ? { origin: 'owner-pairing' } : {}),
            ...(record.mintedBy !== undefined ? { mintedBy: record.mintedBy } : {}),
          },
        }] });
      }
      if (supersededId !== undefined && view.entry('device-token', supersededId) && !view.entry('device-token', supersededId)!.revoked) {
        // What the old pairing minted moves to the new one first, in the same
        // write, so revoking the old pairing does not revoke them with it.
        const oldKey = `device-token:${supersededId}` as const;
        for (const child of view.list('device-token')) {
          if (child.parent === oldKey && child.id !== record.id && !view.isRevoked(`device-token:${child.id}`)) {
            changes.push({ kind: 'update', key: `device-token:${child.id}`, patch: {}, narrowsOrWidens: false, parent: `device-token:${record.id}`, value: null });
          }
        }
        changes.push({ kind: 'revoke', key: oldKey, by: 'owner', reason: 'paired again', value: null });
      }
      return changes.length === 0 ? { kind: 'none', value: null } : { kind: 'many', changes, value: null };
    }).catch((error: unknown) => logger.warn('A paired device could not be written to the authority record; it works on this machine only until it is', { tokenId: record.id, error: String(error) }));
  }

  /**
   * Revoke one pairing and, with it, every pairing minted by it (directly or
   * through another), in this file only. `alsoRevoked` names the minted ones,
   * so the caller can say what else stopped working. An owner's revoke is
   * {@link revokeEverywhere}: a device left on the authority record keeps
   * authenticating; this is its local half and the control plane's fallback.
   * A persistence failure throws instead of reporting success.
   */
  revokeWithMinted(id: string): { readonly revoked: boolean; readonly alsoRevoked: readonly string[] } {
    return this.mutate<{ readonly revoked: boolean; readonly alsoRevoked: readonly string[] }>(snapshot => {
      if (!snapshot.tokens.some(record => record.id === id)) return { value: { revoked: false, alsoRevoked: [] }, changed: false };
      const ids = withMintedDescendants(snapshot.tokens, id);
      snapshot.tokens = snapshot.tokens.filter(record => !ids.has(record.id));
      ids.delete(id);
      return { value: { revoked: true, alsoRevoked: [...ids] }, changed: true };
    });
  }

  /** Whether the legacy single shared token has been revoked here. */
  isLegacyRevoked(): boolean {
    this.refreshIfChanged();
    return this.snapshot.legacyRevoked === true;
  }

  /**
   * Revoke the shared operator token; report only persisted success. Every
   * copy handed out stops signing in, and each revoke ends the value in use:
   * once the token was revoked, revoking again replaces the replacement, so a
   * copy of it taken off this machine stops signing in too. In the serving
   * daemon (a bound {@link SharedTokenCustody}) the token is replaced in the
   * same step: the new value is recorded here, written to the daemon home
   * where this machine's apps read it, and served from then on, so those apps
   * stay signed in. Without a bound daemon only the revocation is recorded
   * (the current replacement is forgotten), and the daemon writes a new
   * replacement when it next reads this store.
   *
   * The owner's own machine's native identity and its grants end with the old
   * value; the next native use after the replacement makes a new one.
   *
   * @throws {SharedTokenNotReplaceableError} when the daemon serves a value it
   *   cannot replace (one set by the process environment); nothing is revoked.
   */
  revokeLegacyShared(): void {
    const custody = this.#sharedCustody;
    const served = custody?.current() ?? null;
    if (custody && served !== null) {
      const refusal = custody.replacementRefusal();
      if (refusal !== null) throw new SharedTokenNotReplaceableError(refusal);
      this.#replaceSharedToken(custody);
      return;
    }
    this.mutate(snapshot => {
      const changed = snapshot.legacyRevoked !== true || snapshot.localOwner !== undefined || snapshot.localSharedHash !== undefined;
      snapshot.legacyRevoked = true;
      delete snapshot.localOwner;
      // The replacement in use ends too; the serving daemon writes a new one when it reads this.
      delete snapshot.localSharedHash;
      return { value: undefined, changed };
    });
  }

  /**
   * Bind the serving daemon's shared token (see {@link SharedTokenCustody}). A
   * revocation recorded without a replacement, by another process or before
   * replacement existed, is completed now and whenever this store reads one.
   * Returns the unbind.
   */
  bindSharedTokenCustody(custody: SharedTokenCustody): () => void {
    this.#sharedCustody = custody;
    // Deferred: the listener runs inside a write that still holds the owner lock.
    const stop = this.onRevoked(principalIds => {
      if (principalIds.includes('shared-token')) queueMicrotask(() => this.#completeSharedRevocation());
    });
    this.#completeSharedRevocation();
    return () => {
      stop();
      if (this.#sharedCustody === custody) this.#sharedCustody = undefined;
    };
  }

  /** Replace the served value when this store refuses it; a failure is logged and retried at the next read of a revocation. */
  #completeSharedRevocation(): void {
    const custody = this.#sharedCustody;
    const served = custody?.current() ?? null;
    if (!custody || served === null || !this.refusesSharedToken(served)) return;
    const refusal = custody.replacementRefusal();
    if (refusal !== null) {
      logger.warn('The shared operator token was revoked and the daemon cannot replace the value it serves; it no longer signs in', { reason: refusal });
      return;
    }
    try {
      this.#replaceSharedToken(custody);
    } catch (error) {
      logger.error('The revoked shared operator token could not be replaced; apps on this machine are refused until the daemon restarts', {
        path: this.filePath, error: String(error),
      });
    }
  }

  /** Record the revocation with the new value's hash, then let the custody write and serve it. */
  #replaceSharedToken(custody: SharedTokenCustody): void {
    custody.replace(token => {
      const replacement = hashToken(token);
      this.mutate(snapshot => {
        snapshot.legacyRevoked = true;
        snapshot.localSharedHash = replacement;
        delete snapshot.localOwner;
        return { value: undefined, changed: true };
      });
    });
  }
}
