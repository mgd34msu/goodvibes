import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import { BOOLEAN_SCHEMA, EMPTY_OBJECT_SCHEMA, JSON_VALUE_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, branchedSchema, objectSchema, listOutputSchema, entityOutputSchema, bodyEnvelopeSchema, methodDescriptor, requirementBranch, stringEnumSchema } from './method-catalog-shared.js';
import {
  CONFIG_SET_OUTPUT_SCHEMA,
  OWNER_APPROVAL_PENDING_SCHEMA,
  CONFIG_SNAPSHOT_SCHEMA,
  CREDENTIALS_SNAPSHOT_SCHEMA,
  CREDENTIAL_DELETE_INPUT_SCHEMA,
  CREDENTIAL_DELETE_OUTPUT_SCHEMA,
  CREDENTIAL_SET_INPUT_SCHEMA,
  CREDENTIAL_SET_OUTPUT_SCHEMA,
  LOCAL_AUTH_USER_SCHEMA,
  LOCAL_AUTH_BOOTSTRAP_DELETE_OUTPUT_SCHEMA,
  LOCAL_AUTH_DELETE_OUTPUT_SCHEMA,
  LOCAL_AUTH_SESSION_REVOKE_OUTPUT_SCHEMA,
  LOCAL_AUTH_STATUS_SCHEMA,
  LOCAL_AUTH_ROTATE_PASSWORD_OUTPUT_SCHEMA,
  PANEL_OPEN_OUTPUT_SCHEMA,
  PANEL_SNAPSHOT_SCHEMA,
} from './operator-contract-schemas.js';

/**
 * The settings owner lane `config.set` also serves (daemon-api
 * settings-precondition.ts owns its rules). `capture` reads the facts a change
 * would act on; `write` makes the change, optionally only while the daemon
 * still serves `ifServing` at configuration incarnation `ifIncarnation`, and a
 * repeated `requestId` returns the first answer. The arm is the only field of
 * its body; the operation's own fields (key, value) ride beside it.
 */
function settingsLaneArmSchema(actions: readonly string[]): Record<string, unknown> {
  return objectSchema({
    version: NUMBER_SCHEMA,
    action: stringEnumSchema(actions),
    ifIncarnation: { type: 'integer', minimum: 0 },
    ifServing: STRING_SCHEMA,
    requestId: STRING_SCHEMA,
  }, ['version', 'action'], { additionalProperties: true });
}

const SETTINGS_PRECONDITION_ARM_SCHEMA = settingsLaneArmSchema(['capture', 'write']);
/**
 * `config.set` takes one of two bodies: `{ key, value }` writes a value;
 * `{ settingsPrecondition }` runs the capture-then-write lane the settings
 * clients use.
 */
const CONFIG_SET_INPUT_SCHEMA = branchedSchema(
  bodyEnvelopeSchema({
    key: STRING_SCHEMA,
    value: JSON_VALUE_SCHEMA,
    settingsPrecondition: SETTINGS_PRECONDITION_ARM_SCHEMA,
  }),
  [
    requirementBranch({ key: STRING_SCHEMA, value: JSON_VALUE_SCHEMA }, ['key', 'value']),
    requirementBranch({ settingsPrecondition: SETTINGS_PRECONDITION_ARM_SCHEMA }, ['settingsPrecondition']),
  ],
);

const CONFIG_SET_MANY_INPUT_SCHEMA = objectSchema({
  entries: arraySchema(objectSchema({ key: STRING_SCHEMA, value: JSON_VALUE_SCHEMA }, ['key', 'value'])),
}, ['entries']);

const CONFIG_SET_MANY_OUTPUT_SCHEMA = objectSchema({
  success: BOOLEAN_SCHEMA,
  revision: NUMBER_SCHEMA,
  entries: arraySchema(objectSchema({
    key: STRING_SCHEMA,
    value: JSON_VALUE_SCHEMA,
    persistedTo: STRING_SCHEMA,
    tier: STRING_SCHEMA,
    // Where the held value comes from when that is not its tier (a default the host set, a runtime value), as config.set reports it.
    effectiveOrigin: STRING_SCHEMA,
    daemonOwned: BOOLEAN_SCHEMA,
  }, ['key'], { additionalProperties: true })),
}, ['success', 'revision', 'entries']);

