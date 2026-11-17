import { BROWSER_JUDGMENT_PATH, BROWSER_JUDGMENT_BATTERY_VERSIONS, type BrowserJudgmentBatteryId, WEBUI_CODE_LANGUAGES } from '@goodvibes-jev/engine/daemon-api';
import { methodDescriptor, objectSchema, arraySchema, STRING_SCHEMA, NUMBER_SCHEMA, BOOLEAN_SCHEMA } from './method-catalog-shared.js';

const literal = (value: string | number) => ({ type: typeof value, enum: [value] });
const ref = { type: 'string', minLength: 1, maxLength: 256 };
const candidate = { anyOf: [
  objectSchema({ kind: literal('builtin'), commandId: ref }, ['kind', 'commandId']),
  objectSchema({ kind: literal('chat'), sessionId: ref }, ['kind', 'sessionId']),
] };
const keysOf = (providerScoped: boolean) => objectSchema({
  ...(providerScoped ? { providerId: { type: 'string', minLength: 1, maxLength: 128 } } : {}),
  keys: { ...arraySchema(ref), minItems: 1, maxItems: 64 },
}, providerScoped ? ['providerId', 'keys'] : ['keys']);
const matches = objectSchema({ matches: arraySchema(BOOLEAN_SCHEMA) }, ['matches']);
/** Each battery's input and settled value, side by side so the two can never be paired up wrongly. */
const batteries: readonly (readonly [BrowserJudgmentBatteryId, Record<string, unknown>, Record<string, unknown>])[] = [
  ['webui.voice.speech-seams',
    objectSchema({ sessionId: ref, messageId: ref, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1, maximum: 1_000_000 }, contentRevision: ref, cursor: { type: 'integer', minimum: 0, maximum: 4095, multipleOf: 64 } }, ['sessionId', 'messageId', 'start', 'end', 'contentRevision', 'cursor']),
    objectSchema({ endOffsets: { ...arraySchema({ type: 'integer', minimum: 1, maximum: 32768 }), maxItems: 64 }, nextCursor: { anyOf: [{ type: 'integer', minimum: 64, maximum: 4095 }, { type: 'null' }] } }, ['endOffsets', 'nextCursor'])],
  ['webui.palette.command-rank',
    objectSchema({
      query: { anyOf: [
        objectSchema({ kind: literal('inline'), text: ref }, ['kind', 'text']),
        objectSchema({ kind: literal('reference'), queryRef: ref }, ['kind', 'queryRef']),
      ] },
      registryVersion: ref, candidates: { ...arraySchema(candidate), minItems: 1, maxItems: 64 },
    }, ['query', 'registryVersion', 'candidates']),
    objectSchema({ registryVersion: ref, accepted: arraySchema(objectSchema({ candidateIndex: { type: 'number', minimum: 0, maximum: 63 }, probability: { type: 'number', minimum: 0, maximum: 1 } }, ['candidateIndex', 'probability'])), rejected: arraySchema({ type: 'number', minimum: 0, maximum: 63 }) }, ['registryVersion', 'accepted', 'rejected'])],
  ['webui.models.catalog-provider-match', keysOf(true), matches],
  ['webui.credentials.provider-key', keysOf(true), matches],
  ['webui.settings.card-material-key', keysOf(false), matches],
  ['webui.config.credential-key', keysOf(false), matches],
  ['webui.code.language',
    objectSchema({ sessionId: ref, messageId: ref, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1, maximum: 1_000_000 }, contentRevision: ref }, ['sessionId', 'messageId', 'start', 'end', 'contentRevision']),
    objectSchema({ language: { type: 'string', enum: [...WEBUI_CODE_LANGUAGES] } }, ['language'])],
];
const envelope = (battery: BrowserJudgmentBatteryId, input: Record<string, unknown>) => objectSchema({
  protocolVersion: literal(1), requestId: { ...STRING_SCHEMA, format: 'uuid' }, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), input,
}, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'input']);
const outcomes = { type: 'string', enum: ['act', 'confirm', 'escalate'] };
const p = { type: 'number', minimum: 0, maximum: 1 };
const readings = { type: 'object', additionalProperties: { anyOf: [
  objectSchema({ kind: literal('yes-no'), probability: p, verdict: { type: 'string', enum: ['yes', 'no', 'uncertain'] }, outcome: outcomes }, ['kind', 'probability', 'verdict', 'outcome']),
  objectSchema({ kind: literal('choice'), choice: STRING_SCHEMA, confidence: p, probabilities: { type: 'object', additionalProperties: p }, outcome: outcomes }, ['kind', 'choice', 'confidence', 'probabilities', 'outcome']),
] } };
const evidence = arraySchema(objectSchema({
  decisionId: STRING_SCHEMA, model: STRING_SCHEMA, requestedModel: STRING_SCHEMA,
  usage: objectSchema({ inputTokens: NUMBER_SCHEMA, outputTokens: NUMBER_SCHEMA }, ['inputTokens', 'outputTokens']), latencyMs: NUMBER_SCHEMA,
}, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']));
const output = (battery: BrowserJudgmentBatteryId, value: Record<string, unknown>) => ({ anyOf: [
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), status: literal('settled'), value, readings, outcome: outcomes, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'value', 'readings', 'outcome', 'evidence']),
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(BROWSER_JUDGMENT_BATTERY_VERSIONS[battery]), status: literal('held'), reason: literal('uncertain'), readings, outcome: { type: 'string', enum: ['confirm', 'escalate'] }, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'reason', 'readings', 'outcome', 'evidence']),
] });

export const builtinBrowserJudgmentMethodDescriptors = [methodDescriptor({
  id: 'judgment.battery.run', effect: 'outward', title: 'Run Browser Judgment Battery', category: 'judgment',
  description: 'Run one explicitly installed, authorized browser battery. Unconfigured services and unresolved or unauthorized input remain held.',
  access: 'authenticated', scopes: ['write:judgment'], transport: ['http'], invokable: false,
  http: { method: 'POST', path: BROWSER_JUDGMENT_PATH },
  inputSchema: { anyOf: batteries.map(([battery, input]) => envelope(battery, input)) },
  outputSchema: { anyOf: batteries.map(([battery, , value]) => output(battery, value)) },
  metadata: { directHttpOnly: true, retry: false, protocolVersion: 1 },
})];
