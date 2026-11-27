/**
 * operator-contract-schemas-workspaces.ts
 *
 * Input/output JSON schemas for the shared registered-workspace registry verbs:
 * workspaces.registrations.list / .add / .remove and workspaces.resolve (see
 * platform/workspace/registration/). The registry answers "which registered
 * root, if any, covers this path" for the whole platform; coverage flows down a
 * root's subtree and follows the git worktree→main-repo link. Handlers:
 * routes/workspaces.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

const REGISTERED_WORKSPACE_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    registeredAt: STRING_SCHEMA,
    label: STRING_SCHEMA,
    // Provenance: which surface/flow wrote the record. Absent on records
    // written before provenance existed.
    origin: STRING_SCHEMA,
    // Whether this root is in scope for the automatic checkpoint boundary.
    // ABSENT MEANS FALSE: a plain self-recording never widens another
    // consumer's checkpoint scope; the checkpoint-owning consumer stamps its
    // own roots (re-adding an existing root with this flag upgrades it).
    checkpointEligible: BOOLEAN_SCHEMA,
    // The scope native work runs under, minted when the root is registered (absent on a root registered before
    // native work existed, until it is registered again). The store writes it on every registration, so every
    // answer that carries a record can carry it.
    nativeScope: objectSchema(
      { id: STRING_SCHEMA, canonicalRoot: STRING_SCHEMA, generation: NUMBER_SCHEMA },
      ['id', 'canonicalRoot', 'generation'],
    ),
    // false (in a list) when the folder cannot be reached now: the folder that held it is missing too (a disk not
    // mounted, a parent renamed). Nothing of the project is let go. Absent means reachable.
    reachable: BOOLEAN_SCHEMA,
  },
  ['root', 'registeredAt'],
);

const DECLINED_WORKSPACE_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    declinedAt: STRING_SCHEMA,
  },
  ['root', 'declinedAt'],
);

// ── workspaces.registrations.list ─────────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_LIST_INPUT_SCHEMA = objectSchema({}, []);

// ── workspaces.projects.list ──────────────────────────────────────────────────
export const WORKSPACES_PROJECTS_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const WORKSPACES_PROJECTS_LIST_OUTPUT_SCHEMA = objectSchema(
  {
    projects: arraySchema(objectSchema({ root: STRING_SCHEMA, label: STRING_SCHEMA, daemonFolder: BOOLEAN_SCHEMA, reachable: BOOLEAN_SCHEMA }, ['root', 'daemonFolder'])),
  },
  ['projects'],
);
export const WORKSPACES_REGISTRATIONS_LIST_OUTPUT_SCHEMA = objectSchema(
  {
    workspaces: arraySchema(REGISTERED_WORKSPACE_SCHEMA),
    declines: arraySchema(DECLINED_WORKSPACE_SCHEMA),
  },
  ['workspaces', 'declines'],
);

// ── workspaces.registrations.add ──────────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_ADD_INPUT_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    label: STRING_SCHEMA,
    origin: STRING_SCHEMA,
    checkpointEligible: BOOLEAN_SCHEMA,
  },
  ['root'],
);
export const WORKSPACES_REGISTRATIONS_ADD_OUTPUT_SCHEMA = objectSchema(
  {
    workspace: REGISTERED_WORKSPACE_SCHEMA,
    alreadyRegistered: BOOLEAN_SCHEMA,
    nativeScopeGranted: BOOLEAN_SCHEMA,
  },
  ['workspace', 'alreadyRegistered', 'nativeScopeGranted'],
);

// ── workspaces.registrations.remove ───────────────────────────────────────────
export const WORKSPACES_REGISTRATIONS_REMOVE_INPUT_SCHEMA = objectSchema(
  { root: STRING_SCHEMA },
  ['root'],
);
export const WORKSPACES_REGISTRATIONS_REMOVE_OUTPUT_SCHEMA = objectSchema(
  {
    root: STRING_SCHEMA,
    removed: BOOLEAN_SCHEMA,
  },
  ['root', 'removed'],
);

// ── workspaces.resolve ────────────────────────────────────────────────────────
const COVERAGE_STATUS_SCHEMA = enumSchema(['covered', 'declined', 'unknown']);

export const WORKSPACES_RESOLVE_INPUT_SCHEMA = objectSchema(
  {
    path: STRING_SCHEMA,
    // Optional caller-supplied override for the worktree→main-repo link. When
    // absent the daemon probes it. Present mainly so a caller with the git facts
    // in hand can resolve without a second git spawn.
    mainWorktreeRoot: STRING_SCHEMA,
  },
  ['path'],
);
export const WORKSPACES_RESOLVE_OUTPUT_SCHEMA = objectSchema(
  {
    path: STRING_SCHEMA,
    status: COVERAGE_STATUS_SCHEMA,
    coveredBy: nullableSchema(STRING_SCHEMA),
    declinedRoot: nullableSchema(STRING_SCHEMA),
    viaWorktreeLink: BOOLEAN_SCHEMA,
    reason: STRING_SCHEMA,
  },
  ['path', 'status', 'coveredBy', 'declinedRoot', 'viaWorktreeLink', 'reason'],
);
