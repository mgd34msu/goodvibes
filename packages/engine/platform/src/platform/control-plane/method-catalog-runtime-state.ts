/**
 * method-catalog-runtime-state.ts, the read of the runtime store for debugging.
 *
 * `runtime.state.get` returns what the daemon's runtime store holds now (the
 * session, conversation, agents, tasks, permissions and other domains) as
 * JSON-safe, credential-masked and size-bounded data. It reads only; nothing
 * is computed until it is called. The terminal apps show their own store the
 * same way with `/state`.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  JSON_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const RUNTIME_STATE_SCHEMA = objectSchema({
  capturedAt: NUMBER_SCHEMA,
  domains: JSON_OBJECT_SCHEMA,
  available: { type: 'array', items: STRING_SCHEMA },
  unknown: { type: 'array', items: STRING_SCHEMA },
  truncated: BOOLEAN_SCHEMA,
}, ['capturedAt', 'domains', 'available', 'unknown', 'truncated']);

export const builtinGatewayRuntimeStateMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'runtime.state.get',
    title: 'Read the Runtime State',
    description:
      'What the daemon\'s runtime store holds now, by domain (session, conversation, agents, tasks, permissions and the rest), '
      + 'for debugging. domains names the ones to read, comma-separated; without it every domain is read, and available lists '
      + 'them all. The data is made safe on the way out: dates are ISO text, errors { name, message }, binary data "<N bytes>"; '
      + 'credential fields read [REDACTED] and owner-profile fields [REDACTED_PROFILE], and credential-shaped text is masked; '
      + 'nesting and total size are bounded, a cut value reads "[Truncated]" and truncated is true. unknown lists asked-for '
      + 'domains the store does not hold. Read-only.',
    category: 'health',
    scopes: ['read:health'],
    // The conversation domain can hold streamed text, so only an operator reads it.
    access: 'admin',
    http: { method: 'GET', path: '/api/runtime/state' },
    inputSchema: objectSchema({ domains: STRING_SCHEMA }, []),
    outputSchema: RUNTIME_STATE_SCHEMA,
  }),
];
