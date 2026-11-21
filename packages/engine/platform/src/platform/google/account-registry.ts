/**
 * Durable record of every account the agent created in the owner's name.
 *
 * Autonomous signup without this file is invisible sprawl: accounts nobody can
 * enumerate, audit, or revoke. Everything the agent signs up for lands here, at creation
 * time, before the credential is even stored.
 *
 * What is NOT here: the credential. Only `credentialSecretKey`, the NAME of the entry in
 * the secret store that holds it. This registry is a plain JSON file; a password in it
 * would be a password on disk in the clear. `record()` rejects secret-looking text in
 * every field, and there is a test asserting the credential value never reaches the file.
 *
 * Follows the platform registry conventions, caller-supplied store path, versioned
 * store file, defensive parse, atomic write, with one deliberate divergence noted at
 * `readStore`.
 *
 * The store path and the secret-shaped-text predicate both arrive from the caller.
 * The path, because where a product keeps its state is the product's decision. The
 * predicate, because "what looks like a credential" is a policy each surface already
 * owns, and quietly shipping a second copy of those patterns here would let the two
 * drift, a value this registry accepted would then be one the surface's own memory
 * guard rejected, or worse, the other way round.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withProcessLockSync } from '../utils/process-lock.js';
import { normalizeDomain, normalizeEmailAddress } from './signup-address.js';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface AgentAccountRecord {
  readonly id: string;
  /** Registered domain of the service, normalized. */
  readonly serviceDomain: string;
  /** The page the account was created at. */
  readonly serviceUrl: string;
  /** The per-signup alias minted by `signup-address.ts`. */
  readonly aliasAddress: string;
  readonly createdAt: string;
  readonly purpose: string;
  /**
   * The NAME of the secret-store entry holding the credential. Never the credential.
   * Revocation starts here: look up this key, rotate or delete it.
   */
  readonly credentialSecretKey: string;
}

export interface AgentAccountCreateInput {
  readonly serviceDomain: string;
  readonly serviceUrl: string;
  readonly aliasAddress: string;
  readonly purpose: string;
  readonly credentialSecretKey: string;
  readonly now?: Date;
}

export interface AgentAccountSweepInput {
  readonly now?: Date;
  /**
   * Keys the secret store actually holds. When supplied, records pointing at a key that
   * no longer exists are orphans and get dropped, the credential is already gone.
   */
  readonly knownSecretKeys?: readonly string[];
  /** When supplied, records older than this are dropped. */
  readonly maxAgeDays?: number;
}

export interface AgentAccountSweepResult {
  readonly removed: readonly AgentAccountRecord[];
  readonly remaining: number;
}

export interface AgentAccountSnapshot {
  readonly path: string;
  readonly accounts: readonly AgentAccountRecord[];
  /** Records dropped by the last read because they failed validation. */
  readonly droppedOnRead: number;
  /** Set when the file exists but could not be read or understood; `accounts` is then empty, not the true list. */
  readonly unreadable?: string;
}

export interface AccountStoreFile {
  readonly version: 1;
  readonly accounts: readonly AgentAccountRecord[];
}

/** Additional owner restriction, never an admission grant. */
export interface AgentAccountWriteGuard {
  readonly assertCurrent: () => void;
}

export interface ParsedStore {
  readonly store: AccountStoreFile;
  readonly dropped: number;
  /** Why an existing file could not be read; absent for a missing or readable file. */
  readonly unreadable?: string;
}

// ──────────────────────────────────────────────────────────────────
// Constants and helpers
// ──────────────────────────────────────────────────────────────────

const STORE_VERSION = 1;
/** Bound on persisted records. Sprawl has a ceiling, and hitting it is loud. */
export const MAX_ACCOUNT_RECORDS = 500;
/** A secret-store key name: an identifier, never a value. */
const SECRET_KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'account';
}

function isValidTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * "Does this text look like a credential rather than a name?"
 *
 * Supplied by the caller; see the module header for why it is not defined here.
 */
export type SecretLikeTextPredicate = (text: string) => boolean;

/**
 * Validate the format's structural fields. Content safety is deliberately
 * separate so both synchronous and asynchronous readers use these same rules.
 */
export function parseAccountFields(value: unknown): AgentAccountRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim().toLowerCase();
  const serviceDomain = normalizeDomain(readString(value.serviceDomain));
  const serviceUrl = readString(value.serviceUrl).trim();
  const aliasAddress = normalizeEmailAddress(readString(value.aliasAddress));
  const purpose = readString(value.purpose).trim();
  const credentialSecretKey = readString(value.credentialSecretKey).trim();
  const createdAt = readString(value.createdAt).trim();

  if (!ID_PATTERN.test(id)) return null;
  if (!serviceDomain.includes('.')) return null;
  if (!isHttpUrl(serviceUrl)) return null;
  if (!aliasAddress.includes('@')) return null;
  if (!purpose) return null;
  if (!SECRET_KEY_NAME_PATTERN.test(credentialSecretKey)) return null;
  if (!isValidTimestamp(createdAt)) return null;
  return { id, serviceDomain, serviceUrl, aliasAddress, createdAt, purpose, credentialSecretKey };
}

