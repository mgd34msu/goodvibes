/**
 * method-catalog-permission-rules.ts
 *
 * The permissions.rules.list / permissions.rules.delete descriptors, the
 * settings-domain surface over durable user-origin permission rules (the
 * persistent form of remembered approval decisions). ws-only invoke verbs (no
 * REST binding), registered from the same composition root as the other verb
 * groups (routes/register-gateway-verb-groups.ts). Handlers:
 * routes/permission-rules.ts.
 *
 * They carry the approval scopes, the same ones that gate answering the ask
 * that wrote a rule: a token allowed only to chat in a session can neither
 * read the standing grants and denials nor remove one.
 */

import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  PERMISSION_RULES_DELETE_INPUT_SCHEMA,
  PERMISSION_RULES_DELETE_OUTPUT_SCHEMA,
  PERMISSION_RULES_LIST_INPUT_SCHEMA,
  PERMISSION_RULES_LIST_OUTPUT_SCHEMA,
} from './operator-contract-schemas-permissions.js';

export const builtinGatewayPermissionRuleMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'permissions.rules.list',
    title: 'List Durable Permission Rules',
    description: 'List the durable user-origin permission rules written by remembered approval decisions (exact command / command class / path scope / whole tool), newest first, the persistent grants and denials the permission manager consults before ever prompting. Project-scoped: with `project` (a folder), only the rules in force there, that project\'s own and those of every project; without it, every rule with the project it belongs to.',
    category: 'permissions',
    effects: ['approvals.read'],
    transport: ['ws'],
    notWorkFolders: { project: 'the project a list of the owner\'s rules is filtered by (a read his approvals scope admits); nothing works in it' },
    inputSchema: PERMISSION_RULES_LIST_INPUT_SCHEMA,
    outputSchema: PERMISSION_RULES_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'permissions.rules.delete',
    repeat: 'safe',
    effects: ['approvals.write', 'model.refused'],
    title: 'Delete a Durable Permission Rule',
    description: 'Delete one durable user-origin permission rule by id. The matching asks prompt again afterwards, deleting a grant is how a remembered decision is revoked. deleted:false when no rule with that id exists (an honest miss, not an error).',
    category: 'permissions',
    transport: ['ws'],
    inputSchema: PERMISSION_RULES_DELETE_INPUT_SCHEMA,
    outputSchema: PERMISSION_RULES_DELETE_OUTPUT_SCHEMA,
  }),
];
