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
import { BOOLEAN_SCHEMA, JSON_OBJECT_SCHEMA, JSON_VALUE_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema, stringEnumSchema, type GatewayMethodDescriptor } from './method-catalog-shared.js';
import { OWNER_APPROVAL_PENDING_SCHEMA } from './operator-contract-schemas-admin.js';

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
// A capability's refusal keeps the code of what refused it, and the status that code stands for (routes/capabilities.ts).
const REFUSED: ContractErrorCode = { code: 'CAPABILITY_REFUSED', status: 409, meaning: 'The capability ran and did not do what was asked, for the state it found (nothing to store, a plugin that would not switch); the message says what is true and what to do. Any other code of the capability\'s own (NOT_DONE, TARGET_EXISTS, TURN_RUNNING, a missing sign-in such as GOOGLE_NOT_CONNECTED) answers 409 the same way, with that code.' };
const TARGET_NOT_FOUND: ContractErrorCode = { code: 'NOT_FOUND', status: 404, meaning: 'What the inputs name is not held (a card, a pool, a job by that id); as the method underneath said it, any code ending _NOT_FOUND too. Nothing ran.' };
const INPUT_UNFIT: ContractErrorCode = { code: 'INVALID_ARGUMENT', status: 422, meaning: 'An input is of the right kind and does not fit what the capability found (a date in the past, a name already taken); any code ending _INVALID too. Nothing ran.' };
const UNAVAILABLE: ContractErrorCode = { code: 'UNAVAILABLE', status: 503, meaning: 'This daemon was started without what the capability needs (its knowledge store, its notifier), or cannot read it (a code ending _UNAVAILABLE or _UNREADABLE). Nothing ran.' };
const CONTEXT_MISSING: ContractErrorCode = { code: 'CAPABILITY_CALLER_CONTEXT_MISSING', status: 422, meaning: 'The capability acts in a project folder (or for a program) the call did not name: workingDirectory (or program) is missing. Refused before anything was asked of the owner; nothing ran.' };
const NOT_APPROVED: ContractErrorCode = { code: 'CAPABILITY_NOT_APPROVED', status: 403, meaning: 'Asked of the owner under his mode and not approved (or nobody could be asked); nothing ran.' };
const CALL_NOT_FOUND: ContractErrorCode = { code: 'CAPABILITY_CALL_NOT_FOUND', status: 404, meaning: 'No call put to the owner has this approvalId for this caller (another caller\'s, or not one capabilities.run made); nothing is said about it.' };
const CALLER_GONE: ContractErrorCode = { code: 'CAPABILITY_CALLER_GONE', status: 403, meaning: 'The owner approved a held call, and the caller it was held for is no longer allowed (its operator token replaced, its device unpaired, its sign-in user removed or its sign-in ended); the message names that caller, and nothing ran.' };
const ASK_AGAIN: ContractErrorCode = { code: 'CAPABILITY_ASK_AGAIN', status: 409, meaning: 'The owner approved a held call and it cannot run on that yes: it carried a secret value the daemon never writes down and the daemon restarted, whether its caller is still allowed cannot be told after a restart, or that it started could not be written (it could otherwise run twice). Nothing ran; send the call again and the owner is asked again.' };

export const CAPABILITY_FIND_METHOD_ID = 'capabilities.find';
export const CAPABILITY_RUN_METHOD_ID = 'capabilities.run';
export const CAPABILITY_LIST_METHOD_ID = 'capabilities.list';

/** One capability as a screen draws it: its words, its inputs, where it runs and what undoes it. */
const LISTED_SCHEMA = objectSchema({
  id: STRING_SCHEMA, group: GROUP, runsIn: stringEnumSchema(['daemon', 'session', 'terminal']), repeat: stringEnumSchema(['safe', 'unsafe']),
  command: STRING_SCHEMA, commandTitle: STRING_SCHEMA, actionId: STRING_SCHEMA, word: STRING_SCHEMA, label: STRING_SCHEMA,
  sentence: STRING_SCHEMA, done: STRING_SCHEMA, risk: STRING_SCHEMA, riskDone: STRING_SCHEMA, touches: STRING_SCHEMA, lasts: JSON_VALUE_SCHEMA,
  ownerOnly: JSON_OBJECT_SCHEMA, undoneBy: STRING_SCHEMA, button: STRING_SCHEMA, asksItself: BOOLEAN_SCHEMA,
  stepTitles: arraySchema(STRING_SCHEMA),
  reveals: objectSchema({ label: STRING_SCHEMA, note: STRING_SCHEMA }, ['label', 'note']),
  inputs: arraySchema(JSON_OBJECT_SCHEMA),
}, ['id', 'group', 'runsIn', 'command', 'actionId', 'label', 'sentence', 'risk', 'inputs']);

