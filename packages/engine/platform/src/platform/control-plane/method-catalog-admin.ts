import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { EMPTY_OBJECT_SCHEMA, JSON_VALUE_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, branchedSchema, objectSchema, listOutputSchema, entityOutputSchema, bodyEnvelopeSchema, methodDescriptor, requirementBranch, stringEnumSchema } from './method-catalog-shared.js';
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
 * The two-step settings owner lanes `config.set` also serves: `capture`
 * prepares a change and returns a reference, `apply` spends it. Each arm is the
 * only field of its body; the arm's own fields depend on the action.
 */
function settingsLaneArmSchema(): Record<string, unknown> {
  return objectSchema({
    version: NUMBER_SCHEMA,
    action: stringEnumSchema(['capture', 'apply']),
    reference: STRING_SCHEMA,
  }, ['version', 'action'], { additionalProperties: true });
}

/**
 * `config.set` takes one of three bodies: `{ key, value }` writes a value;
 * `{ settingsPrecondition }` and `{ settingsImportPrecondition }` run the
 * capture-then-apply lanes the settings and import clients use.
 */
const CONFIG_SET_INPUT_SCHEMA = branchedSchema(
  bodyEnvelopeSchema({
    key: STRING_SCHEMA,
    value: JSON_VALUE_SCHEMA,
    settingsPrecondition: settingsLaneArmSchema(),
    settingsImportPrecondition: settingsLaneArmSchema(),
  }),
  [
    requirementBranch({ key: STRING_SCHEMA, value: JSON_VALUE_SCHEMA }, ['key', 'value']),
    requirementBranch({ settingsPrecondition: settingsLaneArmSchema() }, ['settingsPrecondition']),
    requirementBranch({ settingsImportPrecondition: settingsLaneArmSchema() }, ['settingsImportPrecondition']),
  ],
);

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
    description: 'Create a local auth user.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'POST', path: '/api/local-auth/users' },
    inputSchema: bodyEnvelopeSchema({
      username: STRING_SCHEMA,
      password: STRING_SCHEMA,
    }, ['username', 'password']),
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
    description: 'Request that a panel be opened in the current TUI session.',
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
    description: 'Write one config value on the daemon: `{ key, value }`, where value is any JSON the key accepts. The response reports the value the host now holds and which file and tier it is in; a value that did not take is refused with what the host holds instead. A key that holds a credential takes only a goodvibes://secrets/ reference (store the secret with credentials.set); runtime.workingDir swaps the workspace. The same route also serves the settings clients\' two-step lanes, `{ settingsPrecondition }` and `{ settingsImportPrecondition }` (capture, then apply the returned reference), which answer with that lane\'s own object.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    http: { method: 'POST', path: '/config' },
    inputSchema: CONFIG_SET_INPUT_SCHEMA,
    outputSchema: CONFIG_SET_OUTPUT_SCHEMA,
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
