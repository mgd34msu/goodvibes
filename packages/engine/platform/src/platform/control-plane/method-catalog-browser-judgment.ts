import { BROWSER_JUDGMENT_PATH, BROWSER_JUDGMENT_BATTERY_VERSIONS, type BrowserJudgmentBatteryId } from '@goodvibes-jev/engine/daemon-api';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import { methodDescriptor, objectSchema, arraySchema, STRING_SCHEMA, NUMBER_SCHEMA, BOOLEAN_SCHEMA } from './method-catalog-shared.js';

const literal = (value: string | number) => ({ type: typeof value, enum: [value] });
const ref = { type: 'string', minLength: 1, maxLength: 256 };
const providerKeys = objectSchema({
  providerId: { type: 'string', minLength: 1, maxLength: 128 },
  keys: { ...arraySchema(ref), minItems: 1, maxItems: 64 },
}, ['providerId', 'keys']);
const matches = objectSchema({ matches: arraySchema(BOOLEAN_SCHEMA) }, ['matches']);
/** Each battery's input and settled value, side by side so the two can never be paired up wrongly. */
const batteries: readonly (readonly [BrowserJudgmentBatteryId, Record<string, unknown>, Record<string, unknown>])[] = [
  ['webui.models.catalog-provider-match', providerKeys, matches],
];
const envelope = (battery: BrowserJudgmentBatteryId, input: Record<string, unknown>) => objectSchema({
  protocolVersion: literal(1), requestId: { ...STRING_SCHEMA, format: 'uuid' }, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), input,
}, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'input']);
const outcomes = { type: 'string', enum: ['act', 'confirm', 'escalate'] };
const p = { type: 'number', minimum: 0, maximum: 1 };
const readings = { type: 'object', additionalProperties:
  objectSchema({ kind: literal('yes-no'), probability: p, verdict: { type: 'string', enum: ['yes', 'no', 'uncertain'] }, outcome: outcomes }, ['kind', 'probability', 'verdict', 'outcome']),
};
const evidence = arraySchema(objectSchema({
  decisionId: STRING_SCHEMA, model: STRING_SCHEMA, requestedModel: STRING_SCHEMA,
  usage: objectSchema({ inputTokens: NUMBER_SCHEMA, outputTokens: NUMBER_SCHEMA }, ['inputTokens', 'outputTokens']), latencyMs: NUMBER_SCHEMA,
}, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']));
const output = (battery: BrowserJudgmentBatteryId, value: Record<string, unknown>) => ({ anyOf: [
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), status: literal('settled'), value, readings, outcome: outcomes, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'value', 'readings', 'outcome', 'evidence']),
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), status: literal('held'), reason: literal('uncertain'), readings, outcome: { type: 'string', enum: ['confirm', 'escalate'] }, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'reason', 'readings', 'outcome', 'evidence']),
] });

export const builtinBrowserJudgmentMethodDescriptors = [methodDescriptor({
  id: 'judgment.battery.run', effects: ['judgment.write', 'outward.send'], title: 'Run Browser Judgment Battery', category: 'judgment',
  replay: IDEMPOTENCY_KEY_REPLAY,
  description: 'Run one explicitly installed, authorized browser battery. Unconfigured services and unresolved or unauthorized input remain held.',
  transport: ['http'], invokable: false,
  http: { method: 'POST', path: BROWSER_JUDGMENT_PATH },
  inputSchema: { anyOf: batteries.map(([battery, input]) => envelope(battery, input)) },
  outputSchema: { anyOf: batteries.map(([battery, , value]) => output(battery, value)) },
  metadata: { directHttpOnly: true, retry: false, protocolVersion: 1 },
})];
