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
 * Every choice here is code over ids and recorded statuses; nothing is judged.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { OwnerReplyRefusedError, type OwnerReplyOutcome } from './escalation.js';
import type { ContractRunner } from './runner.js';
import { isTerminalContractStatus, type ContractOrigin, type ContractView, type NativeContractSource } from './types.js';

/** The session a contract started over the operator surface without a session belongs to. */
export const OPERATOR_SESSION_ID = 'operator';

/** The runner surface the service reads and acts through. */
export type OperatorContractRunner = Pick<ContractRunner, 'start' | 'get' | 'list' | 'cancel' | 'reply'>;

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
}

export interface OperatorStartedContract {
  readonly contract: ContractView;
  readonly ownerAgentId: string;
}

export interface ContractOperatorService {
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }): ContractView[];
  get(contractId: string): ContractView | null;
  start(input: OperatorStartInput): Promise<OperatorStartedContract>;
  /** False when the contract is known but already ended. */
  cancel(contractId: string, reason: string): boolean;
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /**
   * Joins the hosted-session runners in, or takes them out with null. The
   * hosted-session engine is composed after the runtime services that build
   * this service, so it attaches itself when it exists.
   */
  attachHosted(hosted: HostedContractRunners | null): void;
  /**
   * Joins the daemon's native work execution runner in, or takes it out with
   * null. Its contracts can be read and their open failure question answered
   * (retry or cancel); they are not started or stopped from here, because the
   * native work execution owns that.
   */
  attachNative(runner: Pick<ContractRunner, 'get' | 'list' | 'reply'> | null): void;
}

export type ContractOperatorErrorCode =
  | 'CONTRACT_NOT_FOUND'
  | 'CONTRACT_ENDED'
  /** The runner holds the contract but is not running it (held for inspection). */
  | 'CONTRACT_NOT_RUNNING'
  /** Native work is stopped through its own execution, not this surface. */
  | 'CONTRACT_NATIVE'
  /** The session id names a hosted session that is no longer live. */
  | 'SESSION_NOT_LIVE'
  /** The session id names a hosted session another caller owns. */
  | 'SESSION_NOT_OWNED'
  /** The escalation is answered, or another reply to it is being read. */
  | 'ESCALATION_NOT_OPEN'
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
  /** The daemon's own runner. */
  readonly runner: OperatorContractRunner;
  /** Where a contract started without a workspace or a hosted session works. */
  readonly workingDirectory: string;
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
  let nativeRunner: Pick<ContractRunner, 'get' | 'list' | 'reply'> | null = null;
  const runners = (): readonly Pick<ContractRunner, 'get' | 'list' | 'reply'>[] => [deps.runner, ...(nativeRunner === null ? [] : [nativeRunner]), ...(hostedRunners?.runners() ?? [])];

  /** The runner holding a contract, with its view; first found wins. */
  function holder(contractId: string): { readonly runner: Pick<ContractRunner, 'get' | 'list' | 'reply'>; readonly contract: ContractView } {
    for (const runner of runners()) {
      const contract = runner.get(contractId);
      if (contract !== null) return { runner, contract };
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
    if (input.sessionId !== undefined && hostedRunners?.ownedByOthers?.(input.sessionId, input.principalId) === true) {
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
    const started = await (hosted?.runner ?? deps.runner).start({
      ask,
      ...(hosted?.selectedModel === undefined ? {} : { selectedModel: hosted.selectedModel }),
      sessionId: input.sessionId ?? OPERATOR_SESSION_ID,
      origin,
      projectRoot: hosted?.workspaceRoot ?? input.workspaceRoot ?? deps.workingDirectory,
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    });
    return { contract: projectContractOperatorView(started.contract), ownerAgentId: started.owner.id };
  }

  return {
    list(filter = {}) {
      const seen = new Set<string>();
      const contracts: ContractView[] = [];
      for (const runner of runners()) {
        for (const contract of runner.list({ ...filter, includeInputSnapshot: false })) {
          if (seen.has(contract.id)) continue;
          seen.add(contract.id);
          contracts.push(summarized(projectContractOperatorView(contract)));
        }
      }
      return contracts.sort((a, b) => b.createdAt - a.createdAt);
    },
    get(contractId) {
      for (const runner of runners()) {
        const contract = runner.get(contractId);
        if (contract !== null) return projectContractOperatorView(contract);
      }
      return null;
    },
    start,
    cancel(contractId, reason) {
      const { runner } = holder(contractId);
      if (runner === nativeRunner) {
        throw new ContractOperatorError(`Contract ${contractId} is native work: stop it through the native work execution, or answer its open question with "cancel".`, 'CONTRACT_NATIVE', 409);
      }
      if ((runner as OperatorContractRunner).cancel(contractId, reason)) return true;
      // A stored contract that is not ended but has no live run here was left for inspection (another mode's record, or an admission only a durable resume adopts).
      const stored = runner.get(contractId);
      if (stored !== null && !isTerminalContractStatus(stored.status)) throw notRunning(contractId, stored.status);
      return false;
    },
    async reply(contractId, escalationId, text) {
      const { runner, contract } = holder(contractId);
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
    attachHosted(hosted) {
      hostedRunners = hosted;
    },
    attachNative(runner) {
      nativeRunner = runner;
    },
  };
}
