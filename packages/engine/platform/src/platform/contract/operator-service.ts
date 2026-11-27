/**
 * The contracts operator surface (docs/design/contract-runner.md 10.2): the
 * `contracts.*` methods, their REST bindings and the external work adapters
 * all act through this one service.
 *
 * A daemon process holds more than one runner: its own, composed with its
 * services, and one per hosted-session workspace floor (a floor's runner is
 * the one its sessions' turns, agent tool and intake use, so a contract a
 * hosted session starts lives there). The service reads across all of them:
 * `list` joins them, `get`, `cancel` and `reply` go to the runner that holds
 * the contract, and `start` goes to the hosted session's floor when the
 * session id names a live hosted session, else to the daemon's own runner.
 *
 * One ownership rule covers every method: a contract started over this
 * surface by an identified caller records that principal, and only it sees and
 * acts on the contract, for its whole life, whoever attaches to its session
 * later and after the session ended. A contract without a recorded principal
 * (one a hosted session's own turn started) follows its session: it is hidden
 * from a caller when the session's identified owners do not include it
 * (`HostedContractRunners.ownedByOthers`). A hidden contract reads as not
 * found, so its existence is not disclosed either.
 *
 * Every choice here is code over ids and recorded statuses; nothing is judged.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { OwnerReplyRefusedError, type OwnerReplyOutcome } from './escalation.js';
import type { ContractExternalWorkAdapter } from './external.js';
import type { ContractRunner, UnitRetryOutcome } from './runner.js';
import type { ContractHold } from './resume.js';
import type { BudgetCeiling } from '../orchestration/types.js';
import { isTerminalContractStatus, type ContractOrigin, type ContractOwnership, type ContractView, type NativeContractSource, type StartContractInput } from './types.js';

/** The session a contract started over the operator surface without a session belongs to. */
export const OPERATOR_SESSION_ID = 'operator';

/** The runner surface the service reads and acts through. */
export type OperatorContractRunner = Pick<ContractRunner, 'start' | 'startIdempotent' | 'get' | 'list' | 'cancel' | 'reply' | 'remove' | 'retryUnit' | 'raiseBudget' | 'held'>;

/** A live hosted session's floor runner and the workspace its turns work in. */
export interface HostedSessionContracts {
  readonly selectedModel?: import('./types.js').StartContractInput['selectedModel'];
  readonly runner: OperatorContractRunner;
  readonly workspaceRoot: string;
}

/** The hosted-session side, supplied by the hosted-session engine when the daemon hosts sessions. */
export interface HostedContractRunners {
  /** The runners of every composed workspace floor. */
  runners(): readonly OperatorContractRunner[];
  /**
   * The floor runner of a live hosted session, composing its loop first when
   * it was restored from disk; null when the id names no live hosted session.
   */
  forSession(sessionId: string): Promise<HostedSessionContracts | null>;
  /**
   * Whether this engine hosts, or ever hosted, the id (including a session
   * that has ended). `forSession` answers null for those too, and a start
   * must tell "an external session" from "a hosted session that is gone".
   */
  knows?(sessionId: string): boolean;
  /** Whether the session's identified owners do not include `principalId`; false when nobody identified themselves on it. */
  ownedByOthers?(sessionId: string, principalId: string | undefined): boolean;
}

export interface OperatorStartInput {
  /** The person's words, verbatim. */
  readonly ask: string;
  readonly sessionId?: string | undefined;
  /** The caller; a hosted session owned by another principal is refused. */
  readonly principalId?: string | undefined;
  /**
   * Absolute. For a hosted session it must be the session's own workspace when
   * given; otherwise it must be the daemon's working directory or inside it.
   */
  readonly workspaceRoot?: string | undefined;
  readonly isolation?: 'auto' | 'worktree' | 'shared' | undefined;
  /**
   * The caller's retry key (the Idempotency-Key header). The same caller and
   * key return the contract the first call started, also after a daemon
   * restart, instead of starting the work again.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * Set by the dispatch adapter (hosted-sessions/contract-work-adapter.ts): the
   * retry key names dispatched work, matched on the ask and workspace only, and
   * whether the session was created for this dispatch (recorded on the contract,
   * so the session ends with it, also after a restart).
   */
  readonly dispatch?: { readonly sessionCreated: boolean } | undefined;
}

