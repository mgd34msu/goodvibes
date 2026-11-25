/**
 * method-catalog-hooks.ts, the method a terminal program posts the hooks it ran
 * through (handler: routes/hook-trace.ts). The trace is read through the
 * capability `hooks.trace` (capabilities/builtin/hooks.ts), like every other
 * hooks act; only the posting, which is no person's act, is a method of its own.
 */
import { BOOLEAN_SCHEMA, JSON_OBJECT_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema, stringEnumSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';

export const HOOK_TRACE_POST_METHOD_ID = 'hooks.trace.post';

const HOOK_RUN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  point: STRING_SCHEMA,
  on: STRING_SCHEMA,
  hook: STRING_SCHEMA,
  type: stringEnumSchema(['command', 'prompt', 'agent', 'http', 'ts']),
  pattern: STRING_SCHEMA,
  ok: BOOLEAN_SCHEMA,
  decision: stringEnumSchema(['allow', 'deny', 'ask']),
  reason: STRING_SCHEMA,
  changedInput: BOOLEAN_SCHEMA,
  addedContext: BOOLEAN_SCHEMA,
  error: STRING_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  background: BOOLEAN_SCHEMA,
  sessionId: STRING_SCHEMA,
}, ['id', 'at', 'point', 'hook', 'type', 'ok']);

export const builtinGatewayHookTraceMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: HOOK_TRACE_POST_METHOD_ID,
    // A run already kept (by its id) is not kept twice.
    repeat: 'safe',
    title: 'Post Hook Runs',
    description: 'A terminal program (the terminal app, the Agent) tells the daemon which hooks it ran: which hook, at which hook point, on what, when, and what it did (let the event go on, refused it, put it to the owner, changed its input, added context, failed). The daemon keeps one trace of every program\'s runs, newest first, and says the list changed (LIST_CHANGED hook-trace); the capability hooks.trace reads it. A run is kept once by its id, so a post sent again changes nothing. Up to 100 runs per post.',
    category: 'hooks',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({
      program: stringEnumSchema(['tui', 'agent']),
      project: STRING_SCHEMA,
      runs: arraySchema(HOOK_RUN_SCHEMA),
    }, ['program', 'runs']),
    outputSchema: objectSchema({ recorded: NUMBER_SCHEMA, refused: NUMBER_SCHEMA, detail: JSON_OBJECT_SCHEMA }, ['recorded', 'refused']),
  }),
];
