// relay/step-up-service.ts
//
// The daemon-side step-up ceremony: it owns the registered-credential store
// (persisted through the SecretsManager) and the short-lived, single-use
// challenge store (in-memory), and it produces the real StepUpAssertionVerifier
// that relay/daemon-wiring.ts installs. One instance is shared between the
// operator verbs (routes/stepup.ts: register a credential, mint a challenge) and
// the relay dispatch gate, so a challenge minted by a verb is the same object
// the gate later consumes.
//
// Persistence shape (SecretsManager key `relay.stepup.state`): the deployment
// policy (rpId, allowed origins, user-verification requirement) plus the array
// of registered credentials. The policy travels WITH the credentials because a
// self-hosted deployment establishes it at registration time; there is no
// separate config surface to keep in sync.
//
// The authority record (cluster/authority-record.ts) answers which passkeys
// are current: every registration is a `passkey` entry there (public key and
// relying-party policy; the public key is not a secret) and every removal a
// terminal revocation. A passkey registered through one machine of a group
// confirms relayed actions on every machine, and one removed on any machine
// (a lost phone) confirms nothing anywhere, including on a machine that was
// asleep or restarted. The signature counter stays per machine, in the state
// above: each machine refuses a counter that goes backwards from what it saw.

import { revealOrNull, type Secret } from '../security/secret.js';
import { fromBase64Url, randomBytes, toBase64Url } from '@goodvibes/engine/transport-core/relay';
import {
  coseP256ToRawPoint,
  verifyStepUpAssertion,
  type StepUpAssertionEnvelope,
  type StepUpVerifyFailure,
  type StoredStepUpCredential,
} from './step-up-webauthn.js';
import type { StepUpAssertionVerifier, StepUpRefusalReason, StepUpRequestContext, StepUpVerification } from './step-up-policy.js';
import { AuthorityRecordUnavailableError, type AuthorityChange, type AuthorityRecordFile } from '../cluster/authority-record-file.js';
import type { AuthorityEntry, AuthorityKey, AuthorityView } from '../cluster/authority-record.js';
import { randomUUID } from 'node:crypto';
import { defineFormat, renderChecked } from '../utils/format-codec.js';

/** User-verification requirement for the ceremony. Default `required`. */
export type UserVerificationRequirement = 'required' | 'preferred' | 'discouraged';

const STEP_UP_STATE_KEY = 'relay.stepup.state';
const DEFAULT_CHALLENGE_TTL_MS = 120_000;
const MIN_CHALLENGE_TTL_MS = 5_000;
const MAX_CHALLENGE_TTL_MS = 300_000;
const CHALLENGE_BYTES = 32;
/** Challenges that may be live at once; a minted challenge holds memory until it expires. */
export const MAX_LIVE_STEP_UP_CHALLENGES = 256;
/** Challenges one caller may keep live, so a single caller cannot fill the whole store and lock out the others. */
export const MAX_LIVE_STEP_UP_CHALLENGES_PER_PRINCIPAL = 16;

/** The challenge store is full of unexpired challenges; minting another is refused until one is used or expires. */
export class StepUpChallengeLimitError extends Error {
  constructor(limit: number = MAX_LIVE_STEP_UP_CHALLENGES) {
    super(`Too many step-up challenges are waiting (limit ${limit}); use one or wait for one to expire, then mint again`);
    this.name = 'StepUpChallengeLimitError';
  }
}

/** A credential registration the caller got wrong; anything else thrown while registering is an internal failure. */
export class StepUpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpValidationError';
  }
}

interface StepUpState {
  rpId: string;
  origins: string[];
  userVerification: UserVerificationRequirement;
  credentials: StoredStepUpCredential[];
}

/** Minimal secret custody surface (the SecretsManager satisfies it). */
export interface StepUpSecretStore {
  get(key: string): Promise<Secret | null>;
  set(key: string, value: string): Promise<void>;
}

export interface StepUpServiceOptions {
  readonly secrets: StepUpSecretStore;
  /** Clock injection for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /** Random-challenge source injection for tests. Default relay `randomBytes`. */
  readonly randomChallenge?: () => Uint8Array<ArrayBuffer>;
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  /** The authority record passkeys live on; absent, the stored state answers alone. */
  readonly authority?: AuthorityRecordFile | undefined;
}

const passkeyKey = (id: string): AuthorityKey => `passkey:${id}`;