export interface OperatorStartedContract {
  readonly contract: ContractView;
  readonly ownerAgentId: string;
  /** True when an earlier call with the same retry key started this contract. */
  readonly replayed?: boolean | undefined;
}

/** Contract work started in a hosted session of its own (`contracts.dispatch`). */
export interface OperatorDispatchInput {
  /** The person's words, verbatim. */
  readonly ask: string;
  /** The caller; it owns the dispatched contract and its session, and scopes the retry key. */
  readonly principalId?: string | undefined;
  /** Absolute; inside the daemon's working directory. Omitted: the daemon's working directory. */
  readonly workspaceRoot?: string | undefined;
  /** The caller's retry key: the same caller and key return the first dispatch's contract while it runs. */
  readonly idempotencyKey?: string | undefined;
}

/**
 * What starts dispatched work: the hosted contract work adapter
 * (hosted-sessions/contract-work-adapter.ts), which creates the session, starts
 * the contract in it and ends the session when the contract settles.
 */
export type OperatorWorkDispatcher = Pick<ContractExternalWorkAdapter, 'dispatch'>;

/**
 * Who is asking over the operator surface. Given, the session-ownership rule
 * applies (`principalId` undefined is an anonymous caller); omitted, the
 * caller is the daemon itself (the external work adapters), which sees all.
 */
export interface OperatorCaller {
  readonly principalId: string | undefined;
}

export interface ContractOperatorService {
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }, caller?: OperatorCaller): ContractView[];
  /** The same contracts as `list`, each as its small summary. */
  summaries(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }, caller?: OperatorCaller): ContractSummary[];
  /**
   * One contract's tree. The captured input's per-file list, which only
   * receipts from before the input was a git tree carry, is left out unless
   * `includeInputFiles` asks for it.
   */
  get(contractId: string, caller?: OperatorCaller, options?: { readonly includeInputFiles?: boolean | undefined }): ContractView | null;
  /** One contract's summary; null when no runner holds it for this caller. */
  status(contractId: string, caller?: OperatorCaller): ContractSummary | null;
  start(input: OperatorStartInput): Promise<OperatorStartedContract>;
  /** False when the contract is known but already ended. */
  cancel(contractId: string, reason: string, caller?: OperatorCaller): boolean;
  reply(contractId: string, escalationId: string, text: string, caller?: OperatorCaller): Promise<OwnerReplyOutcome>;
  /**
   * Deletes an ended contract's record. Refused while it runs (CONTRACT_NOT_ENDED)
   * and for native work (CONTRACT_NATIVE), whose record its native execution owns.
   */
  remove(contractId: string, caller?: OperatorCaller): { readonly removed: true };
  /**
   * Runs one unit of a running contract again (a fresh agent, or a passed
   * unit's failed commit recorded again). A refusal is an outcome with the
   * reason, not an error; an ended or unknown contract is an error.
   */
  retryUnit(contractId: string, unitId: string, caller?: OperatorCaller): Promise<UnitRetryOutcome>;
  /** Replaces a running contract's budget ceiling; units waiting on the old one start. */
  raiseBudget(contractId: string, ceiling: BudgetCeiling, caller?: OperatorCaller): { readonly budget: BudgetCeiling };
  /**
   * Joins the hosted-session runners in, or takes them out with null. The
   * hosted-session engine is composed after the runtime services that build
   * this service, so it attaches itself when it exists.
   */
  attachHosted(hosted: HostedContractRunners | null): void;
  /**
   * Joins one project's native work execution runner in, beside the other
   * projects' (each holds only its project's work); null takes every one out.
   * Returns the detach of the one joined. Its contracts can be read and their
   * open failure question answered (retry or cancel); they are not started or
   * stopped from here, because the native work execution owns that.
   */
  attachNative(runner: Pick<ContractRunner, 'get' | 'list' | 'reply'> | null): () => void;
  /**
   * Starts `ask` as a contract in a new hosted session: its questions are that
   * session's replies, and the session ends when the contract settles. Read
   * and stop it with `get` and `cancel` like any other contract. Refused with
   * NOT_HOSTING while no dispatcher is attached.
   */
  dispatch(input: OperatorDispatchInput): Promise<OperatorStartedContract>;
  /**
   * Joins the dispatcher in (the hosted adapter attaches itself when the daemon
   * composes it). Returns the detach, which only removes this dispatcher, so a
   * replaced adapter's close cannot take out its successor.
   */
  attachDispatcher(dispatcher: OperatorWorkDispatcher): () => void;
}

