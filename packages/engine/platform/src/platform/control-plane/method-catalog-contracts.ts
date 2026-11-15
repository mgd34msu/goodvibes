/**
 * method-catalog-contracts.ts, the `contracts.*` operator methods
 * (docs/design/contract-runner.md 10.2): list, read, start, cancel and reply
 * to contracts, over every contract runner this daemon holds (its own and
 * each hosted-session workspace floor's). Handlers are in routes/contracts.ts;
 * each method also has a REST path, served through the daemon-api REST route
 * table (gateway-rest-routes.ts) by the same handler.
 *
 * Scopes follow the fleet methods: reading is `read:fleet`, acting is
 * `write:fleet`.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import type { ContractErrorCode } from '../types/foundation-contract.js';
import { methodDescriptor } from './method-catalog-shared.js';
import {
  CONTRACTS_CANCEL_INPUT_SCHEMA,
  CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  CONTRACTS_GET_INPUT_SCHEMA,
  CONTRACTS_GET_OUTPUT_SCHEMA,
  CONTRACTS_LIST_INPUT_SCHEMA,
  CONTRACTS_LIST_OUTPUT_SCHEMA,
  CONTRACTS_REPLY_INPUT_SCHEMA,
  CONTRACTS_REPLY_OUTPUT_SCHEMA,
  CONTRACTS_START_INPUT_SCHEMA,
  CONTRACTS_START_OUTPUT_SCHEMA,
} from './operator-contract-schemas-contracts.js';

const CONTRACT_NOT_FOUND: ContractErrorCode = { code: 'CONTRACT_NOT_FOUND', status: 404, meaning: 'No runner on this daemon holds that contract id.' };
const CONTRACT_NOT_RUNNING: ContractErrorCode = { code: 'CONTRACT_NOT_RUNNING', status: 409, meaning: 'This runner holds the contract only for inspection.' };
const INVALID_ARGUMENT: ContractErrorCode = { code: 'INVALID_ARGUMENT', status: 400, meaning: 'An input is not one the method accepts; the error names it and nothing was changed.' };

export const builtinGatewayContractMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'contracts.list',
    title: 'List Contracts',
    description: 'Every contract this daemon holds, newest first, each with its whole tree: the ask, the goal, the acceptance criteria with every Jev reading, the groups and units with their checks and nudges, open and answered owner escalations, decisions, usage, and the answer or status line once it ends. `sessionId` narrows the list to one session\'s contracts (a hosted session\'s, or a shared session\'s); ended contracts are left out unless `includeTerminal` is set.',
    category: 'contracts',
    scopes: ['read:fleet'],
    http: { method: 'GET', path: '/api/contracts' },
    inputSchema: CONTRACTS_LIST_INPUT_SCHEMA,
    outputSchema: CONTRACTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.get',
    title: 'Get a Contract',
    description: 'One contract with its whole tree, running or ended. 404 with CONTRACT_NOT_FOUND when no runner on this daemon holds the id.',
    category: 'contracts',
    scopes: ['read:fleet'],
    http: { method: 'GET', path: '/api/contracts/{contractId}' },
    errorCodes: [CONTRACT_NOT_FOUND],
    inputSchema: CONTRACTS_GET_INPUT_SCHEMA,
    outputSchema: CONTRACTS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.start',
    title: 'Start a Contract',
    description: 'Start a contract for `ask`, the person\'s words verbatim, which every stated acceptance criterion must trace to. Returns at once with the new contract and its owner agent id; the contract shapes, plans and runs on its own, and its progress arrives on the `contracts` event domain. When `sessionId` names a live session this daemon hosts, the contract starts in that session (origin `hosted`): its turns receive the contract\'s questions and a following turn answers them. Otherwise it starts on the daemon\'s own runner (origin `external`) under `sessionId`, or the `operator` session when none is given, in `workspaceRoot` (absolute), or the daemon\'s working directory. `isolation` overrides `contract.isolation` for this contract. 400 with INVALID_ARGUMENT when `ask` is empty, `workspaceRoot` is relative or outside the daemon\'s workspace, or differs from the hosted session\'s; 403 with SESSION_NOT_OWNED when the session belongs to another caller; 409 with SESSION_NOT_LIVE when `sessionId` names a hosted session that is no longer live.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts' },
    replay: {
      in: 'header',
      name: 'Idempotency-Key',
      behavior: 'A retry with the same key and the same body returns the first contract (with the Idempotent-Replayed: true response header) instead of starting a second one; the same key with a different body is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the contract store per caller, so a retry after a daemon restart still returns the first contract; the body is compared field by field, in any order. The key may also be sent as `idempotencyKey` in the body; the header wins when both are given. A replayed result carries `replayed: true`.',
    },
    errorCodes: [
      INVALID_ARGUMENT,
      { code: 'SESSION_NOT_OWNED', status: 403, meaning: 'The session belongs to another caller.' },
      { code: 'SESSION_NOT_LIVE', status: 409, meaning: 'sessionId names a hosted session that is no longer live.' },
      { code: 'IDEMPOTENCY_KEY_REUSED', status: 409, meaning: 'This Idempotency-Key was already used for a different request; use a new key.' },
    ],
    inputSchema: CONTRACTS_START_INPUT_SCHEMA,
    outputSchema: CONTRACTS_START_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.cancel',
    title: 'Cancel a Contract',
    description: 'Stop a contract and every unit agent it runs; its status line records how many files were already changed and where. `cancelled` is false when the contract had already ended. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_NATIVE for native work (stop it through its own execution, or answer its open question with `cancel`); 409 with CONTRACT_NOT_RUNNING when this runner holds the contract only for inspection.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts/{contractId}/cancel' },
    errorCodes: [
      CONTRACT_NOT_FOUND,
      { code: 'CONTRACT_NATIVE', status: 409, meaning: 'Native work stops through its own execution, or by answering its open question with cancel.' },
      CONTRACT_NOT_RUNNING,
    ],
    inputSchema: CONTRACTS_CANCEL_INPUT_SCHEMA,
    outputSchema: CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.reply',
    title: 'Reply to a Contract Escalation',
    description: 'The owner\'s free-text reply to an open escalation of a contract, read by Jev as approve, reject, amend or unclear. Returns how it was read and what the runner did: approved, amended, stopped, asked again (with the new escalation id), or refused when the escalation is no longer open. Approval never passes a criterion Jev read as unmet; the requirement changes only through an amendment. A native work contract\'s failed-turn question is not read by Jev: it accepts exactly `retry` or `cancel`. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_NOT_RUNNING when this runner holds the contract only for inspection, 409 with CONTRACT_ENDED when the contract has ended, 409 with ESCALATION_NOT_OPEN when the escalation is already answered or another reply to it is being read, 400 with INVALID_ARGUMENT when the text is not an answer the question accepts.',
    category: 'contracts',
    scopes: ['write:fleet'],
    http: { method: 'POST', path: '/api/contracts/{contractId}/reply' },
    errorCodes: [
      CONTRACT_NOT_FOUND,
      CONTRACT_NOT_RUNNING,
      { code: 'CONTRACT_ENDED', status: 409, meaning: 'The contract has ended.' },
      { code: 'ESCALATION_NOT_OPEN', status: 409, meaning: 'The escalation is already answered, or another reply to it is being read.' },
      INVALID_ARGUMENT,
    ],
    inputSchema: CONTRACTS_REPLY_INPUT_SCHEMA,
    outputSchema: CONTRACTS_REPLY_OUTPUT_SCHEMA,
  }),
];
