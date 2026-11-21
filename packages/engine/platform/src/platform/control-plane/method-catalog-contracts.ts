/**
 * method-catalog-contracts.ts, the `contracts.*` operator methods: list,
 * summarize, read, poll, start, dispatch, cancel, reply to and remove
 * contracts, retry a unit and set a budget, over every contract runner this
 * daemon holds (its own and each hosted-session workspace floor's). Handlers
 * are in routes/contracts.ts. Every method is reached by invoke; a method whose
 * descriptor has an `http` binding is also served on that REST path through
 * the daemon-api REST route table (gateway-rest-routes.ts) by the same
 * handler. Today those are list, get, start, cancel and reply; summaries,
 * status, dispatch, remove, retryUnit and budget are invoke only.
 *
 * Scopes follow the fleet methods: reading is `read:fleet`, acting is
 * `write:fleet`.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import type { ContractErrorCode } from '../types/foundation-contract.js';
import { methodDescriptor } from './method-catalog-shared.js';
import {
  CONTRACTS_CANCEL_INPUT_SCHEMA,
  CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  CONTRACTS_DISPATCH_INPUT_SCHEMA,
  CONTRACTS_GET_INPUT_SCHEMA,
  CONTRACTS_GET_OUTPUT_SCHEMA,
  CONTRACTS_LIST_INPUT_SCHEMA,
  CONTRACTS_LIST_OUTPUT_SCHEMA,
  CONTRACTS_REPLY_INPUT_SCHEMA,
  CONTRACTS_REPLY_OUTPUT_SCHEMA,
  CONTRACTS_REMOVE_INPUT_SCHEMA,
  CONTRACTS_REMOVE_OUTPUT_SCHEMA,
  CONTRACTS_RETRY_UNIT_INPUT_SCHEMA,
  CONTRACTS_RETRY_UNIT_OUTPUT_SCHEMA,
  CONTRACTS_BUDGET_INPUT_SCHEMA,
  CONTRACTS_BUDGET_OUTPUT_SCHEMA,
  CONTRACTS_START_INPUT_SCHEMA,
  CONTRACTS_START_OUTPUT_SCHEMA,
  CONTRACTS_STATUS_INPUT_SCHEMA,
  CONTRACTS_STATUS_OUTPUT_SCHEMA,
  CONTRACTS_SUMMARIES_INPUT_SCHEMA,
  CONTRACTS_SUMMARIES_OUTPUT_SCHEMA,
} from './operator-contract-schemas-contracts.js';

const CONTRACT_NOT_FOUND: ContractErrorCode = { code: 'CONTRACT_NOT_FOUND', status: 404, meaning: 'No runner on this daemon holds that contract id.' };
const CONTRACT_NOT_RUNNING: ContractErrorCode = { code: 'CONTRACT_NOT_RUNNING', status: 409, meaning: 'This runner holds the contract only for inspection.' };
const INVALID_ARGUMENT: ContractErrorCode = { code: 'INVALID_ARGUMENT', status: 400, meaning: 'An input is not one the method accepts; the error names it and nothing was changed.' };

export const builtinGatewayContractMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'contracts.list',
    title: 'List Contracts',
    description: 'Every contract this daemon holds, newest first, each with its whole tree: the ask, the goal, the acceptance criteria with every Jev reading, the groups and units with their checks and nudges, open and answered owner escalations, decisions, usage, and the answer or status line once it ends. `sessionId` narrows the list to one session\'s contracts (a hosted session\'s, or a shared session\'s); ended contracts are left out unless `includeTerminal` is set. For a list view, `contracts.summaries` returns the same contracts as small summaries. A contract an identified caller started belongs to that caller (`ownerPrincipalId`) for its whole life; one a hosted session\'s own turn started belongs to that session\'s identified owners. Contracts of another caller are left out here and read as CONTRACT_NOT_FOUND everywhere else.',
    category: 'contracts',
    effects: ['fleet.read'],
    http: { method: 'GET', path: '/api/contracts' },
    inputSchema: CONTRACTS_LIST_INPUT_SCHEMA,
    outputSchema: CONTRACTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.get',
    title: 'Get a Contract',
    description: 'One contract with its whole tree, running or ended. The captured input\'s per-file list, which only contracts captured before the input was recorded as a git tree carry, is left out unless `includeInputFiles` is true. To poll for progress, use `contracts.status`. 404 with CONTRACT_NOT_FOUND when no runner on this daemon holds the id.',
    category: 'contracts',
    effects: ['fleet.read'],
    http: { method: 'GET', path: '/api/contracts/{contractId}' },
    errorCodes: [CONTRACT_NOT_FOUND],
    inputSchema: CONTRACTS_GET_INPUT_SCHEMA,
    outputSchema: CONTRACTS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.summaries',
    title: 'List Contract Summaries',
    description: 'The contracts `contracts.list` returns (same `sessionId` and `includeTerminal`), newest first, each as a small summary: id, session, owner agent, origin, ask, goal, status and status line, failure, group and unit counts, open owner question ids and the newest open question, usage, created, ended and last-changed times, and a `revision` that changes whenever any of these does. Nothing of the evidence, readings or history is sent; read one contract\'s tree with `contracts.get`.',
    category: 'contracts',
    effects: ['fleet.read'],
    inputSchema: CONTRACTS_SUMMARIES_INPUT_SCHEMA,
    outputSchema: CONTRACTS_SUMMARIES_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.status',
    title: 'Get a Contract\'s Status',
    description: 'One contract\'s summary (as `contracts.summaries` gives it), for polling. Pass the `revision` of the last answer as `ifRevision`: when nothing changed the answer is only `{ id, revision, notModified: true }`. A stored contract this daemon holds without running carries `held` with `code` (`input-unavailable`: its recorded input could not be restored, and `contracts.cancel` ends it; `claim-unavailable`: no run claim could be taken) and the `reason`. 404 with CONTRACT_NOT_FOUND when no runner on this daemon holds the id.',
    category: 'contracts',
    effects: ['fleet.read'],
    errorCodes: [CONTRACT_NOT_FOUND],
    inputSchema: CONTRACTS_STATUS_INPUT_SCHEMA,
    outputSchema: CONTRACTS_STATUS_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.start',
    effects: ['fleet.write', 'outward.send'],
    title: 'Start a Contract',
    description: 'Start a contract for `ask`, the person\'s words verbatim, which every stated acceptance criterion must trace to. Returns at once with the new contract and its owner agent id; the contract shapes, plans and runs on its own, and its progress arrives on the `contracts` event domain. When `sessionId` names a live session this daemon hosts, the contract starts in that session (origin `hosted`): its turns receive the contract\'s questions and a following turn answers them. Otherwise it starts on the daemon\'s own runner (origin `external`) under `sessionId`, or the `operator` session when none is given, in `workspaceRoot` (absolute), or the daemon\'s working directory. `isolation` overrides `contract.isolation` for this contract. 400 with INVALID_ARGUMENT when `ask` is empty, `workspaceRoot` is relative or outside the daemon\'s workspace, or differs from the hosted session\'s; 403 with SESSION_NOT_OWNED when the session belongs to another caller; 409 with SESSION_NOT_LIVE when `sessionId` names a hosted session that is no longer live.',
    category: 'contracts',
    http: { method: 'POST', path: '/api/contracts' },
    replay: {
      in: 'header',
      name: 'Idempotency-Key',
      behavior: 'A retry with the same key and the same body returns the first contract (with the Idempotent-Replayed: true response header) instead of starting a second one; the same key with a different body is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the contract store per caller, so a retry after a daemon restart, or through another process on the same project, still returns the first contract; the body is compared field by field, in any order. A start whose key cannot be recorded is refused with CONTRACT_KEY_UNRECORDED and starts nothing; a repeat while another process is still starting the first is refused with IDEMPOTENCY_KEY_IN_FLIGHT (send it again in a few seconds). The key may also be sent as `idempotencyKey` in the body; the header wins when both are given. A replayed result carries `replayed: true`.',
    },
    errorCodes: [
      INVALID_ARGUMENT,
      { code: 'SESSION_NOT_OWNED', status: 403, meaning: 'The session belongs to another caller.' },
      { code: 'SESSION_NOT_LIVE', status: 409, meaning: 'sessionId names a hosted session that is no longer live.' },
      { code: 'IDEMPOTENCY_KEY_REUSED', status: 409, meaning: 'This Idempotency-Key was already used for a different request; use a new key.' },
      { code: 'IDEMPOTENCY_KEY_IN_FLIGHT', status: 409, meaning: 'Another process is still starting a contract with this key; send the same request again in a few seconds.' },
      { code: 'CONTRACT_KEY_UNRECORDED', status: 503, meaning: 'The key could not be recorded in the project\'s contract directory, so nothing was started; make the directory writable and retry.' },
    ],
    inputSchema: CONTRACTS_START_INPUT_SCHEMA,
    outputSchema: CONTRACTS_START_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.dispatch',
    replay: { in: 'body', name: 'idempotencyKey', behavior: 'A repeat by the same caller with the same `idempotencyKey`, `ask` and workspace returns the first dispatch\'s contract instead of starting a second one, and creates no second session; the same key with a different ask or workspace is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the workspace\'s contract store per caller, as for contracts.start, so a retry after a daemon restart, or through another process on the same project, still returns the first contract. A dispatch whose key cannot be recorded is refused with CONTRACT_KEY_UNRECORDED and starts nothing; a repeat while another process is still starting the first is refused with IDEMPOTENCY_KEY_IN_FLIGHT.' },
    title: 'Dispatch Contract Work',
    description: 'Start a contract for `ask` (the person\'s words verbatim) in a hosted session created for it, in `workspaceRoot` (absolute, inside the daemon\'s working directory or a registered workspace, the folders sessions.hosted.workspaces lists) or the daemon\'s working directory. The contract\'s questions arrive as that session\'s replies, and the session ends when the contract passes, fails or is cancelled. Returns at once with the contract and its owner agent id; read it with `contracts.get`, stop it with `contracts.cancel`, answer it with `contracts.reply`. `idempotencyKey` returns the first dispatch\'s contract to a retry by the same caller, also after a daemon restart, and the session made for it still ends when it settles. 400 with INVALID_ARGUMENT when `ask` is empty or `workspaceRoot` is relative or outside those folders; 409 with NOT_HOSTING when this daemon hosts no sessions (use `contracts.start`).',
    category: 'contracts',
    effects: ['fleet.write', 'outward.send'],
    errorCodes: [
      INVALID_ARGUMENT,
      { code: 'NOT_HOSTING', status: 409, meaning: 'This daemon hosts no sessions, so work cannot be dispatched into a new one; use contracts.start.' },
    ],
    inputSchema: CONTRACTS_DISPATCH_INPUT_SCHEMA,
    outputSchema: CONTRACTS_START_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.cancel',
    repeat: 'safe',
    title: 'Cancel a Contract',
    description: 'Stop a contract and every unit agent it runs; its status line records how many files were already changed and where. `cancelled` is false when the contract had already ended. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_NATIVE for native work (stop it through its own execution, or answer its open question with `cancel`); 409 with CONTRACT_NOT_RUNNING when this runner holds the contract only for inspection. A contract held because its recorded input could not be restored (status `held.code` `input-unavailable`) is cancelled here; one held because no run claim could be taken (`claim-unavailable`) is refused with 409 CONTRACT_HELD, since another process may be running it.',
    category: 'contracts',
    effects: ['fleet.write'],
    http: { method: 'POST', path: '/api/contracts/{contractId}/cancel' },
    errorCodes: [
      CONTRACT_NOT_FOUND,
      { code: 'CONTRACT_NATIVE', status: 409, meaning: 'Native work stops through its own execution, or by answering its open question with cancel.' },
      CONTRACT_NOT_RUNNING,
      { code: 'CONTRACT_HELD', status: 409, meaning: 'The contract is held because no run claim could be taken; another process may run it, so it is not cancelled here. Fix the contract directory and restart, then cancel.' },
    ],
    inputSchema: CONTRACTS_CANCEL_INPUT_SCHEMA,
    outputSchema: CONTRACTS_CANCEL_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.reply',
    replay: IDEMPOTENCY_KEY_REPLAY,
    effects: ['fleet.write', 'contract.change', 'outward.send'],
    title: 'Reply to a Contract Escalation',
    description: 'The owner\'s free-text reply to an open escalation of a contract, read by Jev as approve, reject, amend or unclear. Returns how it was read and what the runner did: approved, amended, stopped, asked again (with the new escalation id), or refused when the escalation is no longer open. Approval never passes a criterion Jev read as unmet; the requirement changes only through an amendment. A failed-work question (a native work contract\'s failed turn, a failed unit, a result that could not be published) is not read by Jev: it accepts exactly `retry` or `cancel`. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_NOT_RUNNING when this runner holds the contract only for inspection, 409 with CONTRACT_ENDED when the contract has ended, 409 with ESCALATION_NOT_OPEN when the escalation is already answered or another reply to it is being read, 400 with INVALID_ARGUMENT when the text is not an answer the question accepts.',
    category: 'contracts',
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
  methodDescriptor({
    id: 'contracts.remove',
    repeat: 'safe',
    effects: ['fleet.write', 'record.destroy'],
    title: 'Remove an Ended Contract',
    description: 'Delete the record of a contract that has ended (passed, failed or cancelled): its checkpoint and summary. Its branch and worktree, if any, are left to the worktree retention rules. Ended contracts are also removed automatically 30 days after they end, and beyond the newest 100 per project. `removed` is true when it was deleted. 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_NOT_ENDED while it runs (cancel it first); 409 with CONTRACT_NATIVE for native work, whose record its native execution keeps.',
    category: 'contracts',
    errorCodes: [
      CONTRACT_NOT_FOUND,
      { code: 'CONTRACT_NOT_ENDED', status: 409, meaning: 'The contract is still running or settling; cancel it, then remove it once it has stopped.' },
      { code: 'CONTRACT_NATIVE', status: 409, meaning: 'Native work keeps its record with its native execution.' },
    ],
    inputSchema: CONTRACTS_REMOVE_INPUT_SCHEMA,
    outputSchema: CONTRACTS_REMOVE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.retryUnit',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Run One Contract Unit Again',
    description: 'Run one unit of a running contract again: a unit that is working gets a fresh agent with its brief and previous checks, a unit that failed (the contract waits on its retry-or-cancel question, the units depending on it held) runs again with a fresh agent, the same as replying `retry`, and a passed unit whose commit failed has its changes committed again. `outcome` is `restarted`, `committed`, or `refused` with `reason` naming why and what to do instead (a unit that has not started, is being fixed, or ended with its contract). 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_ENDED once the contract has ended; 409 with CONTRACT_NATIVE for native work.',
    category: 'contracts',
    effects: ['fleet.write'],
    errorCodes: [
      CONTRACT_NOT_FOUND,
      { code: 'CONTRACT_ENDED', status: 409, meaning: 'The contract has ended; start a new one for the remaining work.' },
      { code: 'CONTRACT_NATIVE', status: 409, meaning: 'Native work runs its units through its own execution.' },
      CONTRACT_NOT_RUNNING,
    ],
    inputSchema: CONTRACTS_RETRY_UNIT_INPUT_SCHEMA,
    outputSchema: CONTRACTS_RETRY_UNIT_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'contracts.budget',
    repeat: 'safe',
    effects: ['fleet.write', 'contract.change'],
    title: 'Set a Running Contract\'s Budget',
    description: 'Replace a running contract\'s token and cost ceiling (`maxCostUsd`, `maxTokens`, or both); a limit left out keeps its current value. Each running group\'s remaining allowance moves by the same amount, and a unit waiting because the budget was used up starts. Returns the new `budget`, both limits as they now stand. 400 with INVALID_ARGUMENT when neither limit is given or one is negative; 404 with CONTRACT_NOT_FOUND for an unknown id; 409 with CONTRACT_ENDED once the contract has ended; 409 with CONTRACT_NATIVE for native work.',
    category: 'contracts',
    errorCodes: [
      INVALID_ARGUMENT,
      CONTRACT_NOT_FOUND,
      { code: 'CONTRACT_ENDED', status: 409, meaning: 'The contract has ended; its budget can no longer change.' },
      { code: 'CONTRACT_NATIVE', status: 409, meaning: 'Native work keeps its budget with its own execution.' },
      CONTRACT_NOT_RUNNING,
    ],
    inputSchema: CONTRACTS_BUDGET_INPUT_SCHEMA,
    outputSchema: CONTRACTS_BUDGET_OUTPUT_SCHEMA,
  }),
];