/** The passkey entries for one credential id on the record, live ones first. */
function passkeyEntries(view: AuthorityView, credentialId: string): { live: AuthorityEntry<'passkey'>[]; revoked: boolean } {
  const all = view.list('passkey').filter((entry) => entry.public.credentialId === credentialId);
  const live = all.filter((entry) => !view.isRevoked(passkeyKey(entry.id)));
  return { live, revoked: all.length > 0 && live.length === 0 };
}

/** Input to register a step-up credential (an admin/local-only ceremony verb). */
export interface RegisterStepUpCredentialInput {
  readonly rpId: string;
  readonly origin: string | readonly string[];
  readonly credentialId: string;
  readonly publicKeyCose: string;
  readonly signCount?: number;
  readonly userVerification?: UserVerificationRequirement;
  readonly label?: string;
  /**
   * A registration made through a pairing hand-off names the pairing it was
   * offered to (`pairing:<id>`, the principal completing the hand-off): it is
   * accepted only when the daemon offered a passkey to that pairing
   * (`offerRegistration`) and the offer is unused and unexpired, and it uses
   * the offer up. Absent for the direct admin registration.
   */
  readonly offeredTo?: string | undefined;
}

/** How long a passkey offered in a pairing hand-off stays open: the pairing code's own 15 minutes, and time for the ceremony. */
export const PASSKEY_REGISTRATION_OFFER_MS = 30 * 60_000;

/** A public (no key material) summary of a registered credential. */
export interface StepUpCredentialSummary {
  readonly credentialId: string;
  readonly label?: string;
  readonly createdAt: number;
  readonly signCount: number;
}

/**
 * Input to mint a challenge. The assertion is accepted only for the request it
 * was minted for: the method, the path and the minting principal must match,
 * and so must the session or rendezvous when one is given. A challenge minted
 * without a method and path can be signed (a device self-test) but never
 * authorises a call.
 */
export interface MintStepUpChallengeInput {
  readonly rendezvousId?: string;
  readonly sessionId?: string;
  /** HTTP method of the call the assertion is for. */
  readonly method?: string;
  /** Request path of the call the assertion is for. */
  readonly path?: string;
  /** Freshness window in ms (clamped 5s–300s). Default 120s. */
  readonly ttlMs?: number;
  /** Who is minting; each principal has its own live-challenge cap. Callers without one share a single cap. */
  readonly principalId?: string;
}

/** A minted challenge a surface passes to `navigator.credentials.get`. */
export interface MintedStepUpChallenge {
  readonly challengeId: string;
  /** base64url challenge bytes. */
  readonly challenge: string;
  readonly expiresAt: number;
}

interface LiveChallenge {
  readonly id: string;
  readonly challenge: string;
  readonly rendezvousId?: string;
  readonly sessionId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly principalId: string;
  readonly expiresAt: number;
  consumed: boolean;
}

/** Refusal reasons the verifier surfaces beyond the crypto failures. */
export type StepUpChallengeFailure = Exclude<StepUpRefusalReason, StepUpVerifyFailure>;

function normalizeOrigins(origin: string | readonly string[]): string[] {
  const list = Array.isArray(origin) ? origin : [origin];
  return [...new Set(list.map((o) => String(o).trim()).filter((o) => o.length > 0))];
}

/**
 * The step-up ceremony service. Constructed once at RuntimeServices assembly and
 * shared between the ceremony verbs and the relay gate's verifier.
 */
export class StepUpService {
  private readonly secrets: StepUpSecretStore;
  private readonly now: () => number;
  private readonly randomChallenge: () => Uint8Array<ArrayBuffer>;
  private readonly logger: StepUpServiceOptions['logger'];
  private readonly challenges = new Map<string, LiveChallenge>();
  /** Passkey registrations offered in a pairing hand-off: the pairing principal, and when the offer ends. One use each. */
  private readonly registrationOffers = new Map<string, number>();
  /**
   * Every read-modify-write of the stored state, and every verification (which
   * reads a credential and writes its advanced counter back), runs one at a
   * time. Without it a registration made while an assertion is being checked
   * is overwritten by that check's older copy, and two checks of one assertion
   * both pass.
   */
  private stateQueue: Promise<unknown> = Promise.resolve();
  /** Registered credentials as of the last read or write of the stored state; undefined before the first. */
  private knownCredentialCount: number | undefined;
  private readonly authority: AuthorityRecordFile | undefined;

