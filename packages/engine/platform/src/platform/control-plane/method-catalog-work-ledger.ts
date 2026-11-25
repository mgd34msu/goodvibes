import { JEV_DECISION_SCHEMA } from '@goodvibes/judgment/decisions';
import { array, boolean, literal, union, enum as enumSchema, number, strictObject, string, type z } from 'zod/v4';
import { ledgerWorkSchema, ledgerAttemptSchema, ledgerEvidenceSchema, workLedgerReadEventSchema, ledgerEventSchema, legacyWorkLedgerManifestSchema } from '../workflow/work-ledger/types.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';
import { workLedgerJsonSchema as json, LEGACY_WORK_LEDGER_MANIFEST_JSON_SCHEMA as manifestJsonSchema } from './work-ledger-json-schema.js';

/** Dedicated capability. Never reuse fleet, workspace, or generic event scopes. */
export const WORK_LEDGER_READ_SCOPE = 'read:work-ledger';
export const WORK_LEDGER_IMPORT_SCOPE = 'write:work-ledger-import';
export const WORK_LEDGER_HISTORY_PAGE_SIZE = 100;
export const WORK_LEDGER_READ_MAX_BYTES = 1_048_576;
const sequence = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectId = string().min(1).max(200);
const readView = strictObject({
  work: ledgerWorkSchema,
  attempt: ledgerAttemptSchema.nullable(),
  verification: strictObject({
    state: enumSchema(['unverified', 'verified', 'failed', 'unavailable', 'stale']),
    reason: string(),
    evidence: ledgerEvidenceSchema.nullable(),
  }),
  attention: array(strictObject({ kind: enumSchema(['blocked', 'verification']), reason: string() })),
});
export const workLedgerReadSnapshotSchema = strictObject({
  projectId, revision: sequence, cursor: sequence, provenance: enumSchema(['available', 'requires_read_knowledge']).optional(), works: array(readView),
});
export const workLedgerHistoryPageSchema = strictObject({
  projectId, afterSequence: sequence, cursor: sequence, throughSequence: sequence, provenance: enumSchema(['available', 'requires_read_knowledge']).optional(),
  hasMore: boolean(), events: array(workLedgerReadEventSchema).max(WORK_LEDGER_HISTORY_PAGE_SIZE),
});
export type WorkLedgerHistoryPage = z.infer<typeof workLedgerHistoryPageSchema>;
export const builtinGatewayWorkLedgerMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workLedger.prepareLegacyImport', title: 'Prepare Legacy Work Import', category: 'work-ledger',
    description: 'Capture bounded complete legacy sources on the selected authoritative host, plus every work-plan task of the project (the host adds those). Preparation does not write or grant execution authority.',
    effects: ['work-ledger.inspect', 'knowledge.inspect'],
    http: { method: 'POST', path: '/api/work-ledger/legacy-import/prepare' },
    inputSchema: json(strictObject({ projectId, sourceIds: array(string().min(1).max(200)).max(500) }), 'input'),
    outputSchema: json(union([
      strictObject({ kind: literal('prepared'), manifest: legacyWorkLedgerManifestSchema }),
      strictObject({ kind: literal('blocked'), code: string(), reason: string() }),
    ])),
  }),
  methodDescriptor({
    id: 'workLedger.importLegacy', title: 'Import Legacy Work Atomically', category: 'work-ledger',
    description: 'Import one exact versioned legacy manifest only after fresh recorded autonomous admission under paired authority. Durable exact-request replay bypasses new evaluation. Preserves source records and grants no execution or verification authority.',
    effects: ['work-ledger-import.administer', 'knowledge.inspect'],
    http: { method: 'POST', path: '/api/work-ledger/legacy-import' },
    replay: { in: 'body', name: 'requestId', behavior: 'Sending the same requestId again replays the durable result without a new admission evaluation.' },
    inputSchema: { type: 'object', additionalProperties: false, required: ['type','requestId','expectedRevision','manifest'],
      properties: { type: { type: 'string', enum: ['import_legacy'] }, requestId: { type: 'string', minLength: 1, maxLength: 200 }, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, manifest: manifestJsonSchema } },
    outputSchema: { anyOf: [json(union([
      strictObject({ kind: literal('accepted'), replayed: boolean(), event: ledgerEventSchema }),
      strictObject({ kind: literal('rejected'), code: string(), reason: string(), revision: sequence.nullable() }),
      strictObject({ kind: literal('indeterminate'), requestId: projectId, actorId: projectId, reason: string() }),
    ])), { type: 'object', additionalProperties: false, required: ['kind', 'decision'],
      properties: { kind: { type: 'string', enum: ['decision'] }, decision: { oneOf: JEV_DECISION_SCHEMA.oneOf.filter(variant => variant.properties.outcome.const !== 'act') } } }] },
  }),
  methodDescriptor({
    id: 'workLedger.snapshot', title: 'Read Native Work Ledger', category: 'work-ledger',
    description: 'Read the selected host project ledger, without mutation authority or allowedActions. Requires an owner operator and the dedicated read scope.',
    effects: ['work-ledger.inspect'],
    http: { method: 'GET', path: '/api/work-ledger/snapshot' },
    inputSchema: json(strictObject({ projectId }), 'input'), outputSchema: json(workLedgerReadSnapshotSchema),
  }),
  methodDescriptor({
    id: 'work.list', title: 'List Your Work', category: 'work-ledger',
    description: 'Every piece of work of this daemon\'s project, read in one call: what it is, what done means, where it stands (not started, starting, running, needs you, done, failed, stopped), its plan as steps with their state, the questions it waits on, its spending limit and its results. What the Work place, the web Work view and an agent read. No mutation and no execution.',
    effects: ['work-ledger.inspect'],
    http: { method: 'GET', path: '/api/work' },
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', additionalProperties: false, required: ['projectId', 'works'], properties: {
      projectId: { type: 'string' },
      works: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['id', 'title', 'state'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, state: { type: 'string' },
        criteria: { type: 'array', items: { type: 'string' } },
      } } },
    } },
  }),
  methodDescriptor({
    id: 'work.target', title: 'Name A Piece Of Work For An Act', category: 'work-ledger',
    description: 'Read what an act on one piece of work sends, from the work alone: `operation` "execution" answers the identity start, status, stop and resume take (its current attempt and revisions); "contract" answers the run that answering, running a step again and the spending limit act on. Every other field is passed through. Answers { summary, input }; nothing is kept.',
    effects: ['work-ledger.inspect'],
    http: { method: 'POST', path: '/api/work/target' },
    inputSchema: { type: 'object', additionalProperties: true, required: ['work', 'operation'], properties: {
      work: { type: 'string', minLength: 1, maxLength: 200 }, operation: { type: 'string', enum: ['execution', 'contract'] }, zone: { type: 'string' },
    } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['summary', 'input'], properties: {
      summary: { type: 'string' }, title: { type: 'string' }, input: { type: 'object', additionalProperties: true },
    } },
  }),
  ...([
    ['redo', 'Write A Plan Again', 'Write the waiting plan of a piece of work again from its goal and what done means (the planning agent splits it into steps again). It waits for approval again.', { }, ['work']],
    ['step.edit', 'Change A Step Of A Plan', 'Change what one step of a waiting plan does. The plan waits for approval again.', { step: { type: 'string', minLength: 1 }, brief: { type: 'string', minLength: 1 } }, ['work', 'step', 'brief']],
    ['step.drop', 'Take A Step Out Of A Plan', 'Take one step out of a waiting plan (and out of what the other steps wait on); the last step stays. The plan waits for approval again.', { step: { type: 'string', minLength: 1 } }, ['work', 'step']],
    ['step.move', 'Move A Step Of A Plan', 'Move one step of a waiting plan to another place, counting from 1. The plan waits for approval again.', { step: { type: 'string', minLength: 1 }, position: { type: 'integer', minimum: 1 } }, ['work', 'step', 'position']],
    ['approve', 'Approve A Plan', 'Mark the waiting plan of a piece of work approved: its next start runs with exactly these steps.', { }, ['work']],
    ['discard', 'Throw A Plan Away', 'Throw away the waiting plan of a piece of work; the work stays, not started, and its next start writes a new plan.', { }, ['work']],
  ] as const).map(([operation, title, description, properties, required]) => methodDescriptor({
    id: `work.plan.${operation}`, title, description, category: 'work-ledger',
    effects: ['work-ledger.inspect', 'work-ledger.administer'],
    repeat: operation === 'redo' ? 'unsafe' : 'safe',
    http: { method: 'POST', path: `/api/work/plan/${operation.replace('.', '/')}` },
    inputSchema: { type: 'object', additionalProperties: false, required: [...required], properties: { work: { type: 'string', minLength: 1, maxLength: 200 }, ...properties } },
    outputSchema: { type: 'object', additionalProperties: true, properties: { title: { type: 'string' } } },
  })),
  methodDescriptor({
    id: 'workLedger.history', title: 'Read Native Work Ledger History', category: 'work-ledger',
    description: 'Read at most 100 events after an exclusive cursor, pinned to a history high-water mark. Advance with cursor while hasMore is true. No mutations or execution.',
    effects: ['work-ledger.inspect'],
    http: { method: 'GET', path: '/api/work-ledger/history' },
    inputSchema: json(strictObject({ projectId, afterSequence: sequence, throughSequence: sequence.optional() }), 'input'),
    outputSchema: json(workLedgerHistoryPageSchema),
  }),
];
