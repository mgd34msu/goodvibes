import { arraySchema, EMPTY_OBJECT_SCHEMA, stringEnumSchema, methodDescriptor, objectSchema, STRING_SCHEMA } from './method-catalog-shared.js';
const STATUS = objectSchema({
  ownership: stringEnumSchema(['local', 'other-process', 'unclaimed']),
  records: arraySchema(objectSchema({ id: STRING_SCHEMA, label: STRING_SCHEMA, kind: STRING_SCHEMA, state: STRING_SCHEMA }, ['id', 'label', 'kind', 'state'])),
  message: STRING_SCHEMA,
}, ['ownership', 'records', 'message']);
export const builtinTriggerSupervisorMethodDescriptors = [
  methodDescriptor({ id: 'watchers.triggers.status', title: 'Inspect supervised triggers',
    description: 'Read the surface trigger supervisor and affected record summaries without claiming execution ownership.',
    category: 'watchers', transport: ['ws'], access: 'admin', scopes: ['read:watchers'], inputSchema: EMPTY_OBJECT_SCHEMA, outputSchema: STATUS }),
] as const;
