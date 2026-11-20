/**
 * method-catalog-authority.ts
 *
 * The authority.status descriptor: the head of the authority record, the one
 * record every node answers "is this credential current" from. Handler:
 * routes/authority-status.ts, registered by the runtime graph that owns the
 * record file.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { AUTHORITY_STATUS_INPUT_SCHEMA, AUTHORITY_STATUS_OUTPUT_SCHEMA } from './operator-contract-schemas-authority.js';

export const builtinGatewayAuthorityMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'authority.status',
    title: 'Authority Record Status',
    description:
      'Return the head of this daemon\'s authority record: the record every machine of a group answers "is this device token, user, grant or peer token current" from. revision and digest are equal on every machine that holds the same record; behind is true when another group member has gossiped a newer one, and behindOn names the members whose record differs. kinds counts the live and revoked entries of each kind. userConflicts names each username held by separate accounts made on different machines before they joined one group: neither is overwritten, each machine keeps its own, and changes to it stay on that machine. Never returns a credential or a hash. readable false means the record file exists and cannot be read: nothing authenticates from it until it can.',
    category: 'authority',
    scopes: ['read:config'],
    access: 'admin',
    http: { method: 'GET', path: '/api/authority/status' },
    inputSchema: AUTHORITY_STATUS_INPUT_SCHEMA,
    outputSchema: AUTHORITY_STATUS_OUTPUT_SCHEMA,
  }),
];
