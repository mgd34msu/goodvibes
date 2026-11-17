import { arraySchema, EMPTY_OBJECT_SCHEMA, JSON_OBJECT_SCHEMA, NUMBER_SCHEMA, stringEnumSchema, methodDescriptor, objectSchema, STRING_SCHEMA } from './method-catalog-shared.js';
const OWNERSHIP = stringEnumSchema(['local', 'other-process', 'unclaimed']);
const STATUS = objectSchema({
  ownership: OWNERSHIP,
  records: arraySchema(objectSchema({ id: STRING_SCHEMA, label: STRING_SCHEMA, kind: STRING_SCHEMA, state: STRING_SCHEMA }, ['id', 'label', 'kind', 'state'])),
  message: STRING_SCHEMA,
}, ['ownership', 'records', 'message']);
/** One trigger as `summarizeTrigger` describes it (never its observations or a command's output). */
const TRIGGER = objectSchema({
  id: STRING_SCHEMA, label: STRING_SCHEMA, kind: STRING_SCHEMA, watching: STRING_SCHEMA, state: STRING_SCHEMA, firedCount: NUMBER_SCHEMA,
  lastFiredAt: STRING_SCHEMA, nextCheckAt: STRING_SCHEMA, lastError: STRING_SCHEMA, droppedLines: NUMBER_SCHEMA, owedBatches: NUMBER_SCHEMA, next: STRING_SCHEMA,
}, ['id', 'label', 'kind', 'watching', 'state', 'firedCount']);
const ONE_TRIGGER = objectSchema({ trigger: TRIGGER }, ['trigger']);
const BY_ID = objectSchema({ id: STRING_SCHEMA }, ['id']);
const GRANT = objectSchema({
  id: STRING_SCHEMA, description: STRING_SCHEMA, command: STRING_SCHEMA, args: arraySchema(STRING_SCHEMA), cwd: STRING_SCHEMA,
  digest: STRING_SCHEMA, confirmedBy: STRING_SCHEMA, confirmedAt: STRING_SCHEMA,
}, ['id', 'description', 'command', 'args', 'digest', 'confirmedBy', 'confirmedAt']);
const TRIGGER_ERRORS = [
  { code: 'TRIGGER_OPERATOR_REQUIRED', status: 403, meaning: 'The caller is not an administrative operator with watcher access; call with the owner\'s operator credential.' },
  { code: 'TRIGGER_NOT_FOUND', status: 404, meaning: 'No trigger has that id; list the triggers to see their ids.' },
  { code: 'TRIGGER_EXISTS', status: 409, meaning: 'A trigger with that id exists; pick another id or cancel the existing one first.' },
  { code: 'TRIGGERS_OFF', status: 409, meaning: 'The trigger family is off; set watchers.triggers.enabled to true and try again.' },
  { code: 'TRIGGER_RESET_REFUSED', status: 409, meaning: 'The trigger is not stopped by its breaker, so there is nothing to reset; list the triggers to see its state.' },
  { code: 'TRIGGER_DEFINITION_INVALID', status: 400, meaning: 'A field of the definition or grant was refused; the message names it. Fix it and send again.' },
  { code: 'TRIGGER_OTHER_PROCESS', status: 409, meaning: 'Another GoodVibes process supervises these triggers; change them from that process, or close it so this one takes over.' },
  { code: 'TRIGGER_GRANT_CHANGED', status: 409, meaning: 'The named grant no longer matches what the trigger was approved for; register the grant again and recreate the trigger.' },
];
export const builtinTriggerSupervisorMethodDescriptors = [
  methodDescriptor({ id: 'watchers.triggers.status', title: 'Inspect supervised triggers',
    description: 'Read the surface trigger supervisor and affected record summaries without claiming execution ownership.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'], inputSchema: EMPTY_OBJECT_SCHEMA, outputSchema: STATUS }),
] as const;
/** The trigger operations (one set, `triggers/operations.ts`): the agent tool of an app that leaves triggers to the daemon calls these. */
export const builtinTriggerOperationMethodDescriptors = [
  methodDescriptor({ id: 'watchers.triggers.list', title: 'List triggers',
    description: 'List the supervised triggers: id, label, kind, what each watches, state, how often it fired and its last error.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'], inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({ ownership: OWNERSHIP, triggers: arraySchema(TRIGGER) }, ['ownership', 'triggers']) }),
  methodDescriptor({ id: 'watchers.triggers.history', title: 'Read a trigger\'s runs',
    description: 'The newest runs of one trigger (default 20, at most 200): when, outcome, detail and how a watched command ended.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'],
    inputSchema: objectSchema({ id: STRING_SCHEMA, limit: NUMBER_SCHEMA }, ['id']),
    outputSchema: objectSchema({ trigger: TRIGGER, runs: arraySchema(JSON_OBJECT_SCHEMA) }, ['trigger', 'runs']), errorCodes: TRIGGER_ERRORS }),
  methodDescriptor({ id: 'watchers.triggers.create', title: 'Create a trigger',
    description: 'Create a trigger from a definition { id, label, description?, spec, action?, ownerSessionId? }. spec.kind is on-exit, stream or condition; commands are argv, never a shell line. The action defaults to an agent turn; an action-grant action names a grant the owner registered. Needs watchers.triggers.enabled.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['write:watchers'],
    inputSchema: objectSchema({ definition: JSON_OBJECT_SCHEMA }, ['definition']), outputSchema: ONE_TRIGGER, errorCodes: TRIGGER_ERRORS }),
  methodDescriptor({ id: 'watchers.triggers.cancel', title: 'Cancel a trigger',
    description: 'Cancel a trigger; a command an on-exit trigger supervises is stopped.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['write:watchers'], inputSchema: BY_ID, outputSchema: ONE_TRIGGER, errorCodes: TRIGGER_ERRORS }),
  methodDescriptor({ id: 'watchers.triggers.reset', title: 'Reset a trigger\'s breaker',
    description: 'Close the breaker of a trigger that stopped after repeated failures, once the cause is fixed. Refused, with the reason, when the trigger is not stopped.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['write:watchers'], inputSchema: BY_ID, outputSchema: ONE_TRIGGER, errorCodes: TRIGGER_ERRORS }),
  methodDescriptor({ id: 'watchers.triggers.grant.list', title: 'List trigger action grants',
    description: 'The commands the owner approved for triggers to run when they fire, with the digest a trigger names.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'], inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({ grants: arraySchema(GRANT) }, ['grants']) }),
  methodDescriptor({ id: 'watchers.triggers.grant.register', title: 'Approve a command for triggers',
    description: 'The owner approves one command (argv, optional working directory) that a trigger may run when it fires. Only the owner registers a grant; a caller that declares it is not a user request is refused. Re-registering the same command keeps its digest.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['write:watchers'], dangerous: true, ownerOnly: true,
    inputSchema: objectSchema({ id: STRING_SCHEMA, description: STRING_SCHEMA, command: STRING_SCHEMA, args: arraySchema(STRING_SCHEMA), cwd: STRING_SCHEMA }, ['id', 'description', 'command']),
    outputSchema: objectSchema({ grant: GRANT }, ['grant']), errorCodes: TRIGGER_ERRORS }),
] as const;
