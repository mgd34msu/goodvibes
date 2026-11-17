import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { BOOLEAN_SCHEMA, EMPTY_OBJECT_SCHEMA, JSON_VALUE_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, branchedSchema, objectSchema, listOutputSchema, entityOutputSchema, bodyEnvelopeSchema, methodDescriptor, requirementBranch, stringEnumSchema } from './method-catalog-shared.js';
import {
  CONFIG_SET_OUTPUT_SCHEMA,
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
 * The settings owner lanes `config.set` also serves (daemon-api
 * settings-precondition.ts and settings-import-precondition.ts own their
 * rules). `capture` reads the facts a change would act on; `write` makes the
 * change, optionally only while the daemon still serves `ifServing` at
 * configuration incarnation `ifIncarnation`, and a repeated `requestId`
 * returns the first answer. The import lane also keeps `apply`, which spends
 * a captured `reference`. Each arm is the only field of its body; the
 * operation's own fields (key, value, settings) ride beside these.
 */
function settingsLaneArmSchema(actions: readonly string[]): Record<string, unknown> {
  return objectSchema({
    version: NUMBER_SCHEMA,
    action: stringEnumSchema(actions),
    reference: STRING_SCHEMA,
    ifIncarnation: { type: 'integer', minimum: 0 },
    ifServing: STRING_SCHEMA,
    requestId: STRING_SCHEMA,
  }, ['version', 'action'], { additionalProperties: true });
}

const SETTINGS_PRECONDITION_ARM_SCHEMA = settingsLaneArmSchema(['capture', 'write']);
const SETTINGS_IMPORT_PRECONDITION_ARM_SCHEMA = settingsLaneArmSchema(['capture', 'apply', 'write']);

/**
 * `config.set` takes one of three bodies: `{ key, value }` writes a value;
 * `{ settingsPrecondition }` and `{ settingsImportPrecondition }` run the
 * capture-then-apply lanes the settings and import clients use.
 */
const CONFIG_SET_INPUT_SCHEMA = branchedSchema(
  bodyEnvelopeSchema({
    key: STRING_SCHEMA,
    value: JSON_VALUE_SCHEMA,
    settingsPrecondition: SETTINGS_PRECONDITION_ARM_SCHEMA,
    settingsImportPrecondition: SETTINGS_IMPORT_PRECONDITION_ARM_SCHEMA,
  }),
  [
    requirementBranch({ key: STRING_SCHEMA, value: JSON_VALUE_SCHEMA }, ['key', 'value']),
    requirementBranch({ settingsPrecondition: SETTINGS_PRECONDITION_ARM_SCHEMA }, ['settingsPrecondition']),
    requirementBranch({ settingsImportPrecondition: SETTINGS_IMPORT_PRECONDITION_ARM_SCHEMA }, ['settingsImportPrecondition']),
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
    daemonOwned: BOOLEAN_SCHEMA,
  }, ['key'])),
}, ['success', 'revision', 'entries']);

