/**
 * operator-contract-schemas-authority.ts
 *
 * Input/output JSON schemas for authority.status: the head of this daemon's
 * authority record (which keys, credentials and grants are current) and how
 * many entries of each kind are live or revoked. Never a value.
 * Handler: routes/authority-status.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

/** authority.status takes no arguments. */
export const AUTHORITY_STATUS_INPUT_SCHEMA = objectSchema({}, []);

const AUTHORITY_KIND_COUNT_SCHEMA = objectSchema(
  { kind: STRING_SCHEMA, live: NUMBER_SCHEMA, revoked: NUMBER_SCHEMA },
  ['kind', 'live', 'revoked'],
);

/** One username held by separate accounts made on different machines before they joined one group. */
const AUTHORITY_USER_CONFLICT_SCHEMA = objectSchema(
  { username: STRING_SCHEMA, accounts: NUMBER_SCHEMA, madeOn: arraySchema(STRING_SCHEMA) },
  ['username', 'accounts', 'madeOn'],
);

export const AUTHORITY_STATUS_OUTPUT_SCHEMA = objectSchema(
  {
    /** False when the record file exists and cannot be read: nothing authenticates from it until it can. */
    readable: BOOLEAN_SCHEMA,
    nodeId: STRING_SCHEMA,
    /** The group this record belongs to, or empty for a daemon in no group. */
    groupId: STRING_SCHEMA,
    revision: NUMBER_SCHEMA,
    digest: STRING_SCHEMA,
    revocationFloor: NUMBER_SCHEMA,
    kinds: arraySchema(AUTHORITY_KIND_COUNT_SCHEMA),
    /** Group members whose last gossiped record differs from this one (empty outside a group). */
    behindOn: arraySchema(STRING_SCHEMA),
    /** True when another member has gossiped a newer record than this one. */
    behind: BOOLEAN_SCHEMA,
    /**
     * Usernames held by separate accounts made on different machines before
     * they joined one group. Never merged silently: each machine keeps its own
     * account, and changes to it stay on that machine.
     */
    userConflicts: arraySchema(AUTHORITY_USER_CONFLICT_SCHEMA),
  },
  ['readable', 'nodeId', 'groupId', 'revision', 'digest', 'revocationFloor', 'kinds', 'behindOn', 'behind', 'userConflicts'],
);