  constructor(options: StepUpServiceOptions) {
    this.authority = options.authority;
    this.secrets = options.secrets;
    this.now = options.now ?? (() => Date.now());
    this.randomChallenge = options.randomChallenge ?? (() => randomBytes(CHALLENGE_BYTES));
    this.logger = options.logger;
  }

  /**
   * The stored state as the authority record has it: a credential revoked
   * there (removed on any machine of the group) is left out, and one
   * registered through another machine is added with its policy. An
   * unreadable record leaves no credential: nothing is confirmed on a guess.
   */
  private async loadState(): Promise<StepUpState> {
    const stored = parseState(revealOrNull(await this.secrets.get(STEP_UP_STATE_KEY), 'dispatch'));
    const state = this.withRecord(stored);
    this.knownCredentialCount = state.credentials.length;
    return state;
  }

  private withRecord(stored: StepUpState): StepUpState {
    const authority = this.authority;
    if (!authority) return stored;
    const view = authority.view();
    if (!view) return { ...stored, credentials: [] };
    const credentials = stored.credentials.filter((credential) => !passkeyEntries(view, credential.credentialId).revoked);
    const held = new Set(credentials.map((credential) => credential.credentialId));
    let policy: Pick<StepUpState, 'rpId' | 'origins' | 'userVerification'> = { rpId: stored.rpId, origins: stored.origins, userVerification: stored.userVerification };
    for (const entry of view.list('passkey')) {
      if (view.isRevoked(passkeyKey(entry.id)) || held.has(entry.public.credentialId)) continue;
      held.add(entry.public.credentialId);
      credentials.push({
        credentialId: entry.public.credentialId,
        publicKeyCose: entry.public.publicKeyCose,
        signCount: entry.public.signCount,
        ...(entry.public.label ? { label: entry.public.label } : {}),
        createdAt: entry.public.createdAt,
      });
      if (!policy.rpId || credentials.length === 1) policy = { rpId: entry.public.rpId, origins: [...entry.public.origins], userVerification: entry.public.userVerification };
      else if (policy.rpId === entry.public.rpId) policy = { ...policy, origins: [...new Set([...policy.origins, ...entry.public.origins])] };
    }
    return { ...policy, credentials };
  }

  /** Write a registration or removal to the authority record. Throws when it cannot, so a removal is never reported done on this machine only. */
  private async publish(change: { readonly register?: { readonly credential: StoredStepUpCredential; readonly state: StepUpState } | undefined; readonly remove?: string | undefined }): Promise<void> {
    const authority = this.authority;
    if (!authority) return;
    await authority.write((view) => {
      const changes: AuthorityChange<null>[] = [];
      const credentialId = change.register?.credential.credentialId ?? change.remove;
      if (credentialId === undefined) return { kind: 'none', value: null };
      // A registration replaces the credential's earlier entry; a removal ends every one.
      for (const entry of passkeyEntries(view, credentialId).live) {
        changes.push({ kind: 'revoke', key: passkeyKey(entry.id), by: 'owner', reason: change.register ? 'registered again' : 'removed by the owner', value: null });
      }
      const registered = change.register;
      if (registered) {
        changes.push({ kind: 'issue', value: null, entries: [{
          kind: 'passkey',
          id: `pk-${randomUUID()}`,
          public: {
            credentialId: registered.credential.credentialId,
            publicKeyCose: registered.credential.publicKeyCose,
            label: registered.credential.label ?? '',
            createdAt: registered.credential.createdAt,
            signCount: registered.credential.signCount,
            rpId: registered.state.rpId,
            origins: [...registered.state.origins],
            userVerification: registered.state.userVerification,
          },
        }] });
      }
      return changes.length === 0 ? { kind: 'none', value: null } : { kind: 'many', changes, value: null };
    });
  }

  /**
   * Refuse a registration or removal while the authority record exists but
   * cannot be read: the state loaded from it holds no credential, so a write
   * would overwrite every passkey held here, and a removal would answer
   * not-found for one that exists. Nothing is changed.
   */
  private requireReadableRecord(): void {
    const authority = this.authority;
    if (authority && !authority.view()) throw new AuthorityRecordUnavailableError(authority.filePath);
  }