export type ContractOperatorErrorCode =
  | 'CONTRACT_NOT_FOUND'
  | 'CONTRACT_ENDED'
  /** The runner holds the contract but is not running it (held for inspection). */
  | 'CONTRACT_NOT_RUNNING'
  /** Native work is stopped through its own execution, not this surface. */
  | 'CONTRACT_NATIVE'
  /** The contract is held because no run claim could be taken; another process may run it, so it is not cancelled here. */
  | 'CONTRACT_HELD'
  /** The session id names a hosted session that is no longer live. */
  | 'SESSION_NOT_LIVE'
  /** The session id names a hosted session another caller owns. */
  | 'SESSION_NOT_OWNED'
  /** The escalation is answered, or another reply to it is being read. */
  | 'ESCALATION_NOT_OPEN'
  /** The contract is still running (or still settling), so its record cannot be removed. */
  | 'CONTRACT_NOT_ENDED'
  /** This daemon hosts no sessions, so work cannot be dispatched into a new one. */
  | 'NOT_HOSTING'
  | 'INVALID_ARGUMENT';

/** A refusal with the wire code and status the operator routes report it under. */
export class ContractOperatorError extends Error {
  constructor(
    message: string,
    readonly code: ContractOperatorErrorCode,
    readonly status: 400 | 403 | 404 | 409,
    readonly field?: string | undefined,
  ) {
    super(message);
    this.name = 'ContractOperatorError';
  }
}

export interface ContractOperatorServiceDeps {
  /** The daemon's own runner; null where the graph runs no contracts (a terminal program). */
  readonly runner: OperatorContractRunner | null;
  /** Where a contract started without a workspace or a hosted session works. */
  readonly workingDirectory: string;
}

/**
 * What a list row or a status poll needs of a contract, computed by its owner
 * from the record in one pass: no evidence, readings or history. `revision`
 * changes whenever any field here does, and whenever a unit or group moves (its
 * state, agent, checks, nudges, fix rounds or touched paths), so a poller
 * compares one string and fetches the tree only when it changed.
 */
export interface ContractSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerAgentId: string;
  readonly origin: ContractOrigin;
  readonly ask: string;
  readonly goal: string;
  readonly status: ContractView['status'];
  readonly statusLine?: string | undefined;
  readonly failureKind?: ContractView['failureKind'];
  readonly error?: string | undefined;
  readonly groupCount: number;
  readonly unitCount: number;
  readonly unitsPassed: number;
  readonly unitsFailed: number;
  /** Every owner question still open, newest first. */
  readonly openEscalationIds: readonly string[];
  /** The newest open owner question, which is what the contract waits on. */
  readonly openEscalation?: { readonly id: string; readonly at: number; readonly question: string } | undefined;
  readonly usage: ContractView['usage'];
  readonly createdAt: number;
  readonly completedAt?: number | undefined;
  /** The latest time anything here moved: a decision, a question raised or answered, the end. */
  readonly updatedAt: number;
  /**
   * Present when this daemon holds the stored contract without running it: `input-unavailable` (its recorded input
   * could not be restored; cancel ends it) or `claim-unavailable` (no run claim could be taken; another process may run it).
   */
  readonly held?: { readonly code: ContractHold['code']; readonly reason: string; readonly at: number } | undefined;
  readonly revision: string;
}

