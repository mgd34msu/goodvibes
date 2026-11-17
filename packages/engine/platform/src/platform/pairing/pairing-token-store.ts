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
 * The legacy single shared token keeps working (authenticated elsewhere) until
 * it is revoked here via `revokeLegacyShared()`; a client on the shared token
 * calls `mintForMigration()` once to move to its own per-device token.
 *
 * The owner's own machine needs no pairing: its apps hold the shared token,
 * and the transport, having seen that token arrive from the daemon's own
 * machine, asks for the local native owner (`ensureLocalNativeOwner`). That
 * is one stable record, made once, which native work, the work ledger and
 * continuation grants are bound to the way they are bound to a pairing. It
 * goes when the legacy shared token is revoked.
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
 * per device). After that, last-seen is stamped in memory and written with the
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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AtomicWriteDurabilityError, confirmFileDurable, readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { SettingsAuthorityUnavailableError, runSynchronousSettingsOperation } from '../security/settings-authority.js';
import { NativeContinuationOwner, nativeContinuationParents, type NativeContinuationParents } from './native-continuation-owner.js';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes-jev/judgment/decisions';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';
import { describeOwnerLock, reclaimDeadOwnerLock, recordOwnerLockHolder, removeOwnerLockDirectory, waitWhileLockIsBeingTaken } from '../config/durable-policy-epoch.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { matchesSharedToken, type CredentialRefusal } from '../security/http-auth.js';

const TOKEN_PREFIX = 'gvp_';
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
/** The principal the owner's own machine authenticates as: the one its operator token already is. */
export const LOCAL_OWNER_PRINCIPAL = 'shared-token';
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
  /** Once true, the legacy single shared token no longer authenticates. */
  legacyRevoked?: boolean | undefined;
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
}

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
}