export const builtinGatewayAdminMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'local_auth.status',
    title: 'Local Auth Status',
    description: 'Return local auth posture, users, and sessions.',
    category: 'auth',
    scopes: ['read:auth'],
    access: 'admin',
    http: { method: 'GET', path: '/api/local-auth' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: LOCAL_AUTH_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.users.create',
    title: 'Create Local Auth User',
    description: 'Create a local auth user. roles: omitted creates an admin. scopes: the operator scopes the user holds (for example read:sessions and write:sessions for someone who only chats); omitted, the user holds its role\'s default set. A narrowed user is not an admin, whatever its roles.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
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
    title: 'Set Local Auth User Scopes',
    description: 'Give a local auth user a narrower list of operator scopes, or return it to its role\'s default set with scopes: null. Takes effect on the user\'s next request. An unknown user is 400; a scopes value that is neither a nonempty list nor null is 400 INVALID_ARGUMENT naming scopes.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'POST', path: '/api/local-auth/users/{username}/scopes' },
    inputSchema: bodyEnvelopeSchema({
      username: STRING_SCHEMA,
      scopes: { anyOf: [arraySchema(STRING_SCHEMA), { type: 'null' }] },
    }, ['username', 'scopes']),
    outputSchema: entityOutputSchema('user', LOCAL_AUTH_USER_SCHEMA),
  }),
  methodDescriptor({
    id: 'local_auth.users.delete',
    title: 'Delete Local Auth User',
    description: 'Delete a local auth user.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/users/{username}' },
    inputSchema: objectSchema({ username: STRING_SCHEMA }, ['username']),
    outputSchema: LOCAL_AUTH_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.users.password.rotate',
    title: 'Rotate Local Auth Password',
    description: 'Rotate a local auth user password.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'POST', path: '/api/local-auth/users/{username}/password' },
    inputSchema: bodyEnvelopeSchema({ username: STRING_SCHEMA, password: STRING_SCHEMA }, ['username', 'password']),
    outputSchema: LOCAL_AUTH_ROTATE_PASSWORD_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.sessions.delete',
    title: 'Revoke Local Auth Session',
    description: 'Revoke a local auth session.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: LOCAL_AUTH_SESSION_REVOKE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.bootstrap.delete',
    title: 'Delete Bootstrap File',
    description: 'Delete the local-auth bootstrap credential file.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/bootstrap-file' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: LOCAL_AUTH_BOOTSTRAP_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'panels.list',
    title: 'List Panels',
    description: 'Return integration panel descriptors.',
    category: 'panels',
    scopes: ['read:panels'],
    http: { method: 'GET', path: '/api/panels' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('panels', PANEL_SNAPSHOT_SCHEMA),
  }),
  methodDescriptor({
    id: 'panels.open',
    title: 'Open Panel',
    description: 'Open a listed panel in the terminal session this process runs. Answers opened: true only when the view appeared; an id GET /api/panels does not list is refused with 404, and a listed panel this process has no terminal screen to show is refused with 409.',
    category: 'panels',
    access: 'admin',
    scopes: ['write:panels'],
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
    scopes: ['read:config'],
    access: 'admin',
    http: { method: 'GET', path: '/config' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: CONFIG_SNAPSHOT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.get',
    title: 'Get Credential Status',
    description: 'Return secret-free credential status (configured/usable) for the shared store. Never returns raw secret bytes. Optional ?key= narrows to one credential.',
    category: 'config',
    scopes: ['read:config'],
    access: 'admin',
    http: { method: 'GET', path: '/config/credentials' },
    inputSchema: objectSchema({ key: STRING_SCHEMA }, []),
    outputSchema: CREDENTIALS_SNAPSHOT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.set',
    title: 'Set Credential',
    description: 'Store a credential for a secret-bearing config key THROUGH the daemon, so a surface no longer has to write it into its own on-disk secret store, the write counterpart to credentials.get, and the reason a client on another machine can now finish a settings modal at all. `key` is the config path (e.g. surfaces.telegram.botToken); the secret-store name is derived from it. The value goes into the encrypted store at the scope the ownership rules resolve (a daemon-needed credential lands in the daemon tier whoever asked), is read BACK and compared, and only then does the config key take its goodvibes://secrets/goodvibes/<KEY> reference. A read-back mismatch fails the call and leaves the setting exactly as it was, because a reference resolving to nothing reads as a configured-but-broken credential. The response is secret-free: key names, the resolved scope, the reference now in config, and two plain sentences about where the setting and the credential are filed, never the value. Refuses a key that is not credential-bearing (use config.set) and refuses a value that is itself a goodvibes:// reference. ws-only invoke verb; no REST binding. Mutating, so a relay call is covered by relay.requireStepUpForMutations exactly as config.set is.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: CREDENTIAL_SET_INPUT_SCHEMA,
    outputSchema: CREDENTIAL_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'credentials.delete',
    title: 'Delete Credential',
    description: 'Remove a credential: the stored secret first, then the config reference pointing at it. That order is deliberate, clearing the config first would strand a secret nothing points at and nothing reaps, while this order leaves, for an instant, a reference resolving to nothing, which every reader already treats as configured-but-broken (the honest state for a credential mid-removal). `cleared: false` means nothing was stored under that key: a miss, not an error, because asking for a credential to be gone when it already is has succeeded. ws-only invoke verb; no REST binding. Mutating, so a relay call is covered by relay.requireStepUpForMutations exactly as config.set is.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: CREDENTIAL_DELETE_INPUT_SCHEMA,
    outputSchema: CREDENTIAL_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.set',
    title: 'Set Config Value',
    description: 'Write one config value on the daemon: `{ key, value }`, where value is any JSON the key accepts. The response reports the value the host now holds and which file and tier it is in; a value that did not take is refused with what the host holds instead. A key that holds a credential takes only a goodvibes://secrets/ reference (store the secret with credentials.set); runtime.workingDir is saved for the next start of the daemon. The same route also serves the settings clients\' lanes, which answer with that lane\'s own object: `{ settingsPrecondition }` takes action `capture` (read the facts a change would act on) or `write` (make it, optionally only while `ifServing` and `ifIncarnation` still hold; a repeated `requestId` returns the first answer), and `{ settingsImportPrecondition }` takes the same two actions plus `apply`, which spends a captured `reference`.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    http: { method: 'POST', path: '/config' },
    inputSchema: CONFIG_SET_INPUT_SCHEMA,
    outputSchema: CONFIG_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.setMany',
    title: 'Set Several Config Values',
    description: 'Write several config values on the daemon as one update: `{ entries: [{ key, value }] }`. Every entry is admitted before anything is written, each settings file is written once and the configuration revision moves once, so a pair of settings that only make sense together never lands half-applied. A refusal names the setting, the reason and the next step, and says what was saved (nothing, unless a later settings file could not be written after an earlier one was). The answer lists, per key, the value the host now holds and which file and tier it is in; when a key does not hold the value asked for (a higher tier overrides it, or it was coerced), the answer is 409 CONFIG_SET_NOT_APPLIED naming those keys in `notApplied`, with the revision written and every entry's held value. A key that holds a credential takes only a goodvibes://secrets/ reference; runtime.workingDir is set on its own with config.set.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    http: { method: 'POST', path: '/config/many' },
    inputSchema: CONFIG_SET_MANY_INPUT_SCHEMA,
    outputSchema: CONFIG_SET_MANY_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.reset',
    title: 'Reset Config Value',
    description: 'Remove the explicit value of one config key through the daemon API so it reads as its default again, in every settings file that holds it. The response reports the value the host now holds and which file and tier it came from. Refuses a key that holds a credential (use credentials.delete), a key the host does not know, a key locked by managed policy, and runtime.workingDir (change the workspace with config.set).',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    http: { method: 'POST', path: '/config/reset' },
    inputSchema: objectSchema({ key: STRING_SCHEMA }, ['key']),
    outputSchema: CONFIG_SET_OUTPUT_SCHEMA,
  }),
];