/** The four free-text fields the account content policy screens. */
export function accountSafetyFields(account: Pick<AgentAccountRecord, 'serviceUrl' | 'purpose' | 'credentialSecretKey' | 'aliasAddress'>): readonly string[] {
  return [account.serviceUrl, account.purpose, account.credentialSecretKey, account.aliasAddress];
}

function parseAccount(value: unknown, containsSecretLikeText: SecretLikeTextPredicate): AgentAccountRecord | null {
  const account = parseAccountFields(value);
  if (account === null || accountSafetyFields(account).some((text) => containsSecretLikeText(text))) return null;
  return account;
}

function parseStore(raw: string, containsSecretLikeText: SecretLikeTextPredicate): ParsedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0, unreadable: 'the file is not valid JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
    return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0, unreadable: 'the file is not an account store' };
  }
  const entries = parsed.accounts;
  const accounts = entries
    .map((entry) => parseAccount(entry, containsSecretLikeText))
    .filter((entry): entry is AgentAccountRecord => entry !== null);
  return boundAccountRecords(accounts, entries.length);
}

/** Shape, id deduplication and the format's own count cap, shared by both readers. */
export function boundAccountRecords(accounts: readonly AgentAccountRecord[], entryCount: number): ParsedStore {
  const deduped: AgentAccountRecord[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    deduped.push(account);
  }
  // Bound defensively: a tampered or runaway file is trimmed to the newest MAX.
  const sorted = [...deduped].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bounded = sorted.slice(Math.max(0, sorted.length - MAX_ACCOUNT_RECORDS));
  return {
    store: { version: STORE_VERSION, accounts: bounded },
    dropped: entryCount - bounded.length,
  };
}