export const PLACE_COUNTS_METHOD_ID = 'places.counts';

/** One place's count: what waits or is wrong there, in words, and the lists that could not be read. */
const PLACE_COUNT_SCHEMA = objectSchema({
  place: STRING_SCHEMA, count: NUMBER_SCHEMA, words: STRING_SCHEMA, tone: stringEnumSchema(['waiting', 'wrong']), unread: arraySchema(STRING_SCHEMA),
}, ['place']);

export const builtinGatewayCapabilityMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: PLACE_COUNTS_METHOD_ID,
    title: 'Count Every Place',
    description: 'What waits or is wrong in every place (Waiting for you, Automation, Work, ...), in one call, as a menu of places shows it when it opens: for each place with something to count, the count, its words ("2 waiting", "1 failed") and its tone (waiting: something waits on you; wrong: something needs a look). Each count is the place\'s own, made from its own lists read from their daemon sources, so it agrees with the place when opened; a list a terminal program keeps (its conversation, its key table) is not read here, and unread names a list whose read was refused (the count is made without it). program (tui, agent or web) counts that program\'s view: a list declared for other programs only is not read. workingDirectory is the caller\'s project, sent with each project-bound read. A place with nothing to count has no count. Nothing changes.',
    category: 'capabilities',
    effects: ['control-plane.read'],
    transport: ['ws'],
    inputSchema: objectSchema({ program: stringEnumSchema(['tui', 'agent', 'web']), workingDirectory: STRING_SCHEMA }, []),
    outputSchema: objectSchema({ places: arraySchema(PLACE_COUNT_SCHEMA) }, ['places']),
  }),
  methodDescriptor({
    id: CAPABILITY_LIST_METHOD_ID,
    title: 'List Capabilities',
    description: 'The capabilities this daemon knows, as a screen draws them: each one\'s id, group, where it runs (daemon: here; session: in the program holding a conversation; terminal: only inside a terminal program for now), what a repeat does, its words (label, the sentence that says what it will do, the line said when it is done), its risk, what it touches and how long it lasts, its inputs as described (kind, required or its usual value, fixed choices or the live list they are read from), and what undoes it. ids narrows the answer to those capabilities, group to one function group; with neither, every capability. Nothing runs.',
    category: 'capabilities',
    effects: ['control-plane.read'],
    transport: ['ws'],
    inputSchema: objectSchema({ ids: arraySchema(STRING_SCHEMA), group: GROUP }, []),
    outputSchema: objectSchema({ capabilities: arraySchema(LISTED_SCHEMA) }, ['capabilities']),
  }),
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
    description: 'Runs one capability by id with its inputs (names and values as capabilities.find lists them), as the same act would run from any other source: the inputs are checked against its definition, its effects are admitted for the caller, and then a person\'s own request (a sign-in, a paired device or an app on this machine stating a person asked) runs at once, a call the Agent makes after its own capability gate judged it (the Agent\'s credential with that gate\'s mark) runs, and any other caller\'s call, the Agent\'s credential without the mark included, is decided under the owner\'s permission mode (an act that loosens a protection or cannot be undone is put to the owner and opens on No). A capability with its own method runs through that method. workingDirectory is the caller\'s project (a hooks file, a project secret store); program is the terminal program asking (tui or agent); model is the model that program\'s conversation uses (provider:model), which a capability on that conversation\'s model (its context window size) acts on unless its inputs name another. The answer is the text a person reads (detail: the capability\'s own words without its done line), the facts a script reads (never a secret value), the risk and what a repeat of this capability does; reveal is a value the person must see once (a new device\'s token, a join key), returned only to the person who asked. A call put to the owner is never held open: the answer is at once 202 with code OWNER_APPROVAL_PENDING, the approvalId of the question waiting for him in Waiting for you, state and next; send approvalId alone (no id), with the same credential, to read what came of it: 202 again while he has not answered, the run\'s answer once he approved it, or the refusal (403 CAPABILITY_NOT_APPROVED with his reason, or the capability\'s own refusal). A refusal is never a 500: it keeps the code of what refused it and the status that code stands for (404 NOT_FOUND for what is not held, 422 only for inputs that do not fit, 503 UNAVAILABLE for what this daemon was started without, 409 for any other refusal of the state found, with the capability\'s own code); a refusal from a method or an outside program the daemon ran for the capability keeps that method\'s status and code (424 CI_SOURCE_REFUSED for GitHub); 500 is the daemon\'s own fault. A capability that acts in a project folder is refused at once, 422 CAPABILITY_CALLER_CONTEXT_MISSING, when the call names no workingDirectory: the owner is never asked about a call that would then be refused. The owner\'s approval of a call put to him stands as the person\'s request for that call\'s own nested method that needs one (confirmation owner-request), for that one call only. A call put to him runs on his yes, after a daemon restart too, as the caller it was held for; whatever can refuse it without him (its inputs, its preview) is checked before he is asked. A capability that is the owner\'s own act is put to him, opening on No, never refused outright: asked for by a caller who is not the owner (an admin\'s sign-in, a paired device, a member), it is put to him the same way, the question naming who asks, and on his yes it runs with his authority for that one call and its nested methods. Before a held call runs on his yes, the caller it was held for must still be allowed: one whose operator token was replaced, whose device was unpaired, or whose sign-in user or sign-in is gone gets 403 CAPABILITY_CALLER_GONE naming it, and nothing runs; when that cannot be told (after a restart, a caller told only by a credential that is not kept) it is 409 CAPABILITY_ASK_AGAIN. His yes is judged again against the mode and the deny rules as they are when he answers: plan mode switched on, or a rule that now refuses it, refuses it with that reason. A remembered answer to an outside caller\'s call is kept for that caller only, and none is offered for an act of the owner\'s own asked by someone who is not the owner. Folder trust is not asked for a daemon capability: it acts on what the daemon keeps, not in a project folder.',
    category: 'capabilities',
    effects: ['control-plane.write'],
    transport: ['ws'],
    inputSchema: objectSchema({
      id: STRING_SCHEMA,
      inputs: JSON_OBJECT_SCHEMA,
      workingDirectory: STRING_SCHEMA,
      program: stringEnumSchema(['tui', 'agent']),
      model: STRING_SCHEMA,
      // The asking program's conversation, for a capability that records where it came from (a memory record's session).
      sessionId: STRING_SCHEMA,
      // The outcome of an earlier call put to the owner, read by the id its 202 answer gave (sent without id).
      approvalId: STRING_SCHEMA,
    }, []),
    outputSchema: { anyOf: [objectSchema({
      id: STRING_SCHEMA, ok: BOOLEAN_SCHEMA, text: STRING_SCHEMA, detail: STRING_SCHEMA, data: JSON_OBJECT_SCHEMA, risk: STRING_SCHEMA,
      repeat: stringEnumSchema(['safe', 'unsafe']), method: STRING_SCHEMA,
      // A value the person must see once (a capability that declares `reveals`): only to the person who asked.
      reveal: objectSchema({ label: STRING_SCHEMA, note: STRING_SCHEMA, value: STRING_SCHEMA, qr: STRING_SCHEMA }, ['label', 'note', 'value']),
    }, ['id', 'ok', 'text', 'risk']), OWNER_APPROVAL_PENDING_SCHEMA] },
    errorCodes: [NOT_FOUND, INVALID, ELSEWHERE, REFUSED, TARGET_NOT_FOUND, INPUT_UNFIT, UNAVAILABLE, CONTEXT_MISSING, NOT_APPROVED, CALL_NOT_FOUND, CALLER_GONE, ASK_AGAIN],
  }),
];

export const CAPABILITY_METHOD_IDS: readonly string[] = [CAPABILITY_LIST_METHOD_ID, CAPABILITY_FIND_METHOD_ID, CAPABILITY_RUN_METHOD_ID, PLACE_COUNTS_METHOD_ID];
