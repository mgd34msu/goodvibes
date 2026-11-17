/**
 * operator-contract-schemas-flags-status.ts
 *
 * Input/output JSON schemas for flags.status: the running daemon's
 * restart-gated features whose saved setting has not taken effect yet.
 * Handler: routes/flags-status.ts.
 */
import {
  STRING_SCHEMA,
  arraySchema,
  enumSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

/** flags.status takes no arguments. */
export const FLAGS_STATUS_INPUT_SCHEMA = objectSchema({}, []);

const FLAG_STATE_SCHEMA = enumSchema(['enabled', 'disabled']);

const FLAG_PENDING_RESTART_SCHEMA = objectSchema(
  {
    featureId: STRING_SCHEMA,
    running: FLAG_STATE_SCHEMA,
    saved: FLAG_STATE_SCHEMA,
  },
  ['featureId', 'running', 'saved'],
);

export const FLAGS_STATUS_OUTPUT_SCHEMA = objectSchema(
  {
    pendingRestart: arraySchema(FLAG_PENDING_RESTART_SCHEMA),
  },
  ['pendingRestart'],
);
