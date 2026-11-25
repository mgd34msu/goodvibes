/**
 * method-catalog-capabilities.ts, the two methods every agent, script and
 * screen reaches GoodVibes' capabilities through (handlers:
 * routes/capabilities.ts). Served through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint and the WebSocket `call`
 * frame, like the other methods published for the WebSocket.
 *
 * What a call of `capabilities.run` causes, and what a repeat of it does, is
 * the capability's own: its effects are admitted for the caller when it runs,
 * and find's answer and run's answer say each capability's risk and repeat.
 */
import type { ContractErrorCode } from '../types/foundation-contract.js';
import { BOOLEAN_SCHEMA, JSON_OBJECT_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema, stringEnumSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';

const GROUP = stringEnumSchema(['conversation', 'sessions', 'code', 'work', 'waiting', 'models', 'safety', 'tools', 'memory', 'messages', 'automation', 'devices', 'money', 'system']);

const FOUND_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  does: STRING_SCHEMA,
  group: GROUP,
  runsIn: stringEnumSchema(['daemon', 'session', 'terminal']),
  repeat: stringEnumSchema(['safe', 'unsafe']),
  inputs: arraySchema(objectSchema({
    name: STRING_SCHEMA, kind: STRING_SCHEMA, required: BOOLEAN_SCHEMA, about: STRING_SCHEMA,
    choices: arraySchema(STRING_SCHEMA), default: STRING_SCHEMA,
  }, ['name', 'kind', 'required', 'about'])),
  risk: STRING_SCHEMA,
}, ['id', 'does', 'group', 'runsIn', 'inputs', 'risk']);

const NOT_FOUND: ContractErrorCode = { code: 'CAPABILITY_NOT_FOUND', status: 404, meaning: 'No capability has this id; capabilities.find names the ones that do what is needed.' };
const INVALID: ContractErrorCode = { code: 'CAPABILITY_INPUT_INVALID', status: 400, meaning: 'An input is unknown, missing or not one of its choices; the message names it and nothing ran.' };
const ELSEWHERE: ContractErrorCode = { code: 'CAPABILITY_ELSEWHERE', status: 409, meaning: 'The capability acts on a conversation (it runs in the program holding it), or it has not moved to the daemon yet and runs only in a terminal program; the message says where, and nothing ran.' };
const REFUSED: ContractErrorCode = { code: 'CAPABILITY_REFUSED', status: 422, meaning: 'The capability ran and did not do what was asked (no hook by that name, nothing to store); the message says what is true and what to do.' };
const NOT_APPROVED: ContractErrorCode = { code: 'CAPABILITY_NOT_APPROVED', status: 403, meaning: 'Asked of the owner under his mode and not approved (or nobody could be asked); nothing ran.' };

export const CAPABILITY_FIND_METHOD_ID = 'capabilities.find';
export const CAPABILITY_RUN_METHOD_ID = 'capabilities.run';

export const builtinGatewayCapabilityMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: CAPABILITY_FIND_METHOD_ID,
    title: 'Find A Capability',
    description: 'What the caller needs, in words, in; three to five capabilities out, never the whole list. Step one picks the function group (the decision model when one is usable, keyword ranking otherwise); step two ranks the capabilities of that group, and of the nearest group when the best match is weak. Each comes with its id, one line on what it does, where it runs (daemon: here; session: in the program holding a conversation; terminal: only inside a terminal program for now), what a repeat does, its inputs (name, kind, required, choices, default) and its risk. Nothing runs.',
    category: 'capabilities',
    effects: ['control-plane.read'],
    transport: ['ws'],
    inputSchema: objectSchema({ need: STRING_SCHEMA }, ['need']),
    outputSchema: objectSchema({
      need: STRING_SCHEMA, group: GROUP, groupChosenBy: stringEnumSchema(['decision', 'classic']), capabilities: arraySchema(FOUND_SCHEMA),
    }, ['need', 'group', 'groupChosenBy', 'capabilities']),
  }),
  methodDescriptor({
    id: CAPABILITY_RUN_METHOD_ID,
    // The capability being run decides: a read repeats safely, a change may act again; its own repeat is in the answer.
    repeat: 'unsafe',
    title: 'Run A Capability',
    description: 'Runs one capability by id with its inputs (names and values as capabilities.find lists them), as the same act would run from any other source: the inputs are checked against its definition, its effects are admitted for the caller, and then a person\'s own request (a sign-in, a paired device or an app on this machine stating a person asked) runs at once, a call the Agent makes after its own gate admitted it runs, and any other caller\'s call is decided under the owner\'s permission mode (an act that loosens a protection or cannot be undone is put to the owner and opens on No). A capability with its own method runs through that method. workingDirectory is the caller\'s project (a hooks file, a project secret store); program is the terminal program asking (tui or agent); model is the model that program\'s conversation uses (provider:model), which a capability on that conversation\'s model (its context window size) acts on unless its inputs name another. The answer is the text a person reads (detail: the capability\'s own words without its done line), the facts a script reads (never a secret value), the risk and what a repeat of this capability does.',
    category: 'capabilities',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({
      id: STRING_SCHEMA,
      inputs: JSON_OBJECT_SCHEMA,
      workingDirectory: STRING_SCHEMA,
      program: stringEnumSchema(['tui', 'agent']),
      model: STRING_SCHEMA,
    }, ['id']),
    outputSchema: objectSchema({
      id: STRING_SCHEMA, ok: BOOLEAN_SCHEMA, text: STRING_SCHEMA, detail: STRING_SCHEMA, data: JSON_OBJECT_SCHEMA, risk: STRING_SCHEMA,
      repeat: stringEnumSchema(['safe', 'unsafe']), method: STRING_SCHEMA,
    }, ['id', 'ok', 'text', 'risk']),
    errorCodes: [NOT_FOUND, INVALID, ELSEWHERE, REFUSED, NOT_APPROVED],
  }),
];

export const CAPABILITY_METHOD_IDS: readonly string[] = [CAPABILITY_FIND_METHOD_ID, CAPABILITY_RUN_METHOD_ID];