  private async saveState(state: StepUpState): Promise<void> {
    // Rendered and read back with the reader's own codec before it is stored.
    await this.secrets.set(STEP_UP_STATE_KEY, renderChecked(STEP_UP_STATE_FORMAT, state) as string);
    this.knownCredentialCount = state.credentials.length;
  }

  /**
   * How many passkeys are registered. A positive count seen earlier is trusted
   * (no read); zero or unknown is read again, so a passkey registered since is
   * never reported missing. Another process removing every credential is seen
   * at the next verification, which reads the stored state anyway.
   */
  credentialCount(): Promise<number> {
    return this.serialized(() => this.credentialCountNow());
  }

  /** The count as of the last read or write of the stored state, without reading; undefined before the first. */
  lastKnownCredentialCount(): number | undefined {
    return this.knownCredentialCount;
  }

  private async credentialCountNow(): Promise<number> {
    if (this.knownCredentialCount !== undefined && this.knownCredentialCount > 0) return this.knownCredentialCount;
    return (await this.loadState()).credentials.length;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.stateQueue.then(operation, operation);
    // A failed operation must not wedge the ones queued behind it.
    this.stateQueue = next.catch(() => undefined);
    return next;
  }

  /** The registered credentials, without key material. */
  async listCredentials(): Promise<StepUpCredentialSummary[]> {
    const state = await this.serialized(() => this.loadState());
    return state.credentials.map((c) => ({
      credentialId: c.credentialId,
      ...(c.label ? { label: c.label } : {}),
      createdAt: c.createdAt,
      signCount: c.signCount,
    }));
  }

  /**
   * Remove a credential so it can no longer authorise anything (a lost device).
   * False when no such credential is registered. Challenges stay valid for the
   * credentials that remain.
   */
  removeCredential(credentialId: string): Promise<boolean> {
    return this.serialized(async () => {
      const state = await this.loadState();
      this.requireReadableRecord();
      const remaining = state.credentials.filter((c) => c.credentialId !== credentialId);
      if (remaining.length === state.credentials.length) return false;
      state.credentials = remaining;
      // Removed on every machine of the group first: a lost phone confirms nothing anywhere.
      // A record write that fails leaves the stored state untouched.
      await this.publish({ remove: credentialId });
      await this.saveState(state);
      return true;
    });
  }

  /**
   * Offer a passkey registration to the pairing a hand-off just minted
   * (`pairing:<id>`): that pairing, and no other caller, may register one
   * passkey through the hand-off, once, within {@link PASSKEY_REGISTRATION_OFFER_MS}.
   * In memory: a daemon restart withdraws the offer, and the device pairs again.
   */
  offerRegistration(principalId: string): { readonly expiresAt: number } {
    const now = this.now();
    for (const [offered, until] of this.registrationOffers) if (until <= now) this.registrationOffers.delete(offered);
    const expiresAt = now + PASSKEY_REGISTRATION_OFFER_MS;
    this.registrationOffers.set(principalId, expiresAt);
    return { expiresAt };
  }

  /**
   * Register (or replace) a credential and establish the deployment policy. The
   * COSE public key must parse as an EC2 P-256 key or the registration is
   * refused, a broken key would only fail closed silently later.
   */
  registerCredential(input: RegisterStepUpCredentialInput): Promise<StepUpCredentialSummary> {
    return this.serialized(() => this.registerCredentialNow(input));
  }

