import { arraySchema, BOOLEAN_SCHEMA, EMPTY_OBJECT_SCHEMA, stringEnumSchema, methodDescriptor, objectSchema, STRING_SCHEMA } from './method-catalog-shared.js';
const STATUS = objectSchema({
  ownership: stringEnumSchema(['local', 'other-process', 'migration-required', 'unclaimed']), migrationRequired: BOOLEAN_SCHEMA,
  records: arraySchema(objectSchema({ id: STRING_SCHEMA, label: STRING_SCHEMA, kind: STRING_SCHEMA, state: STRING_SCHEMA }, ['id', 'label', 'kind', 'state'])),
  message: STRING_SCHEMA,
}, ['ownership', 'migrationRequired', 'records', 'message']);
export const builtinTriggerSupervisorMethodDescriptors = [
  methodDescriptor({ id: 'watchers.triggers.status', title: 'Inspect trigger execution and migration',
    description: 'Read the original surface trigger supervisor and affected record summaries without claiming execution ownership or migrating saved state.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'], inputSchema: EMPTY_OBJECT_SCHEMA, outputSchema: STATUS }),
  methodDescriptor({ id: 'watchers.triggers.migrate', title: 'Migrate triggers after closing older instances',
    description: 'Explicitly acknowledge that older GoodVibes instances are closed, then migrate and start this surface’s original trigger supervisor. The acknowledgement is an operator statement, not OS liveness proof.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['write:watchers'], dangerous: true,
    inputSchema: objectSchema({ olderInstancesClosed: { type: 'boolean', const: true }, confirm: { type: 'boolean', const: true } }, ['olderInstancesClosed', 'confirm']),
    outputSchema: objectSchema({ migrated: { type: 'boolean', const: true }, status: STATUS }, ['migrated', 'status']) }),
] as const;