/** The summary of one contract (see `ContractSummary`). */
export function summarizeContract(contract: ContractView, hold: ContractHold | null = null): ContractSummary {
  const open = contract.escalations.filter((escalation) => escalation.resolvedAt === undefined).sort((a, b) => b.at - a.at);
  let updatedAt = Math.max(contract.createdAt, contract.completedAt ?? 0, contract.statusChangedAt ?? 0);
  for (const decision of contract.decisions) if (decision.at > updatedAt) updatedAt = decision.at;
  for (const escalation of contract.escalations) updatedAt = Math.max(updatedAt, escalation.at, escalation.resolvedAt ?? 0);
  let unitsPassed = 0, unitsFailed = 0;
  // Units and groups move without a decision (an agent starts, a check lands):
  // their marks join the revision, not the summary.
  const marks: (string | number)[] = [contract.checks.length, contract.fixRounds];
  for (const unit of contract.units) {
    if (unit.status === 'passed') unitsPassed += 1;
    else if (unit.status === 'failed') unitsFailed += 1;
    marks.push(unit.status, unit.activeAgentId ?? '', unit.agentIds.length, unit.checks.length, unit.nudges.length, unit.fixRounds, unit.touchedPaths.length);
  }
  for (const group of contract.groups) marks.push(group.status, group.checks.length, group.fixRounds);
  const fields = {
    id: contract.id,
    sessionId: contract.sessionId,
    ownerAgentId: contract.ownerAgentId,
    origin: contract.origin,
    ask: contract.ask,
    goal: contract.goal,
    status: contract.status,
    ...(contract.statusLine === undefined ? {} : { statusLine: contract.statusLine }),
    ...(contract.failureKind === undefined ? {} : { failureKind: contract.failureKind }),
    ...(contract.error === undefined ? {} : { error: contract.error }),
    groupCount: contract.groups.length,
    unitCount: contract.units.length,
    unitsPassed,
    unitsFailed,
    openEscalationIds: open.map((escalation) => escalation.id),
    ...(open[0] === undefined ? {} : { openEscalation: { id: open[0].id, at: open[0].at, question: open[0].question } }),
    usage: contract.usage,
    createdAt: contract.createdAt,
    ...(contract.completedAt === undefined ? {} : { completedAt: contract.completedAt }),
    updatedAt,
    ...(hold === null ? {} : { held: { code: hold.code, reason: hold.reason, at: hold.at } }),
  };
  // Hashes the summary and the marks (a few hundred bytes), never the tree.
  return { ...fields, revision: createHash('sha256').update(JSON.stringify([fields, marks])).digest('hex').slice(0, 16) };
}

/** The tree without the captured input's per-file list (only receipts from before the input was a git tree have one). */
function withoutInputFiles(contract: ContractView): ContractView {
  const snapshot = contract.inputSnapshot;
  if (snapshot?.files === undefined) return contract;
  const { files: _files, ...rest } = snapshot;
  return { ...contract, inputSnapshot: rest };
}

/** Operator inspection does not grant access to an earlier hosted conversation. */
export function projectContractOperatorView(contract: ContractView): ContractView {
  const publicSource = (source: NativeContractSource): NativeContractSource => {
    const { continuation: _privateContext, ...original } = source;
    return original;
  };
  const source = contract.nativeSource;
  const admission = contract.durableAdmission;
  const original = contract.originalSource;
  // The frozen transcript and selected diff of the session that started the contract stay with that session.
  const privateOriginal = original !== undefined && (original.conversationContext !== undefined || original.selectedDiffContext !== undefined);
  if (!source?.continuation && !admission?.input.nativeSource?.continuation && !privateOriginal) return contract;
  return { ...contract,
    ...(privateOriginal ? { originalSource: { goal: original.goal, criteria: original.criteria } } : {}),
    ...(source?.continuation ? { nativeSource: publicSource(source) } : {}),
    ...(admission?.input.nativeSource?.continuation ? { durableAdmission: { ...admission,
      input: { ...admission.input, nativeSource: publicSource(admission.input.nativeSource) },
    } } : {}),
  };
}