  private async registerCredentialNow(input: RegisterStepUpCredentialInput): Promise<StepUpCredentialSummary> {
    if (input.offeredTo !== undefined) {
      const until = this.registrationOffers.get(input.offeredTo);
      if (until === undefined || until <= this.now()) {
        this.registrationOffers.delete(input.offeredTo);
        throw new StepUpValidationError('No passkey was offered to this pairing, or the offer was used or expired. Nothing was registered. Pair the device again from the pairing screen, or register the passkey with stepup.credentials.register from an admin credential.');
      }
    }
    const rpId = input.rpId.trim();
    if (!rpId) throw new StepUpValidationError('rpId is required');
    const origins = normalizeOrigins(input.origin);
    if (origins.length === 0) throw new StepUpValidationError('at least one origin is required');
    if (!input.credentialId || !input.publicKeyCose) throw new StepUpValidationError('credentialId and publicKeyCose are required');
    let cose: Uint8Array<ArrayBuffer>;
    try {
      cose = fromBase64Url(input.publicKeyCose);
    } catch {
      throw new StepUpValidationError('publicKeyCose must be base64url');
    }
    const rawPoint = coseP256ToRawPoint(cose);
    if (!rawPoint) throw new StepUpValidationError('publicKeyCose is not a valid EC2 P-256 COSE key');
    // Imported now, the way verification imports it: a key that is shaped right
    // but is not a point on the curve is refused here, not at every confirmation after.
    try {
      await crypto.subtle.importKey('raw', rawPoint, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      throw new StepUpValidationError('publicKeyCose is not a usable P-256 public key (its point is not on the curve)');
    }

    const state = await this.loadState();
    this.requireReadableRecord();
    // One relying party and origin policy covers every credential, so a
    // registration for a different relying party would silently make the
    // existing credentials fail verification. Refuse it, and say how to proceed.
    const others = state.credentials.filter((c) => c.credentialId !== input.credentialId);
    if (others.length > 0 && state.rpId !== rpId) {
      throw new StepUpValidationError(
        `Credentials are already registered for relying party "${state.rpId}"; registering "${rpId}" would invalidate them. Nothing was registered. Remove the existing credentials first with stepup.credentials.remove (see stepup.credentials.list).`,
      );
    }
    state.rpId = rpId;
    // The same relying party may be reached from several origins: keep the ones already allowed.
    state.origins = others.length > 0 ? [...new Set([...state.origins, ...origins])] : origins;
    state.userVerification = input.userVerification ?? state.userVerification ?? 'required';
    const credential: StoredStepUpCredential = {
      credentialId: input.credentialId,
      publicKeyCose: input.publicKeyCose,
      signCount: typeof input.signCount === 'number' && input.signCount >= 0 ? Math.floor(input.signCount) : 0,
      ...(input.label ? { label: input.label } : {}),
      createdAt: this.now(),
    };
    state.credentials = [...state.credentials.filter((c) => c.credentialId !== credential.credentialId), credential];
    // The record first: a record write that fails leaves the stored state untouched. A local
    // save that fails after it is harmless, since a read adds the record's credentials back.
    await this.publish({ register: { credential, state } });
    await this.saveState(state);
    // The offer is used up by the registration it admitted.
    if (input.offeredTo !== undefined) this.registrationOffers.delete(input.offeredTo);
    return {
      credentialId: credential.credentialId,
      ...(credential.label ? { label: credential.label } : {}),
      createdAt: credential.createdAt,
      signCount: credential.signCount,
    };
  }

  /** Mint a short-lived, single-use challenge bound to the call, the minting principal and, when given, the session and rendezvous. */
  mintChallenge(input: MintStepUpChallengeInput = {}): MintedStepUpChallenge {
    this.pruneExpired();
    const principalId = input.principalId ?? '';
    let owned = 0;
    for (const entry of this.challenges.values()) if (entry.principalId === principalId) owned++;
    if (owned >= MAX_LIVE_STEP_UP_CHALLENGES_PER_PRINCIPAL) throw new StepUpChallengeLimitError(MAX_LIVE_STEP_UP_CHALLENGES_PER_PRINCIPAL);
    if (this.challenges.size >= MAX_LIVE_STEP_UP_CHALLENGES) throw new StepUpChallengeLimitError();
    const ttl = Math.min(MAX_CHALLENGE_TTL_MS, Math.max(MIN_CHALLENGE_TTL_MS, input.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS));
    const challenge = toBase64Url(this.randomChallenge());
    const id = toBase64Url(randomBytes(16));
    const expiresAt = this.now() + ttl;
    this.challenges.set(challenge, {
      id,
      challenge,
      ...(input.rendezvousId ? { rendezvousId: input.rendezvousId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.method ? { method: input.method.toUpperCase() } : {}),
      ...(input.path ? { path: input.path } : {}),
      principalId,
      expiresAt,
      consumed: false,
    });
    return { challengeId: id, challenge, expiresAt };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.challenges) {
      if (entry.expiresAt <= now || entry.consumed) this.challenges.delete(key);
    }
  }

  /**
   * The real {@link StepUpAssertionVerifier}. It parses the header envelope,
   * confirms the signed challenge is one we minted, is still live+unconsumed
   * and was minted for this request, runs the full WebAuthn verification
   * against the registered credential, and, only on complete success, consumes
   * the challenge and advances the stored signature counter. Every other path
   * is refused (fail closed) with the specific reason, which the gate hands to
   * the caller.
   */
  createVerifier(): StepUpAssertionVerifier {
    return async (assertion: string | null, context: StepUpRequestContext): Promise<StepUpVerification> => {
      const result = await this.verify(assertion, context);
      if (!result.ok && result.reason !== 'assertion-missing') {
        this.logger?.warn('step-up: assertion refused', { reason: result.reason });
      }
      return result;
    };
  }

  /**
   * Verify an envelope, returning a specific outcome (used by the verifier and
   * tests). The challenge is accepted only when `context` is the request it was
   * minted for (method, path and principal, plus session or rendezvous when it
   * names one); without a `context` nothing passes. A null `assertion` is
   * refused as `no-credential` when no passkey is registered at all, otherwise
   * as `assertion-missing`.
   */
  verify(
    assertion: string | null,
    context?: StepUpRequestContext,
  ): Promise<StepUpVerification> {
    return this.serialized(() => this.verifyNow(assertion, context));
  }

  private async verifyNow(
    assertion: string | null,
    context: StepUpRequestContext | undefined,
  ): Promise<StepUpVerification> {
    if (assertion === null) {
      return { ok: false, reason: (await this.credentialCountNow()) === 0 ? 'no-credential' : 'assertion-missing' };
    }
    const envelope = parseAssertionHeader(assertion);
    if (!envelope) return { ok: false, reason: 'malformed-envelope' };
    const state = await this.loadState();
    const credential = state.credentials.find((c) => c.credentialId === envelope.credentialId);
    if (!credential) return { ok: false, reason: 'no-credential' };

    const signedChallenge = peekSignedChallenge(envelope);
    if (!signedChallenge) return { ok: false, reason: 'malformed-envelope' };
    // Look up BEFORE pruning so an expired-but-still-present challenge yields the
    // specific 'challenge-expired' reason rather than a generic 'unknown'. Sweeping
    // of expired entries happens on the next mint (pruneExpired there).
    const live = this.challenges.get(signedChallenge);
    if (!live) return { ok: false, reason: 'unknown-challenge' };
    if (live.consumed) return { ok: false, reason: 'challenge-consumed' };
    if (live.expiresAt <= this.now()) {
      this.challenges.delete(signedChallenge);
      return { ok: false, reason: 'challenge-expired' };
    }
    if (!matchesBinding(live, context)) return { ok: false, reason: 'challenge-unbound' };

    const verifyResult = await verifyStepUpAssertion({
      envelope,
      credential,
      expectedChallenge: signedChallenge,
      rpId: state.rpId,
      allowedOrigins: state.origins,
      requireUserVerification: (state.userVerification ?? 'required') === 'required',
    });
    if (!verifyResult.ok) return { ok: false, reason: verifyResult.reason };

    // Consume the challenge (single-use). The counter is written back only when
    // the authenticator advanced it: many passkeys always report 0, and for
    // those an accepted call costs no secret-store write.
    live.consumed = true;
    this.challenges.delete(signedChallenge);
    if (verifyResult.signCount !== credential.signCount) {
      const updated: StoredStepUpCredential = { ...credential, signCount: verifyResult.signCount };
      state.credentials = state.credentials.map((c) => (c.credentialId === credential.credentialId ? updated : c));
      await this.saveState(state);
    }
    return { ok: true };
  }
}

/** The stored passkey state cannot be read: it is not "no passkey registered", and nothing is written over it. */
export class StepUpStateUnreadableError extends Error {
  constructor(reason: string) {
    super(`The stored passkey state (secret ${STEP_UP_STATE_KEY}) cannot be read: ${reason}. No passkey can confirm a call until it is replaced; `
      + `delete that secret from the secret store and register the passkeys again.`);
    this.name = 'StepUpStateUnreadableError';
  }
}

const USER_VERIFICATION: ReadonlySet<string> = new Set(['required', 'preferred', 'discouraged']);

function readStoredCredential(value: unknown): StoredStepUpCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as Readonly<Record<string, unknown>>;
  if (typeof entry.credentialId !== 'string' || !entry.credentialId || typeof entry.publicKeyCose !== 'string' || !entry.publicKeyCose) return null;
  if (typeof entry.signCount !== 'number' || !Number.isSafeInteger(entry.signCount) || entry.signCount < 0) return null;
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return null;
  if (entry.label !== undefined && typeof entry.label !== 'string') return null;
  return { credentialId: entry.credentialId, publicKeyCose: entry.publicKeyCose, signCount: entry.signCount,
    ...(entry.label ? { label: entry.label } : {}), createdAt: entry.createdAt };
}