export const builtinGatewayAdminMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'local_auth.status',
    title: 'Local Auth Status',
    description: 'Return local auth posture, users, and sessions.',
    category: 'auth',
    effects: ['auth.inspect'],
    http: { method: 'GET', path: '/api/local-auth' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: LOCAL_AUTH_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.users.create',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Create Local Auth User',
    description: 'Create a local auth user. roles: omitted creates an admin. scopes: the operator scopes the user holds (for example read:sessions and write:sessions for someone who only chats: they read their own chats under them; read:transcripts adds anyone else\'s); omitted, the user holds its role\'s default set. A narrowed user is not an admin, whatever its roles.',
    category: 'auth',
    http: { method: 'POST', path: '/api/local-auth/users' },
    inputSchema: bodyEnvelopeSchema({
      username: STRING_SCHEMA,
      password: STRING_SCHEMA,
      roles: arraySchema(STRING_SCHEMA),
      scopes: arraySchema(STRING_SCHEMA),
    }, ['username', 'password']),
    outputSchema: entityOutputSchema('user', LOCAL_AUTH_USER_SCHEMA),
  }),
  methodDescriptor({
    id: 'local_auth.users.scopes.set',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Set Local Auth User Scopes',
    description: 'Give a local auth user a narrower list of operator scopes, or return it to its role\'s default set with scopes: null. Takes effect on the user\'s next request. An unknown user is 400; a scopes value that is neither a nonempty list nor null is 400 INVALID_ARGUMENT naming scopes.',
    category: 'auth',
    http: { method: 'POST', path: '/api/local-auth/users/{username}/scopes' },
    inputSchema: bodyEnvelopeSchema({
      username: STRING_SCHEMA,
      scopes: { anyOf: [arraySchema(STRING_SCHEMA), { type: 'null' }] },
    }, ['username', 'scopes']),
    outputSchema: entityOutputSchema('user', LOCAL_AUTH_USER_SCHEMA),
  }),
  methodDescriptor({
    id: 'local_auth.users.delete',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Delete Local Auth User',
    description: 'Delete a local auth user.',
    category: 'auth',
    http: { method: 'DELETE', path: '/api/local-auth/users/{username}' },
    inputSchema: objectSchema({ username: STRING_SCHEMA }, ['username']),
    outputSchema: LOCAL_AUTH_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.users.password.rotate',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Rotate Local Auth Password',
    description: 'Rotate a local auth user password.',
    category: 'auth',
    http: { method: 'POST', path: '/api/local-auth/users/{username}/password' },
    inputSchema: bodyEnvelopeSchema({ username: STRING_SCHEMA, password: STRING_SCHEMA }, ['username', 'password']),
    outputSchema: LOCAL_AUTH_ROTATE_PASSWORD_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.sessions.delete',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Revoke Local Auth Session',
    description: 'Revoke a local auth session.',
    category: 'auth',
    http: { method: 'DELETE', path: '/api/local-auth/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: LOCAL_AUTH_SESSION_REVOKE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.bootstrap.delete',
    repeat: 'safe',
    effects: ['auth.administer', 'model.refused'],
    title: 'Delete Bootstrap File',
    description: 'Delete the local-auth bootstrap credential file.',
    category: 'auth',
    http: { method: 'DELETE', path: '/api/local-auth/bootstrap-file' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: LOCAL_AUTH_BOOTSTRAP_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'panels.list',
    title: 'List Panels',
    description: 'Return integration panel descriptors.',
    category: 'panels',
    effects: ['panels.read'],
    http: { method: 'GET', path: '/api/panels' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('panels', PANEL_SNAPSHOT_SCHEMA),
  }),
  methodDescriptor({
    id: 'panels.open',
    repeat: 'safe',
    title: 'Open Panel',
    description: 'Open a listed panel in the terminal session this process runs. Answers opened: true only when the view appeared; an id GET /api/panels does not list is refused with 404, and a listed panel this process has no terminal screen to show is refused with 409.',
    category: 'panels',
    effects: ['panels.administer'],
    http: { method: 'POST', path: '/api/panels/open' },
    inputSchema: bodyEnvelopeSchema({
      id: STRING_SCHEMA,
      pane: STRING_SCHEMA,
    }, ['id']),
    outputSchema: PANEL_OPEN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.get',
    title: 'Get Config',
    description: 'Return the resolved GoodVibes config snapshot.',
    category: 'config',
    effects: ['config.inspect'],
    http: { method: 'GET', path: '/config' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: CONFIG_SNAPSHOT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.get',
    title: 'Get Credential Status',
    description: 'Return secret-free credential status (configured/usable) for the shared store. Never returns raw secret bytes. Optional ?key= narrows to one credential.',
    category: 'config',
    effects: ['config.inspect'],
    http: { method: 'GET', path: '/config/credentials' },
    inputSchema: objectSchema({ key: STRING_SCHEMA }, []),
    outputSchema: CREDENTIALS_SNAPSHOT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.set',
    repeat: 'safe',
    effects: ['secret.write'],
    title: 'Set Credential',
    description: 'Store a credential for a secret-bearing config key THROUGH the daemon, so a surface no longer has to write it into its own on-disk secret store, the write counterpart to credentials.get, and the reason a client on another machine can now finish a settings modal at all. `key` is the config path (e.g. surfaces.telegram.botToken); the secret-store name is derived from it. The value goes into the encrypted store at the scope the ownership rules resolve (a daemon-needed credential lands in the daemon tier whoever asked), is read BACK and compared, and only then does the config key take its goodvibes://secrets/goodvibes/<KEY> reference. A read-back mismatch fails the call and leaves the setting exactly as it was, because a reference resolving to nothing reads as a configured-but-broken credential. The response is secret-free: key names, the resolved scope, the reference now in config, and two plain sentences about where the setting and the credential are filed, never the value. Refuses a key that is not credential-bearing (use config.set) and refuses a value that is itself a goodvibes:// reference. ws-only invoke verb; no REST binding. Mutating, so a relay call is covered by relay.requireStepUpForMutations exactly as config.set is.',
    category: 'config',
    transport: ['ws'],
    inputSchema: CREDENTIAL_SET_INPUT_SCHEMA,
    outputSchema: CREDENTIAL_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.delete',
    repeat: 'safe',
    effects: ['secret.write'],
    title: 'Delete Credential',
    description: 'Remove a credential: the stored secret first, then the config reference pointing at it. That order is deliberate, clearing the config first would strand a secret nothing points at and nothing reaps, while this order leaves, for an instant, a reference resolving to nothing, which every reader already treats as configured-but-broken (the honest state for a credential mid-removal). `cleared: false` means nothing was stored under that key: a miss, not an error, because asking for a credential to be gone when it already is has succeeded. ws-only invoke verb; no REST binding. Mutating, so a relay call is covered by relay.requireStepUpForMutations exactly as config.set is.',
    category: 'config',
    transport: ['ws'],
    inputSchema: CREDENTIAL_DELETE_INPUT_SCHEMA,
    outputSchema: CREDENTIAL_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.set',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Set Config Value',
    description: 'Write one config value on the daemon: `{ key, value }`, where value is any JSON the key accepts. The response reports the value the host now holds and which file and tier it is in; a value that did not take is refused with what the host holds instead. A key that holds a credential takes only a goodvibes://secrets/ reference (store the secret with credentials.set); runtime.workingDir is refused (409 WORKSPACE_CHANGE_UNAVAILABLE): the daemon serves every project at once and no caller moves it, so a call names its project itself. The same route also serves the settings clients\' lane, which answers with its own object: `{ settingsPrecondition }` takes action `capture` (read the facts a change would act on) or `write` (make it, optionally only while `ifServing` and `ifIncarnation` still hold; a repeated `requestId` returns the first answer). A change that loosens a security, permission, judgment or payment setting is the owner\'s own act: asked with a token minted for automation (one minted through the API by another token, such as pairing.tokens.create or pairing.tokens.migrate, or with narrowed scopes or for a named client; pairing.tokens.list shows it as origin automation) it is not made, but put to the owner as an approval only the owner\'s own credential answers, and the answer is 202 with code OWNER_APPROVAL_PENDING and the `approvalId`; the change is applied when the owner approves it, and lapses after a day unanswered or if the daemon restarts first. The owner in person (their sign-in, their own terminal program with a verified registration) makes it at once; any paired device, the owner\'s own included, is put to the owner.',
    category: 'config',
    effects: ['config.administer'],
    http: { method: 'POST', path: '/config' },
    inputSchema: CONFIG_SET_INPUT_SCHEMA,
    outputSchema: { anyOf: [CONFIG_SET_OUTPUT_SCHEMA, OWNER_APPROVAL_PENDING_SCHEMA] },
  }),
  methodDescriptor({
    id: 'config.setMany',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Set Several Config Values',
    description: 'Write several config values on the daemon as one update: `{ entries: [{ key, value }] }`. Every entry is admitted before anything is written, each settings file is written once and the configuration revision moves once, so a pair of settings that only make sense together never lands half-applied. A refusal names the setting, the reason and the next step, and says what was saved (nothing, unless a later settings file could not be written after an earlier one was). The answer lists, per key, the value the host now holds and which file and tier it is in; when a key does not hold the value asked for (a higher tier overrides it, or it was coerced), the answer is 409 CONFIG_SET_NOT_APPLIED naming those keys in `notApplied`, with the revision written and every entry\'s held value. A key that holds a credential takes only a goodvibes://secrets/ reference; runtime.workingDir is refused (409 WORKSPACE_CHANGE_UNAVAILABLE), as with config.set. A change that loosens a security, permission, judgment or payment setting is the owner\'s own act: asked with a token minted for automation (one minted through the API by another token, such as pairing.tokens.create or pairing.tokens.migrate, or with narrowed scopes or for a named client; pairing.tokens.list shows it as origin automation) it is not made, but put to the owner as an approval only the owner\'s own credential answers, and the answer is 202 with code OWNER_APPROVAL_PENDING and the `approvalId`; the change is applied when the owner approves it, and lapses after a day unanswered or if the daemon restarts first. The owner in person (their sign-in, their own terminal program with a verified registration) makes it at once; any paired device, the owner\'s own included, is put to the owner.',
    category: 'config',
    effects: ['config.administer'],
    http: { method: 'POST', path: '/config/many' },
    inputSchema: CONFIG_SET_MANY_INPUT_SCHEMA,
    outputSchema: { anyOf: [CONFIG_SET_MANY_OUTPUT_SCHEMA, OWNER_APPROVAL_PENDING_SCHEMA] },
  }),
  methodDescriptor({
    id: 'config.reset',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Reset Config Value',
    description: 'Remove the explicit value of one config key through the daemon API so it reads as its default again, in every settings file that holds it. The response reports the value the host now holds and which file and tier it came from. Refuses a key that holds a credential (use credentials.delete), a key the host does not know, a key locked by managed policy, and runtime.workingDir (no caller moves the daemon). A change that loosens a security, permission, judgment or payment setting is the owner\'s own act: asked with a token minted for automation (one minted through the API by another token, such as pairing.tokens.create or pairing.tokens.migrate, or with narrowed scopes or for a named client; pairing.tokens.list shows it as origin automation) it is not made, but put to the owner as an approval only the owner\'s own credential answers, and the answer is 202 with code OWNER_APPROVAL_PENDING and the `approvalId`; the change is applied when the owner approves it, and lapses after a day unanswered or if the daemon restarts first. The owner in person (their sign-in, their own terminal program with a verified registration) makes it at once; any paired device, the owner\'s own included, is put to the owner.',
    category: 'config',
    effects: ['config.administer'],
    http: { method: 'POST', path: '/config/reset' },
    inputSchema: objectSchema({ key: STRING_SCHEMA }, ['key']),
    outputSchema: { anyOf: [CONFIG_SET_OUTPUT_SCHEMA, OWNER_APPROVAL_PENDING_SCHEMA] },
  }),
];