/** The pairing or local owner record a continuation grant names, while it is live. */
function custodianOf(snapshot: PairingTokenSnapshot, id: string): NativeCustodian | undefined {
  return snapshot.tokens.find(item => item.id === id)
    ?? (snapshot.localOwner?.id === id && snapshot.legacyRevoked !== true ? snapshot.localOwner : undefined);
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

/** The `pairing:<id>` principal id a pairing-token request authenticates as. */
export function pairingPrincipalId(tokenId: string): string {
  return `pairing:${tokenId}`;
}

/** The pairing id behind a `pairing:<id>` principal, or undefined for any other principal. */
export function pairingTokenIdOfPrincipal(principalId: string | undefined): string | undefined {
  return principalId?.startsWith('pairing:') ? principalId.slice('pairing:'.length) : undefined;
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
  if (before.legacyRevoked !== true && after.legacyRevoked === true) revoked.push('shared-token');
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

  constructor(filePath: string, options: PairingTokenManagerOptions = {}) {
    this.filePath = filePath;
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
      // A missing file holds no pairings; a legacy revocation already seen stays revoked.
      this.publish(snapshot ?? { tokens: [], ...(this.snapshot.legacyRevoked === true ? { legacyRevoked: true } : {}) });
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
    if (record.offeredUntil !== undefined) return null;
    let limit: number | null = null;
    try { limit = this.#rotationLimit?.() ?? null; } catch { limit = null; }
    if (limit === null || !Number.isFinite(limit) || limit <= 0 || now - record.createdAt <= limit) return null;
    const ageDays = Math.floor((now - record.createdAt) / DAY_MS);
    return {
      code: 'PAIRING_TOKEN_ROTATION_DUE',
      state: `the token of "${record.name}" is ${ageDays} days old and managed token rotation (security.tokenAudit.managed) allows ${Math.floor(limit / DAY_MS)} days`,
      reason: 'This device token is past its rotation age and no longer authenticates',
      next: ["Pair this device again from the owner's machine to get a new token, then revoke the old one"],
    };
  }

  /**
   * Why a token this store knows does not authenticate (an offer that expired
   * unused, or a device token past the managed rotation age), or null. For the
   * refusal a caller answers after authentication failed; never grants access.
   */
  describeRefusal(token: string): CredentialRefusal | null {
    const normalized = token.trim();
    if (!normalized.startsWith(TOKEN_PREFIX)) return null;
    const record = this.index.get(hashToken(normalized));
    return record ? this.refusalOf(record, Date.now()) : null;
  }

  /**
   * Why a presented credential is refused, when this store is what refuses it:
   * a device token it knows (see {@link describeRefusal}), or the shared
   * operator token after it was revoked here. `sharedToken` is the daemon's own
   * copy, null when it has none. Asked only on the 401 path; never grants access.
   */
  describePresentedRefusal(token: string, sharedToken: string | null): CredentialRefusal | null {
    const device = this.describeRefusal(token);
    if (device) return device;
    const normalized = token.trim();
    if (!sharedToken || !normalized || !matchesSharedToken(normalized, sharedToken) || !this.isLegacyRevoked()) return null;
    return {
      code: 'SHARED_TOKEN_REVOKED',
      state: 'the shared operator token was revoked on this daemon and no longer signs in',
      reason: 'This request presented the shared operator token, which was revoked on this daemon.',
      next: ['On the daemon\'s machine, run /devices migrate-shared in the GoodVibes terminal to mint this device its own token, then use that token.'],
    };
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

  captureSettingsAuthority(input: { readonly kind: 'shared-token' }
    | { readonly kind: 'pairing-token'; readonly token: string }): SettingsPairingAuthority | null {
    if (input.kind === 'pairing-token' && !isPairingTokenShape(input.token)) return null;
    let lock: PairingOwnerLock | undefined;
    try {
      lock = this.acquireOwnerLock();
      const snapshot = this.readSettingsSnapshot();
      let record: SettingsPairingAuthorityRecord;
      if (input.kind === 'shared-token') {
        if (snapshot?.legacyRevoked === true || this.settingsObservedLegacyRevocation) return null;
        record = { kind: 'shared-token' };
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
          if (current?.legacyRevoked === true || this.settingsObservedLegacyRevocation) throw new SettingsAuthorityUnavailableError();
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
      return owner && this.snapshot.legacyRevoked !== true ? nativeIdentityOf(owner) : null;
    }
    const normalized = credential.trim();
    if (!normalized.startsWith(TOKEN_PREFIX) || !this.#nativeSnapshotCurrent() || this.index.size === 0) return null;
    const live = this.index.get(hashToken(normalized));
    if (!live || this.refusalOf(live, Date.now())) return null;
    return nativeIdentityOf(live);
  }

  /**
   * The owner's own machine's native identity, made the first time one of its
   * apps uses native work (one durable write, once) and read after that. Null
   * once the legacy shared token is revoked, or when the record cannot be
   * written; the refusal the caller gives then names pairing as the way on.
   */
  ensureLocalNativeOwner(): AuthenticatedNativePairingToken | null {
    const current = this.authenticateNative(LOCAL_OWNER_CREDENTIAL);
    if (current || this.nativePersistenceFailed || this.snapshot.legacyRevoked === true) return current;
    try {
      const made = this.mutate(snapshot => {
        if (snapshot.legacyRevoked === true) return { value: false, changed: false };
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
   * - At the cap, a node that is ALREADY paired (same name) is never refused: it
   *   supersedes its own record, so re-pairing a phone that is already in the
   *   list keeps working and the count does not creep past the cap. Nobody
   *   else's pairing is touched.
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
    return this.mutate((snapshot) => {
      replaced = false;
      if (input.mintedBy !== undefined && !snapshot.tokens.some(record => record.id === input.mintedBy)) {
        throw new PairingMinterRevokedError();
      }
      let replacedId: string | undefined;
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
        logger.info('Pairing at the device.nodes.maxPaired cap: re-pairing an already paired node', {
          name: existing.name, maxPaired: cap, pairedCount: paired.length,
        });
        snapshot.tokens = snapshot.tokens.filter(record => record.id !== existing.id);
        replacedId = existing.id;
        replaced = true;
      }
      const token = generateTokenValue();
      const record: StoredPairingToken = {
        id: `pair-${randomUUID()}`, name: input.name.trim() || 'Unnamed device',
        tokenHash: hashToken(token), createdAt: now, offeredUntil: now + PAIRING_OFFER_LIFETIME_MS,
        ...(input.mintedBy !== undefined && input.mintedBy !== replacedId ? { mintedBy: input.mintedBy } : {}),
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(input.client === 'agent' ? { client: 'agent' as const } : {}),
      };
      // A device paired again keeps answering for what its old pairing minted.
      if (replacedId !== undefined) for (const item of snapshot.tokens) if (item.mintedBy === replacedId) item.mintedBy = record.id;
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
    if (!this.refreshIfChanged() || this.index.size === 0) return null;
    const hash = hashToken(normalized);
    let record = this.index.get(hash);
    if (!record) return null;
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
      try {
        // Only adds a device, so a failed claim is re-verifiable like a mint.
        record = this.mutate(current => {
          const found = current.tokens.find(item => item.tokenHash === hash);
          if (!found || isExpiredOffer(found, now)) return { value: undefined, changed: false };
          found.offeredUntil = undefined;
          found.attemptId = undefined;
          found.lastSeenAt = now;
          return { value: found, changed: true };
        }, true, () => true);
      } catch (error) {
        // Unclaimed, the offer would expire under a device that is using it; refuse instead.
        logger.warn('Pairing token first use could not be recorded; the request is refused', { path: this.filePath, error: String(error) });
        return null;
      }
      if (!record) return null;
    } else {
      this.#stampLastSeen(record, now);
    }
    return { id: record.id, name: record.name, principalId: pairingPrincipalId(record.id), ...(record.client === 'agent' ? { client: 'agent' as const } : {}) };
  }

  /** Every per-pairing token, redacted (name / created / last-seen), never the secret. */
  list(): PublicPairingToken[] {
    // Pick up a mint or revoke made by another process; an unreadable file keeps the last good view.
    this.refreshIfChanged();
    return this.snapshot.tokens.filter(t => t.offeredUntil === undefined).map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      ...lastSeenField(t.lastSeenAt, this.#pendingLastSeen.get(t.id)),
      ...(t.mintedBy !== undefined ? { mintedBy: t.mintedBy } : {}),
      ...(t.client === 'agent' ? { client: 'agent' as const } : {}),
    }));
  }

  /** Rename a token's user-visible label. False when the id is unknown. */
  rename(id: string, name: string): boolean {
    return this.mutate(snapshot => {
      const record = snapshot.tokens.find(item => item.id === id);
      if (!record) return { value: false, changed: false };
      record.name = name.trim() || record.name;
      return { value: true, changed: true };
    });
  }

  /** Revoke one pairing and every pairing it minted. A persistence failure throws instead of reporting success. */
  revoke(id: string): boolean {
    return this.revokeWithMinted(id).revoked;
  }

  /**
   * Revoke one pairing and, with it, every pairing minted by it (directly or
   * through another). `alsoRevoked` names the minted ones, so the caller can
   * say what else stopped working.
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
   * Revoke the legacy single shared token; report only persisted success. The
   * owner's own machine loses its native authority with it (its grants go in
   * the same write): its apps then pair like any other device.
   */
  revokeLegacyShared(): void {
    this.mutate(snapshot => {
      const changed = snapshot.legacyRevoked !== true || snapshot.localOwner !== undefined;
      snapshot.legacyRevoked = true;
      delete snapshot.localOwner;
      return { value: undefined, changed };
    });
  }
}
