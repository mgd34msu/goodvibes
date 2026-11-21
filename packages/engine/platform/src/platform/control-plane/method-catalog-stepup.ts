/**
 * method-catalog-stepup.ts
 *
 * Contract descriptors for the relay WebAuthn step-up ceremony verbs:
 *
 *   - stepup.credentials.register, store a passkey (credentialId + COSE public
 *     key + starting signature counter) and establish the deployment policy
 *     (rpId, allowed origins, user-verification requirement). Admin-gated; a
 *     self-hosted deployment registers the credential directly ('none'
 *     attestation), so there is no attestation chain to verify here (documented
 *     in docs/relay-zero-knowledge.md).
 *   - stepup.credentials.list / stepup.credentials.remove, show the registered
 *     passkeys (no key material) and remove one, for a lost device. Admin-gated;
 *     remove is a mutating call, so a relay call needs a step-up assertion.
 *   - stepup.challenge.mint, issue a short-lived, single-use challenge bound to
 *     the minting principal and the call's method and path (and, when given,
 *     its session and rendezvous), which a surface feeds to
 *     `navigator.credentials.get` before making a state-changing relay call.
 *
 * The assertion produced by the passkey is carried on the mutating call in the
 * `x-goodvibes-stepup-assertion` header and verified by the daemon's real
 * StepUpAssertionVerifier (relay/step-up-service.ts), no operator verb reads or
 * returns assertions.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import type { ContractErrorCode } from '../types/foundation-contract.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  entityOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const USER_VERIFICATION_SCHEMA = { type: 'string', enum: ['required', 'preferred', 'discouraged'] } as const;

export const STEP_UP_CREDENTIAL_SUMMARY_SCHEMA = objectSchema({
  credentialId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  signCount: NUMBER_SCHEMA,
}, ['credentialId', 'createdAt', 'signCount']);

export const STEP_UP_CREDENTIALS_REGISTER_INPUT_SCHEMA = objectSchema({
  rpId: STRING_SCHEMA,
  // One origin, or several: the handler and the service accept both.
  origin: { anyOf: [STRING_SCHEMA, arraySchema(STRING_SCHEMA)] },
  credentialId: STRING_SCHEMA,
  publicKeyCose: STRING_SCHEMA,
  signCount: NUMBER_SCHEMA,
  userVerification: USER_VERIFICATION_SCHEMA,
  label: STRING_SCHEMA,
}, ['rpId', 'origin', 'credentialId', 'publicKeyCose']);
export const STEP_UP_CREDENTIALS_REGISTER_OUTPUT_SCHEMA = entityOutputSchema('credential', STEP_UP_CREDENTIAL_SUMMARY_SCHEMA);

export const STEP_UP_CREDENTIALS_LIST_OUTPUT_SCHEMA = objectSchema({
  credentials: arraySchema(STEP_UP_CREDENTIAL_SUMMARY_SCHEMA),
}, ['credentials']);

export const STEP_UP_CREDENTIALS_REMOVE_INPUT_SCHEMA = objectSchema({ credentialId: STRING_SCHEMA }, ['credentialId']);
export const STEP_UP_CREDENTIALS_REMOVE_OUTPUT_SCHEMA = objectSchema({
  credentialId: STRING_SCHEMA,
  removed: BOOLEAN_SCHEMA,
}, ['credentialId', 'removed']);

export const STEP_UP_CHALLENGE_MINT_INPUT_SCHEMA = objectSchema({
  rendezvousId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  method: STRING_SCHEMA,
  path: STRING_SCHEMA,
  ttlMs: NUMBER_SCHEMA,
}, []);
export const STEP_UP_CHALLENGE_MINT_OUTPUT_SCHEMA = objectSchema({
  challengeId: STRING_SCHEMA,
  challenge: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
}, ['challengeId', 'challenge', 'expiresAt']);

const STEP_UP_CHALLENGES_FULL: ContractErrorCode = { code: 'STEP_UP_CHALLENGES_FULL', status: 429, meaning: 'Too many step-up challenges are open; answer one or let it expire, then ask again.' };

export const builtinGatewayStepUpMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'stepup.credentials.register',
    repeat: 'safe',
    effects: ['stepup.credential.register'],
    title: 'Register Step-up Credential',
    description: 'Store a WebAuthn (passkey) credential for relay step-up, its credentialId, COSE public key, and starting signature counter, and set the deployment policy (relying-party id, allowed origins, user-verification requirement). Admin/local-only: registering a step-up credential is itself a sensitive act. Self-hosted deployments register the credential directly (\'none\' attestation).',
    category: 'relay',
    http: { method: 'POST', path: '/api/stepup/credentials' },
    inputSchema: STEP_UP_CREDENTIALS_REGISTER_INPUT_SCHEMA,
    outputSchema: STEP_UP_CREDENTIALS_REGISTER_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'stepup.credentials.list',
    title: 'List Step-up Credentials',
    description: 'List the registered step-up passkeys: credentialId, label, creation time and signature counter. Never returns key material. Admin/local-only.',
    category: 'relay',
    effects: ['relay.inspect'],
    http: { method: 'GET', path: '/api/stepup/credentials' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: STEP_UP_CREDENTIALS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'stepup.credentials.remove',
    repeat: 'safe',
    effects: ['relay.administer', 'model.refused'],
    title: 'Remove Step-up Credential',
    description: 'Remove a registered step-up passkey so it can no longer confirm anything (a lost device). Answers 404 when no credential has that id. Admin/local-only. Mutating, so a relay call needs a step-up assertion. Removing the last passkey leaves no credential to confirm relay actions until a new one is registered.',
    category: 'relay',
    http: { method: 'DELETE', path: '/api/stepup/credentials/{credentialId}' },
    inputSchema: STEP_UP_CREDENTIALS_REMOVE_INPUT_SCHEMA,
    outputSchema: STEP_UP_CREDENTIALS_REMOVE_OUTPUT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'stepup.challenge.mint',
    title: 'Mint Step-up Challenge',
    description: 'Issue a short-lived, single-use WebAuthn challenge for one relay call. Pass the method and path of the call it is for: a challenge minted without them authorises nothing. The challenge is bound to the principal that minted it, and to the sessionId and rendezvousId when given; a relay call by another principal, or with a different method, path, session or rendezvous, is refused as challenge-unbound. A surface passes it to navigator.credentials.get and returns the assertion on the call it was minted for. Whether a relay call needs an assertion is decided by its catalog method\'s scopes (any scope other than read:*), not by its HTTP verb. The freshness window (ttlMs) is clamped to 5s–300s (default 120s).',
    category: 'relay',
    effects: ['relay.read'],
    http: { method: 'POST', path: '/api/stepup/challenge' },
    inputSchema: STEP_UP_CHALLENGE_MINT_INPUT_SCHEMA,
    outputSchema: STEP_UP_CHALLENGE_MINT_OUTPUT_SCHEMA,
    errorCodes: [STEP_UP_CHALLENGES_FULL],
  }),
];