/** A list entry leaves out the captured repository's file manifest; `get` returns it. */
function summarized(contract: ContractView): ContractView {
  return contract.inputSnapshot === undefined ? contract : { ...contract, inputSnapshot: undefined };
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `candidate` is the root or inside it, after following links. */
function isWithin(root: string, candidate: string): boolean {
  const from = relative(realOrResolved(root), realOrResolved(candidate));
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

function notRunning(contractId: string, status: string): ContractOperatorError {
  return new ContractOperatorError(
    `Contract ${contractId} is ${status} but this runner is not running it: it was left for inspection (a record of another execution mode, or one only a durable resume adopts). It cannot be cancelled or replied to from here.`,
    'CONTRACT_NOT_RUNNING',
    409,
  );
}

export function createContractOperatorService(deps: ContractOperatorServiceDeps): ContractOperatorService {
  /** Present while this daemon hosts sessions. */
  let hostedRunners: HostedContractRunners | null = null;
  /** The daemon's Work runners, one per project whose Work it holds (each runs only its own project's work). */
  const nativeRunners = new Set<Pick<ContractRunner, 'get' | 'list' | 'reply'>>();
  /** The Work runner that holds this contract (its project's), if one does. */
  const nativeHolding = (contractId: string): Pick<ContractRunner, 'get' | 'list' | 'reply'> | undefined =>
    [...nativeRunners].find((runner) => runner.get(contractId) !== null);
  let dispatcher: OperatorWorkDispatcher | null = null;
  const runners = (): readonly Pick<ContractRunner, 'get' | 'list' | 'reply' | 'held'>[] => [...(deps.runner ? [deps.runner] : []), ...nativeRunners, ...(hostedRunners?.runners() ?? [])];
  /** Why a stored contract is held without running, from the runner holding it; null when none holds it. */
  const holdOf = (contractId: string): ContractHold | null => {
    for (const runner of runners()) {
      const hold = runner.held?.(contractId) ?? null;
      if (hold !== null) return hold;
    }
    return null;
  };
  const summaryOf = (contract: ContractView): ContractSummary => summarizeContract(contract, holdOf(contract.id));

  /** Whether `caller` may act in session `sessionId`: it is not owned by other identified principals. */
  function sessionOpenTo(sessionId: string, caller: OperatorCaller | undefined): boolean {
    return caller === undefined || hostedRunners?.ownedByOthers?.(sessionId, caller.principalId) !== true;
  }

  /** The one ownership rule: whether `caller` may see and act on a contract. One string compare when it records its principal. */
  function visibleTo(contract: ContractOwnership, caller: OperatorCaller | undefined): boolean {
    if (caller === undefined) return true;
    if (contract.ownerPrincipalId !== undefined) return contract.ownerPrincipalId === caller.principalId;
    return sessionOpenTo(contract.sessionId, caller);
  }

  /** The runner holding a contract the caller may see, with its view; first found wins. */
  /**
   * The runners to read one contract from, the one that runs it first. The daemon's Work (a durable native admission)
   * is run by the native runner; the other runner reads the same stored record, which is not the live one, so a
   * question the work asked or an answer it took would not show from it.
   */
  function runnersFor(contractId: string): readonly Pick<ContractRunner, 'get' | 'list' | 'reply'>[] {
    const all = runners();
    const native = nativeHolding(contractId);
    if (native === undefined) return all;
    const stored = all.map((runner) => runner.get(contractId)).find((contract) => contract !== null);
    return stored?.durableAdmission !== undefined ? [native, ...all.filter((runner) => runner !== native)] : all;
  }

  function holder(contractId: string, caller?: OperatorCaller): { readonly runner: Pick<ContractRunner, 'get' | 'list' | 'reply'>; readonly contract: ContractView } {
    for (const runner of runnersFor(contractId)) {
      const contract = runner.get(contractId);
      if (contract !== null && visibleTo(contract, caller)) return { runner, contract };
      if (contract !== null) break;
    }
    throw new ContractOperatorError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
  }

  async function start(input: OperatorStartInput): Promise<OperatorStartedContract> {
    const ask = input.ask;
    if (ask.trim().length === 0) throw new ContractOperatorError('ask is required', 'INVALID_ARGUMENT', 400, 'ask');
    if (input.workspaceRoot !== undefined && !isAbsolute(input.workspaceRoot)) {
      throw new ContractOperatorError(
        `workspaceRoot must be an absolute path; '${input.workspaceRoot}' is not.`,
        'INVALID_ARGUMENT',
        400,
        'workspaceRoot',
      );
    }
    if (input.sessionId !== undefined && !sessionOpenTo(input.sessionId, { principalId: input.principalId })) {
      throw new ContractOperatorError(
        `Hosted session ${input.sessionId} belongs to another caller, so a contract cannot be started in it from this identity. Omit sessionId, or attach to that session first.`,
        'SESSION_NOT_OWNED',
        403,
        'sessionId',
      );
    }
    const hosted = input.sessionId === undefined || hostedRunners === null ? null : await hostedRunners.forSession(input.sessionId);
    if (hosted !== null && input.workspaceRoot !== undefined && input.workspaceRoot !== hosted.workspaceRoot) {
      throw new ContractOperatorError(
        `Hosted session ${input.sessionId} works in ${hosted.workspaceRoot}, not ${input.workspaceRoot}.`,
        'INVALID_ARGUMENT',
        400,
        'workspaceRoot',
      );
    }
    if (hosted === null && input.sessionId !== undefined && hostedRunners?.knows?.(input.sessionId) === true) {
      throw new ContractOperatorError(
        `Hosted session ${input.sessionId} is not live on this daemon (it ended or has no loop), so a contract started in it would run in the daemon's own workspace instead of the session's. Start it in a live session, or omit sessionId.`,
        'SESSION_NOT_LIVE',
        409,
        'sessionId',
      );
    }
    // Without a hosted session the contract's agents work in this directory with the daemon's rights.
    if (hosted === null && input.workspaceRoot !== undefined && !isWithin(deps.workingDirectory, input.workspaceRoot)) {
      throw new ContractOperatorError(
        `workspaceRoot ${input.workspaceRoot} is outside this daemon's workspace ${deps.workingDirectory}. Omit workspaceRoot, or start the contract in a hosted session that works there.`,
        'INVALID_ARGUMENT',
        400,
        'workspaceRoot',
      );
    }
    const origin: ContractOrigin = hosted === null ? 'external' : 'hosted';
    const runner = hosted?.runner ?? deps.runner;
    if (!runner) throw new ContractOperatorError('This program runs no contracts: work runs on the daemon. Ask for it in Work.', 'CONTRACT_NATIVE', 409);
    const startInput: StartContractInput = {
      ask,
      ...(hosted?.selectedModel === undefined ? {} : { selectedModel: hosted.selectedModel }),
      sessionId: input.sessionId ?? OPERATOR_SESSION_ID,
      origin,
      projectRoot: hosted?.workspaceRoot ?? input.workspaceRoot ?? deps.workingDirectory,
      ...(input.principalId === undefined ? {} : { ownerPrincipalId: input.principalId }),
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
      ...(input.dispatch?.sessionCreated === true ? { sessionCreatedForDispatch: true as const } : {}),
    };
    if (input.idempotencyKey !== undefined && runner.startIdempotent !== undefined) {
      const keyed = await runner.startIdempotent(startInput, { principalId: input.principalId ?? '', key: input.idempotencyKey,
        ...(input.dispatch === undefined ? {} : { fingerprint: 'dispatch' as const }) });
      return {
        contract: projectContractOperatorView(keyed.contract),
        ownerAgentId: keyed.ownerAgentId,
        ...(keyed.replayed ? { replayed: true } : {}),
      };
    }
    const started = await runner.start(startInput);
    return { contract: projectContractOperatorView(started.contract), ownerAgentId: started.owner.id };
  }

  /** Every contract the caller may see across the runners, newest first, without the captured input. */
  function visibleContracts(filter: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }, caller: OperatorCaller | undefined): ContractView[] {
    const seen = new Set<string>();
    const contracts: ContractView[] = [];
    for (const runner of runners()) {
      const admit = caller === undefined ? undefined : (owner: ContractOwnership): boolean => visibleTo(owner, caller);
      for (const contract of runner.list({ ...filter, includeInputSnapshot: false, ...(admit === undefined ? {} : { admit }) })) {
        if (seen.has(contract.id)) continue;
        seen.add(contract.id);
        // A runner that does not apply `admit` (a custom one) is filtered here.
        if (!visibleTo(contract, caller)) continue;
        contracts.push(contract);
      }
    }
    return contracts.sort((a, b) => b.createdAt - a.createdAt);
  }

  return {
    list(filter = {}, caller) {
      return visibleContracts(filter, caller).map((contract) => summarized(projectContractOperatorView(contract)));
    },
    summaries(filter = {}, caller) {
      return visibleContracts(filter, caller).map(summaryOf);
    },
    get(contractId, caller, options = {}) {
      for (const runner of runnersFor(contractId)) {
        const contract = runner.get(contractId);
        if (contract === null) continue;
        if (!visibleTo(contract, caller)) return null;
        const view = projectContractOperatorView(contract);
        return options.includeInputFiles === true ? view : withoutInputFiles(view);
      }
      return null;
    },
    status(contractId, caller) {
      for (const runner of runnersFor(contractId)) {
        const contract = runner.get(contractId);
        if (contract !== null) return visibleTo(contract, caller) ? summaryOf(contract) : null;
      }
      return null;
    },
    start,
    cancel(contractId, reason, caller) {
      const { runner } = holder(contractId, caller);
      if (nativeRunners.has(runner)) {
        throw new ContractOperatorError(`Contract ${contractId} is native work: stop it through the native work execution, or answer its open question with "cancel".`, 'CONTRACT_NATIVE', 409);
      }
      // A contract held because no run claim could be taken may be running in another process: it is not ended here.
      const hold = holdOf(contractId);
      if (hold !== null && hold.code === 'claim-unavailable') {
        throw new ContractOperatorError(`Contract ${contractId} is held and not run here: ${hold.reason}. Another process may be running it, so it is not cancelled from here; make the project's .goodvibes/contracts directory writable and restart, then cancel it.`, 'CONTRACT_HELD', 409);
      }
      if ((runner as OperatorContractRunner).cancel(contractId, reason)) return true;
      // A stored contract that is not ended but has no live run here was left for inspection (another mode's record, or an admission only a durable resume adopts).
      const stored = runner.get(contractId);
      if (stored !== null && !isTerminalContractStatus(stored.status)) throw notRunning(contractId, stored.status);
      return false;
    },
    async reply(contractId, escalationId, text, caller) {
      const held = holder(contractId, caller);
      const { contract } = held;
      // The daemon's Work is run by the native runner; another runner reading the same stored record never runs it.
      const runner = (contract.durableAdmission !== undefined ? nativeHolding(contractId) : undefined) ?? held.runner;
      if (isTerminalContractStatus(contract.status)) {
        throw new ContractOperatorError(`Contract ${contractId} has ended (${contract.status}); there is nothing to reply to.`, 'CONTRACT_ENDED', 409);
      }
      try {
        return await runner.reply(contractId, escalationId, text);
      } catch (error) {
        // The runner refuses a reply when it has no live run for the contract; say that, not a server error.
        if (error instanceof OwnerReplyRefusedError && error.refusal === 'ended') {
          const stored = runner.get(contractId);
          if (stored !== null && !isTerminalContractStatus(stored.status)) throw notRunning(contractId, stored.status);
          throw new ContractOperatorError(error.message, 'CONTRACT_ENDED', 409);
        }
        if (error instanceof OwnerReplyRefusedError) {
          if (error.refusal === 'not-open' || error.refusal === 'already-reading') throw new ContractOperatorError(error.message, 'ESCALATION_NOT_OPEN', 409);
          throw new ContractOperatorError(error.message, 'INVALID_ARGUMENT', 400, 'text');
        }
        throw error;
      }
    },
    remove(contractId, caller) {
      const { runner, contract } = holder(contractId, caller);
      if (nativeRunners.has(runner) || contract.durableAdmission !== undefined) {
        throw new ContractOperatorError(`Contract ${contractId} is native work: its record belongs to the native work execution and is kept with it.`, 'CONTRACT_NATIVE', 409);
      }
      const outcome = (runner as OperatorContractRunner).remove?.(contractId);
      if (outcome === undefined) throw new ContractOperatorError(`The runner holding contract ${contractId} cannot remove contracts.`, 'CONTRACT_NOT_RUNNING', 409);
      if (outcome === 'removed') return { removed: true };
      if (outcome === 'not-found') throw new ContractOperatorError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
      if (outcome === 'native') throw new ContractOperatorError(`Contract ${contractId} is native work: its record belongs to the native work execution and is kept with it.`, 'CONTRACT_NATIVE', 409);
      throw new ContractOperatorError(`Contract ${contractId} is ${contract.status} and has not ended; cancel it first, then remove it once it has stopped.`, 'CONTRACT_NOT_ENDED', 409);
    },
    async retryUnit(contractId, unitId, caller) {
      const { runner, contract } = holder(contractId, caller);
      if (isTerminalContractStatus(contract.status)) throw new ContractOperatorError(`Contract ${contractId} has ended (${contract.status}); start a new contract for the remaining work.`, 'CONTRACT_ENDED', 409);
      const failedPause = contract.escalations.find((item) => item.resolvedAt === undefined && item.failurePause === true && item.scope === 'unit' && item.targetId === unitId);
      if (nativeRunners.has(runner) || (contract.nativeSource !== undefined && failedPause !== undefined)) {
        // Work's steps are run by its native execution, which decides each of them; a failed step waits on its
        // pause, and running it again is answering that pause "retry", as the owner may. After a restart of the
        // daemon the run is kept but not live: CONTRACT_NOT_RUNNING says so, and its execution resumes it first.
        const pause = failedPause;
        const step = `"${contract.units.find((unit) => unit.id === unitId)?.title || unitId}"`;
        if (pause === undefined) {
          throw new ContractOperatorError(`Step ${step} has not failed, so there is nothing to run again; a step of this work runs again only after it failed.`, 'CONTRACT_NATIVE', 409);
        }
        const answering = (contract.durableAdmission !== undefined ? nativeHolding(contractId) : undefined) ?? runner;
        try { await answering.reply(contractId, pause.id, 'retry'); } catch (error) {
          if (error instanceof OwnerReplyRefusedError) {
            // A run not live here (after a restart of the daemon) is not ended: its execution resumes it.
            if (error.refusal === 'ended' && !isTerminalContractStatus(contract.status)) throw notRunning(contractId, contract.status);
            throw new ContractOperatorError(error.message, error.refusal === 'ended' ? 'CONTRACT_ENDED' : 'ESCALATION_NOT_OPEN', 409);
          }
          throw error;
        }
        return { outcome: 'restarted', reason: `step ${step} failed and runs again with a fresh agent; the steps waiting on it run once it is done` };
      }
      const retry = (runner as OperatorContractRunner).retryUnit;
      if (retry === undefined) throw new ContractOperatorError(`The runner holding contract ${contractId} cannot run a unit again.`, 'CONTRACT_NOT_RUNNING', 409);
      return retry.call(runner, contractId, unitId);
    },
    raiseBudget(contractId, ceiling, caller) {
      const valid = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value >= 0);
      if ((ceiling.maxCostUsd === undefined && ceiling.maxTokens === undefined) || !valid(ceiling.maxCostUsd) || !valid(ceiling.maxTokens)) {
        throw new ContractOperatorError('Give maxCostUsd, maxTokens or both, each a number of 0 or more.', 'INVALID_ARGUMENT', 400, 'maxCostUsd');
      }
      const { runner, contract } = holder(contractId, caller);
      // Work the daemon runs from the ledger changes its limit through its own runner, as any other run does.
      if (isTerminalContractStatus(contract.status)) throw new ContractOperatorError(`Contract ${contractId} has ended (${contract.status}); its budget can no longer change.`, 'CONTRACT_ENDED', 409);
      const raise = (runner as OperatorContractRunner).raiseBudget;
      if (raise === undefined || !raise.call(runner, contractId, ceiling)) throw notRunning(contractId, contract.status);
      return { budget: { ...(runner.get(contractId)?.budget ?? ceiling) } };
    },
    attachHosted(hosted) {
      hostedRunners = hosted;
    },
    attachNative(runner) {
      // One per project: a project's Work joins beside the others'; null takes every one out (the daemon closing).
      if (runner === null) nativeRunners.clear();
      else nativeRunners.add(runner);
      return () => { if (runner !== null) nativeRunners.delete(runner); };
    },
    async dispatch(input) {
      if (input.ask.trim().length === 0) throw new ContractOperatorError('ask is required', 'INVALID_ARGUMENT', 400, 'ask');
      if (dispatcher === null) {
        throw new ContractOperatorError('This daemon hosts no sessions, so it cannot dispatch work into a new one. Use contracts.start, which runs the work on the daemon\'s own runner.', 'NOT_HOSTING', 409);
      }
      // workspaceRoot is admitted where the session is created: the hosted
      // session manager's rule (the daemon's working directory and registered
      // workspaces), refused there as INVALID_ARGUMENT.
      const handle = await dispatcher.dispatch({
        task: input.ask,
        metadata: {
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
          // The adapter records the caller as the owner of the session it creates and of the contract.
          ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
          // Keys are per caller (the adapter scopes the key by principalId, as contracts.start does):
          // another caller's key never returns this caller's work.
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        },
      });
      const contract = holder(handle.externalTaskId).contract;
      return { contract: projectContractOperatorView(contract), ownerAgentId: contract.ownerAgentId };
    },
    attachDispatcher(next) {
      dispatcher = next;
      return () => {
        if (dispatcher === next) dispatcher = null;
      };
    },
  };
}