/** The stored passkey state: the one form the service writes and reads, every field checked on the way in. */
const STEP_UP_STATE_FORMAT = defineFormat<StepUpState>({
  name: 'step-up state',
  parse(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'it is not text' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'it is not JSON' }; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'it is not an object' };
    const record = parsed as Readonly<Record<string, unknown>>;
    if (typeof record.rpId !== 'string') return { ok: false, reason: 'rpId is not text' };
    if (!Array.isArray(record.origins) || record.origins.some((origin) => typeof origin !== 'string')) return { ok: false, reason: 'origins is not a list of text' };
    if (typeof record.userVerification !== 'string' || !USER_VERIFICATION.has(record.userVerification)) return { ok: false, reason: 'userVerification is not required, preferred or discouraged' };
    if (!Array.isArray(record.credentials)) return { ok: false, reason: 'credentials is not a list' };
    const credentials: StoredStepUpCredential[] = [];
    for (const [index, entry] of record.credentials.entries()) {
      const credential = readStoredCredential(entry);
      if (!credential) return { ok: false, reason: `credential ${index + 1} is not a complete credential` };
      credentials.push(credential);
    }
    return { ok: true, value: { rpId: record.rpId, origins: record.origins as string[],
      userVerification: record.userVerification as UserVerificationRequirement, credentials } };
  },
  render(state) {
    return JSON.stringify({ rpId: state.rpId, origins: state.origins, userVerification: state.userVerification,
      credentials: state.credentials.map((credential) => ({ credentialId: credential.credentialId, publicKeyCose: credential.publicKeyCose,
        signCount: credential.signCount, ...(credential.label ? { label: credential.label } : {}), createdAt: credential.createdAt })) });
  },
});

