/**
 * ops.doctor: find the runbook for a symptom and run its checks against the
 * daemon's live state. A ws-only invoke verb (no REST binding); handler:
 * routes/ops-doctor.ts.
 */
import { methodDescriptor, objectSchema, arraySchema, STRING_SCHEMA, NUMBER_SCHEMA, type GatewayMethodDescriptor } from './method-catalog-shared.js';
import { enumSchema } from './operator-contract-schemas-shared.js';

const DOCTOR_CHECK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  outcome: enumSchema(['pass', 'fail', 'unknown']),
  severity: enumSchema(['info', 'warning', 'error', 'critical']),
  summary: STRING_SCHEMA,
}, ['id', 'label', 'outcome', 'severity', 'summary']);

const DOCTOR_STEP_SCHEMA = objectSchema({
  step: NUMBER_SCHEMA,
  title: STRING_SCHEMA,
  action: STRING_SCHEMA,
  kind: enumSchema(['command', 'config', 'observe', 'wait', 'escalate']),
  command: STRING_SCHEMA,
  expectedOutcome: STRING_SCHEMA,
  automatable: { type: 'boolean' },
}, ['step', 'title', 'action', 'kind', 'automatable']);

export const OPS_DOCTOR_OUTPUT_SCHEMA = objectSchema({
  symptom: STRING_SCHEMA,
  playbooks: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    name: STRING_SCHEMA,
    checks: arraySchema(DOCTOR_CHECK_SCHEMA),
    steps: arraySchema(DOCTOR_STEP_SCHEMA),
  }, ['id', 'name', 'checks', 'steps'])),
  available: arraySchema(objectSchema({ id: STRING_SCHEMA, name: STRING_SCHEMA }, ['id', 'name'])),
}, ['symptom', 'playbooks', 'available']);

export const builtinGatewayOpsDoctorMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'ops.doctor',
    title: 'Diagnose a Symptom',
    description: 'Find the runbook for a symptom in plain words (for example "stuck turn", "mcp keeps disconnecting", "approval never answered", "compaction failed") and run its checks against the daemon\'s live state. Each check is pass, fail or unknown (it could not look), with a one-line summary; each runbook lists the next steps as real commands. Read-only, no model request. An empty `playbooks` means nothing matched; `available` lists what can be diagnosed.',
    category: 'health',
    effects: ['health.read'],
    transport: ['ws'],
    inputSchema: objectSchema({ symptom: STRING_SCHEMA }, ['symptom']),
    outputSchema: OPS_DOCTOR_OUTPUT_SCHEMA,
  }),
];