export function formatStore(store: AccountStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * The path segments below a surface's own storage root that this registry occupies.
 *
 * Exported so a product composes its own root with these rather than inventing a
 * second layout: `resolveUserPath(<surface root>, ...ACCOUNT_REGISTRY_PATH_SEGMENTS)`.
 */
export const ACCOUNT_REGISTRY_PATH_SEGMENTS: readonly string[] = ['signup', 'accounts.json'];

// ──────────────────────────────────────────────────────────────────
// Base address for alias minting
// ──────────────────────────────────────────────────────────────────

/**
 * Supplies the owner's real delivery address when no mail account is configured.
 *
 * A registered reader rather than an import of `platform/owner-profile`: this
 * module is reachable from surfaces that never load a profile, and it has to keep
 * working there unchanged. With nothing registered, {@link resolveSignupBaseAddress}
 * returns exactly what its caller passed in.
 */
export type SignupBaseAddressSource = () => string | undefined;

let signupBaseAddressFallback: SignupBaseAddressSource | null = null;

/** Register (or clear, with `null`) the profile-backed base-address fallback. */
export function registerSignupBaseAddressFallback(source: SignupBaseAddressSource | null): void {
  signupBaseAddressFallback = source;
}

/**
 * The base address every minted alias resolves back to, "the owner's real
 * delivery address this alias resolves to", in `signup-address.ts`'s own words.
 *
 * A configured mail account always wins. The profile's `contact.email` fills the
 * gap, which is the point of wiring it: without it, an autonomous signup on a
 * machine with no mail account configured has nowhere to send the confirmation
 * and cannot proceed, even though the owner told the runtime their address
 * weeks ago.
 *
 * `signup-address.ts` is untouched by this. It is alias-minting machinery, not a
 * store of owner facts, and it stays a pure function of the base address it is
 * handed.
 *
 * Note what this deliberately does NOT feed: `security/owner-identity.ts`'s
 * `resolveOwnerAddresses()`. That set gates the one exemption to the
 * content-taint rule and reads configuration only, on purpose, see
 * `owner-profile/consumers.ts` for the reasoning.
 */
export function resolveSignupBaseAddress(configuredMailAddress?: string | undefined): string | undefined {
  const configured = configuredMailAddress?.trim() ?? '';
  if (configured.length > 0) return configured;
  const fromProfile = signupBaseAddressFallback?.()?.trim() ?? '';
  return fromProfile.length > 0 ? normalizeEmailAddress(fromProfile) : undefined;
}

export interface AgentAccountRegistryOptions {
  /** Absolute path to the registry's JSON store. */
  readonly storePath: string;
  /** See `SecretLikeTextPredicate` and the module header. */
  readonly containsSecretLikeText: SecretLikeTextPredicate;
}

type AccountFields = Omit<AgentAccountRecord, 'id' | 'createdAt'>;

export function validateAccountCreateFields(input: AgentAccountCreateInput): AccountFields {
  const serviceDomain = normalizeDomain(input.serviceDomain);
  const serviceUrl = input.serviceUrl.trim();
  const aliasAddress = normalizeEmailAddress(input.aliasAddress);
  const purpose = input.purpose.trim();
  const credentialSecretKey = input.credentialSecretKey.trim();

  if (!serviceDomain.includes('.')) throw new Error('An account record requires the service domain the account was created at.');
  if (!isHttpUrl(serviceUrl)) throw new Error('An account record requires the http(s) URL the account was created at.');
  if (!aliasAddress.includes('@')) throw new Error('An account record requires the per-signup alias address.');
  if (!purpose) throw new Error('An account record requires a stated purpose.');
  if (!SECRET_KEY_NAME_PATTERN.test(credentialSecretKey)) {
    throw new Error('credentialSecretKey must be a secret-store key NAME (letters, digits, . _ : / -), never the credential itself.');
  }
  return { serviceDomain, serviceUrl, aliasAddress, purpose, credentialSecretKey };
}

export function buildAccountRecord(fields: AccountFields, input: AgentAccountCreateInput, accounts: readonly AgentAccountRecord[]): AgentAccountRecord {
  const { serviceDomain, serviceUrl, aliasAddress, purpose, credentialSecretKey } = fields;
  if (accounts.length >= MAX_ACCOUNT_RECORDS) {
    throw new Error(
      `The account registry is at its ${MAX_ACCOUNT_RECORDS}-record limit. Sweep or forget stale accounts before creating another; records are never silently discarded.`,
    );
  }
  const account: AgentAccountRecord = {
    id: nextAccountId(serviceDomain, accounts),
    serviceDomain,
    serviceUrl,
    aliasAddress,
    createdAt: (input.now ?? new Date()).toISOString(),
    purpose,
    credentialSecretKey,
  };
  return account;
}

export function sweepAccountRecords(accounts: readonly AgentAccountRecord[], input: AgentAccountSweepInput): { kept: readonly AgentAccountRecord[]; removed: readonly AgentAccountRecord[] } {
  const now = input.now ?? new Date();
  const knownKeys = input.knownSecretKeys ? new Set(input.knownSecretKeys) : null;
  const cutoff = input.maxAgeDays === undefined ? null : now.getTime() - input.maxAgeDays * 86_400_000;

  const kept: AgentAccountRecord[] = [];
  const removed: AgentAccountRecord[] = [];
  for (const account of accounts) {
    const orphaned = knownKeys !== null && !knownKeys.has(account.credentialSecretKey);
    const expired = cutoff !== null && Date.parse(account.createdAt) < cutoff;
    if (orphaned || expired) removed.push(account);
    else kept.push(account);
  }
  return { kept, removed };
}

function nextAccountId(serviceDomain: string, accounts: readonly AgentAccountRecord[]): string {
  const base = slugify(serviceDomain);
  const ids = new Set(accounts.map((account) => account.id));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate an account id for ${serviceDomain}.`);
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

export class AgentAccountRegistry {
  private readonly storePath: string;
  private readonly containsSecretLikeText: SecretLikeTextPredicate;

  public constructor(options: AgentAccountRegistryOptions) {
    this.storePath = options.storePath;
    this.containsSecretLikeText = options.containsSecretLikeText;
  }

  public snapshot(): AgentAccountSnapshot {
    const parsed = this.readStore();
    const accounts = [...parsed.store.accounts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { path: this.storePath, accounts, droppedOnRead: parsed.dropped, ...(parsed.unreadable === undefined ? {} : { unreadable: parsed.unreadable }) };
  }

  public list(): readonly AgentAccountRecord[] {
    return this.snapshot().accounts;
  }

  /** The registration owner captures this path before reading or admitting an action. */
  public getStorePath(): string { return this.storePath; }

  public get(id: string): AgentAccountRecord | null {
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((account) => account.id === lookup) ?? null;
  }

  /** Record an account the agent just created. Call this before storing the credential. */
  public record(input: AgentAccountCreateInput, guard?: AgentAccountWriteGuard): AgentAccountRecord {
    return this.mutate((parsed) => {
      const fields = validateAccountCreateFields(input);
      if (accountSafetyFields(fields).some((text) => this.containsSecretLikeText(text))) {
        throw new Error('The account registry cannot store secret-looking values. Store the secret in the secret store and record only its key name.');
      }
      const account = buildAccountRecord(fields, input, parsed.store.accounts);
      return { value: account, accounts: [...parsed.store.accounts, account] };
    }, guard);
  }

  public forget(id: string, guard?: AgentAccountWriteGuard): AgentAccountRecord {
    const lookup = id.trim().toLowerCase();
    return this.mutate((parsed) => {
      const existing = parsed.store.accounts.find((account) => account.id === lookup);
      if (!existing) throw new Error(`Unknown account record ${id}`);
      return { value: existing, accounts: parsed.store.accounts.filter((account) => account.id !== existing.id) };
    }, guard);
  }

  /**
   * Reap expired and orphaned entries and compact the file.
   *
   * With no arguments this still rewrites the store from the validated read, which drops
   * malformed and duplicate entries that a hand edit may have introduced.
   */
  public sweep(input: AgentAccountSweepInput = {}, guard?: AgentAccountWriteGuard): AgentAccountSweepResult {
    return this.mutate((parsed) => {
      const { kept, removed } = sweepAccountRecords(parsed.store.accounts, input);
      return { value: { removed, remaining: kept.length }, accounts: kept };
    }, guard);
  }

  /**
   * Divergence from `calendar-registry.ts`: that registry throws when the store cannot be
   * read. Reading must not: a corrupt accounts file would otherwise take down every
   * caller that just wants to enumerate what the agent signed up for, which is exactly
   * when enumeration matters most. An unreadable file reads as empty and says so in
   * `unreadable`; malformed records are dropped individually and counted in `droppedOnRead`.
   * Writing is the opposite: a view that is empty only because the file could not be read
   * must never be written back, so {@link mutate} refuses.
   */
  private readStore(): ParsedStore {
    // One open, refusing a link in the store's place, and the read goes through that descriptor.
    let fd: number;
    try {
      fd = openSync(this.storePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0 };
      return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0, unreadable: 'the file could not be read' };
    }
    try {
      return parseStore(readFileSync(fd, 'utf-8'), this.containsSecretLikeText);
    } catch {
      return { store: { version: STORE_VERSION, accounts: [] }, dropped: 0, unreadable: 'the file could not be read' };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * One read-modify-write under the store's kernel-released writer lock. A
   * writer in another process is waited for up to a second; past that the call
   * fails with a retryable `ProcessLockBusyError` and nothing is written. A
   * holder that dies releases the lock with its process. An unreadable file is
   * never replaced.
   */
  private mutate<T>(
    change: (parsed: ParsedStore) => { readonly value: T; readonly accounts: readonly AgentAccountRecord[] },
    guard?: AgentAccountWriteGuard,
  ): T {
    mkdirSync(dirname(this.storePath), { recursive: true });
    return withProcessLockSync(`${this.storePath}.writer.sqlite`, () => {
      const parsed = this.readStore();
      if (parsed.unreadable !== undefined) {
        throw new Error(`The account registry at ${this.storePath} was not changed because ${parsed.unreadable}. Repair or move the file, then retry.`);
      }
      const { value, accounts } = change(parsed);
      this.writeStore({ ...parsed.store, accounts }, guard, parsed.dropped > 0);
      return value;
    }, { waitMs: 1_000 });
  }

  private writeStore(store: AccountStoreFile, guard?: AgentAccountWriteGuard, keepPreviousCopy = false): void {
    writeAccountStoreFile(this.storePath, store, { ...(guard === undefined ? {} : { guard }), keepPreviousCopy });
  }
}

/**
 * Replace the account store file with `store`: a private temporary file, then a
 * rename over the store. With `keepPreviousCopy` (the read skipped entries, a
 * stricter content check or a hand edit, that this rewrite would lose) the file
 * as it was is first copied beside the store as `.dropped-<ms>.bak`. Both
 * registries write through this, so they lose nothing differently. The caller
 * holds the store's writer lock.
 */
export function writeAccountStoreFile(
  storePath: string,
  store: AccountStoreFile,
  options: { readonly guard?: AgentAccountWriteGuard; readonly keepPreviousCopy: boolean },
): void {
  const { guard, keepPreviousCopy } = options;
  const content = formatStore(store);
  guard?.assertCurrent();
  mkdirSync(dirname(storePath), { recursive: true });
  if (keepPreviousCopy && existsSync(storePath)) {
    copyFileSync(storePath, `${storePath}.dropped-${Date.now()}.bak`);
  }
  const tmpPath = `${storePath}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    guard?.assertCurrent();
    writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    ownsTemporary = true;
    guard?.assertCurrent();
    renameSync(tmpPath, storePath);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) { try { unlinkSync(tmpPath); } catch { /* Clean up only this operation's private temporary file. */ } }
  }
}