/** Nothing stored is no passkey; a stored state that does not read is an error, never an empty list. */
function parseState(raw: string | null): StepUpState {
  if (!raw) return { rpId: '', origins: [], userVerification: 'required', credentials: [] };
  const parsed = STEP_UP_STATE_FORMAT.parse(raw);
  if (!parsed.ok) throw new StepUpStateUnreadableError(parsed.reason);
  return parsed.value;
}

/**
 * Whether the request is the one the challenge was minted for. Method and path
 * are always required, so a challenge minted without them authorises nothing;
 * the principal is compared whenever the gate knows who is calling; session and
 * rendezvous are compared when the challenge names them.
 */
function matchesBinding(live: LiveChallenge, context: StepUpRequestContext | undefined): boolean {
  if (!context || live.method === undefined || live.path === undefined) return false;
  if (context.method.toUpperCase() !== live.method || context.path !== live.path) return false;
  if (context.principalId !== undefined && context.principalId !== live.principalId) return false;
  if (live.sessionId !== undefined && context.sessionId !== live.sessionId) return false;
  if (live.rendezvousId !== undefined && context.rendezvousId !== live.rendezvousId) return false;
  return true;
}

/** Decode the `x-goodvibes-stepup-assertion` header value into an envelope. */
export function parseAssertionHeader(value: string): StepUpAssertionEnvelope | null {
  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64Url(value.trim()));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const fields = ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature'] as const;
  for (const field of fields) if (typeof record[field] !== 'string') return null;
  return {
    credentialId: record['credentialId'] as string,
    authenticatorData: record['authenticatorData'] as string,
    clientDataJSON: record['clientDataJSON'] as string,
    signature: record['signature'] as string,
  };
}

/** Encode an envelope into the header value form (base64url of the JSON). */
export function encodeAssertionHeader(envelope: StepUpAssertionEnvelope): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)) as Uint8Array<ArrayBuffer>);
}

/** Peek the challenge the authenticator signed (from clientDataJSON), without verifying. */
function peekSignedChallenge(envelope: StepUpAssertionEnvelope): string | null {
  try {
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(envelope.clientDataJSON))) as Record<string, unknown>;
    return typeof clientData['challenge'] === 'string' ? clientData['challenge'] : null;
  } catch {
    return null;
  }
}
