/**
 * method-catalog-policy-audit.ts, the method a terminal program posts the calls its permission gate decided through
 * (handler: routes/policy-audit.ts). The daemon keeps them beside its own decided calls, so "See what the candidate
 * policy changes" (security.simulate-policy) decides every program's calls again, not only the daemon's. Posting is
 * no person's act, so it is a method of its own, as the hook trace's is.
 */
import { BOOLEAN_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema, stringEnumSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';

export const POLICY_AUDIT_POST_METHOD_ID = 'permissions.audit.post';

const DECIDED_CALL_SCHEMA = objectSchema({
  callId: STRING_SCHEMA,
  tool: STRING_SCHEMA,
  category: STRING_SCHEMA,
  approved: BOOLEAN_SCHEMA,
  sourceLayer: STRING_SCHEMA,
  reasonCode: STRING_SCHEMA,
  riskLevel: STRING_SCHEMA,
  classification: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  reasons: arraySchema(STRING_SCHEMA),
  target: STRING_SCHEMA,
  host: STRING_SCHEMA,
  requestedAt: NUMBER_SCHEMA,
  decidedAt: NUMBER_SCHEMA,
}, ['callId', 'tool', 'category', 'riskLevel', 'classification', 'summary', 'requestedAt']);

export const builtinGatewayPolicyAuditMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: POLICY_AUDIT_POST_METHOD_ID,
    // A call already kept (by its id) is kept once.
    repeat: 'safe',
    title: 'Post Decided Calls',
    description: 'A terminal program (the terminal app, the Agent) tells the daemon which calls its permission gate decided: the tool, its kind, its target, how risky, and whether it was allowed. The daemon keeps them beside its own decided calls (the newest 100 in all), so reviewing a candidate policy ("See what the candidate policy changes") decides every program\'s calls again. A call is kept once by its id. Up to 100 calls per post.',
    category: 'permissions',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({
      program: stringEnumSchema(['tui', 'agent']),
      calls: arraySchema(DECIDED_CALL_SCHEMA),
    }, ['program', 'calls']),
    outputSchema: objectSchema({ recorded: NUMBER_SCHEMA, refused: NUMBER_SCHEMA }, ['recorded', 'refused']),
  }),
];
