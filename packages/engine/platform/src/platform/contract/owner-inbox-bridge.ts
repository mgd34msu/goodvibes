/**
 * A contract's questions to its owner in the owner inbox.
 *
 * Every question a contract puts to its owner (a failed unit's retry or
 * cancel, the no-decision-model "accept the finished result", a plan or
 * criteria it could not settle) is posted as an inbox question, so the
 * terminal apps' /questions, the web UI and the phone show it beside
 * everything else waiting on the owner. Answering it there is the same reply
 * `contracts.reply` gives: the answer is handed to the contract's runner,
 * which takes the first reply to a question and refuses later ones. A reply
 * given elsewhere (contracts.reply, the contract's session) withdraws the
 * inbox item, and so does the contract ending.
 *
 * An answer the contract does not take (a word the question does not accept)
 * leaves the contract's question open, so it is posted again with why. An
 * answer given while the host was down is applied when the host next hears
 * from that contract, or at start.
 *
 * Cost: one inbox write per question and per answer; one contract read per
 * contract event that names a question. Nothing per model request.
 */
import type { ContractEvent } from '../../events/contract.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { ACCEPTANCE_ANSWERS, isOwnerAcceptance, isRepeatedPlanPause, type OwnerReplyOutcome } from './escalation.js';
import type { ContractView } from './types.js';

/** Key prefix of the inbox items this bridge posts; the escalation id follows. */
export const CONTRACT_QUESTION_KEY_PREFIX = 'contract-question:';

/** The contracts a host runs: the operator service in the daemon, the runner in a terminal app. */
export interface ContractQuestionSource {
  get(contractId: string): ContractView | null;
  list(filter?: { readonly includeTerminal?: boolean | undefined }): readonly ContractView[];
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
}

/** The contract events the bridge follows. */
export type ContractQuestionEvent = Pick<ContractEvent, 'type'> & { readonly contractId?: string | undefined; readonly escalationId?: string | undefined };

interface QuestionItem {
  readonly id: string;
  readonly status: string;
  readonly key?: string | undefined;
  readonly answer?: { readonly option?: string | undefined; readonly text?: string | undefined } | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** The inbox the questions go to (the daemon's, or the home store a terminal app opens). */
export interface ContractQuestionInbox {
  postNow(input: {
    readonly kind: 'question'; readonly title: string; readonly detail?: string | undefined; readonly options?: readonly string[] | undefined;
    readonly askedBy?: string | undefined; readonly key?: string | undefined; readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  }, postedBy?: string): { readonly created: boolean; readonly item: QuestionItem };
  latestByKey(kind: 'question', key: string): QuestionItem | undefined;
  listNow(filter?: { readonly status?: 'open' | 'closed' | 'all' | undefined; readonly kinds?: readonly 'question'[] | undefined; readonly limit?: number | undefined }): readonly QuestionItem[];
  withdraw(id: string, reason: string): unknown;
  subscribe(listener: (item: QuestionItem) => void): () => void;
}

type Escalation = ContractView['escalations'][number];

const FAILURE_ANSWERS = ['retry', 'cancel'] as const;
const DETAIL_CHARS = 4000;
const TITLE_CHARS = 200;

function keyOf(escalationId: string): string {
  return `${CONTRACT_QUESTION_KEY_PREFIX}${escalationId}`;
}

/** The answers an inbox item offers: the code-answered pairs as choices, anything else as a written reply. */
function optionsFor(escalation: Escalation): readonly string[] {
  // A repeated plan takes the owner's words (what to change) or "stop": a written reply.
  if (escalation.failurePause !== true || isRepeatedPlanPause(escalation)) return [];
  return isOwnerAcceptance(escalation) ? ACCEPTANCE_ANSWERS : FAILURE_ANSWERS;
}

/**
 * A failed step of work run by agents (the daemon's Work, or a program's own agent contract): a state shown on the work
 * with its controls, never posted as a question. Only a session-mode contract (its steps are the conversation's own
 * turns) still asks.
 */
function isWorkStepFailure(contract: ContractView, escalation: Escalation): boolean {
  return escalation.failurePause === true && escalation.scope === 'unit' && !isOwnerAcceptance(escalation) && contract.sessionMode !== true;
}

function titleFor(contract: ContractView, escalation: Escalation): string {
  const what = (contract.goal || contract.ask).replace(/\s+/g, ' ').trim();
  const lead = escalation.failurePause !== true ? 'A piece of work needs your answer'
    : isOwnerAcceptance(escalation) ? 'Accept a piece of work\'s result that was not checked?'
      : isRepeatedPlanPause(escalation) ? 'The planner offered the same plan again'
      : 'Run again or stop a piece of work that failed?';
  const title = what.length > 0 ? `${lead}: ${what}` : lead;
  return title.length <= TITLE_CHARS ? title : `${title.slice(0, TITLE_CHARS - 3)}...`;
}

function clipDetail(text: string): string {
  return text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS - 3)}...`;
}

function textOf(item: QuestionItem): string {
  return (item.answer?.option ?? item.answer?.text ?? '').trim();
}

/** The contract events of a runtime bus, as the bridge reads them (every floor's runner publishes there). */
export function contractQuestionEventsOf(bus: Pick<RuntimeEventBus, 'on'>): (listener: (event: ContractQuestionEvent) => void) => () => void {
  const types = ['CONTRACT_ESCALATED', 'CONTRACT_OWNER_REPLIED', 'CONTRACT_PASSED', 'CONTRACT_FAILED', 'CONTRACT_CANCELLED'] as const;
  // The bus types each listener by its event; these are read field by field, so one envelope shape serves all five.
  const on = bus.on.bind(bus) as unknown as (type: string, listener: (envelope: { readonly payload: unknown }) => void) => () => void;
  return (listener) => {
    const unsubscribers = types.map((type) => on(type, (envelope) => {
      const payload = envelope.payload as { readonly contractId?: unknown; readonly escalationId?: unknown } | null;
      listener({
        type,
        ...(typeof payload?.contractId === 'string' ? { contractId: payload.contractId } : {}),
        ...(typeof payload?.escalationId === 'string' ? { escalationId: payload.escalationId } : {}),
      });
    }));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  };
}

/** Post each open contract question to the inbox and hand each inbox answer to its contract. Returns the stop. */
export function bridgeContractQuestionsToInbox(
  contracts: ContractQuestionSource,
  events: (listener: (event: ContractQuestionEvent) => void) => () => void,
  inbox: ContractQuestionInbox,
  /** Settles when the host has loaded the contracts it resumes at start; their questions are brought in then. */
  options: { readonly loaded?: Promise<unknown> | undefined } = {},
): () => void {
  /** Inbox items whose answer is being handed to the contract now. */
  const applying = new Set<string>();
  /** Contracts whose questions were brought in line with the inbox since this host started. */
  const synced = new Set<string>();
  let stopped = false;

  const openEscalation = (contractId: string, escalationId: string): { contract: ContractView; escalation: Escalation } | undefined => {
    const contract = contracts.get(contractId);
    const escalation = contract?.escalations.find((candidate) => candidate.id === escalationId && candidate.resolvedAt === undefined);
    return contract && escalation ? { contract, escalation } : undefined;
  };

  const post = (contract: ContractView, escalation: Escalation, note?: string): void => {
    // A failed step of the daemon's Work is not a question: the work stops at that step and the Work place shows it,
    // with its own controls (run it again, go on without it, stop the work). Nothing is asked of anyone.
    if (isWorkStepFailure(contract, escalation)) return;
    try {
      inbox.postNow({
        kind: 'question',
        key: keyOf(escalation.id),
        title: titleFor(contract, escalation),
        detail: clipDetail(note === undefined ? escalation.question : `${note}\n\n${escalation.question}`),
        options: optionsFor(escalation),
        askedBy: 'your work',
        metadata: { contractId: contract.id, escalationId: escalation.id },
      }, 'contracts');
    } catch (error) {
      logger.warn('[contracts] a contract question could not be put in the owner inbox; contracts.reply still answers it', {
        contractId: contract.id, escalationId: escalation.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const withdrawWhere = (matches: (item: QuestionItem) => boolean, reason: string): void => {
    let open: readonly QuestionItem[];
    try { open = inbox.listNow({ status: 'open', kinds: ['question'], limit: 500 }); } catch { return; }
    for (const item of open) {
      if (!item.key?.startsWith(CONTRACT_QUESTION_KEY_PREFIX) || !matches(item)) continue;
      try { inbox.withdraw(item.id, reason); } catch { /* answered meanwhile */ }
    }
  };

  const apply = async (item: QuestionItem): Promise<void> => {
    if (item.status !== 'answered' || !item.key?.startsWith(CONTRACT_QUESTION_KEY_PREFIX) || applying.has(item.id)) return;
    const contractId = item.metadata?.['contractId'];
    const escalationId = item.metadata?.['escalationId'];
    if (typeof contractId !== 'string' || typeof escalationId !== 'string') return;
    // Answered elsewhere already, or a contract another host runs: nothing to hand on here.
    if (openEscalation(contractId, escalationId) === undefined) return;
    const text = textOf(item);
    applying.add(item.id);
    try {
      await contracts.reply(contractId, escalationId, text);
    } catch (error) {
      if (stopped) return;
      const still = openEscalation(contractId, escalationId);
      if (still === undefined) return;
      const why = error instanceof Error ? error.message : String(error);
      logger.info('[contracts] an inbox answer was not taken; the question is asked again', { contractId, escalationId, why });
      post(still.contract, still.escalation, `Your answer "${text.slice(0, 200)}" was not taken: ${why.slice(0, 600)}`);
    } finally {
      applying.delete(item.id);
    }
  };

  /** Bring one contract's questions in line with the inbox: post what is open, apply an answer it has not taken. */
  const sync = (contract: ContractView): void => {
    synced.add(contract.id);
    for (const escalation of contract.escalations) {
      if (escalation.resolvedAt !== undefined) continue;
      let latest: QuestionItem | undefined;
      try { latest = inbox.latestByKey('question', keyOf(escalation.id)); } catch { latest = undefined; }
      if (latest?.status === 'answered') void apply(latest);
      else if (latest?.status !== 'open') post(contract, escalation);
    }
  };

  const stopEvents = events((event) => {
    if (stopped || event.contractId === undefined) return;
    const contractId = event.contractId;
    switch (event.type) {
      case 'CONTRACT_ESCALATED': {
        const contract = contracts.get(contractId);
        if (contract === null) return;
        if (!synced.has(contractId)) { sync(contract); return; }
        const escalation = contract.escalations.find((candidate) => candidate.id === event.escalationId && candidate.resolvedAt === undefined);
        if (escalation !== undefined) post(contract, escalation);
        return;
      }
      case 'CONTRACT_OWNER_REPLIED':
        if (event.escalationId !== undefined) {
          const key = keyOf(event.escalationId);
          withdrawWhere((item) => item.key === key, 'Answered: the contract took a reply given outside the inbox.');
        }
        return;
      case 'CONTRACT_PASSED':
      case 'CONTRACT_FAILED':
      case 'CONTRACT_CANCELLED':
        withdrawWhere((item) => item.metadata?.['contractId'] === contractId, 'The contract has ended, so this question no longer needs an answer.');
        return;
      default: {
        // A contract heard from for the first time (resumed after a restart) may hold a question, or an answer it has not taken.
        if (synced.has(contractId)) return;
        const contract = contracts.get(contractId);
        if (contract !== null) sync(contract);
      }
    }
  });

  const stopAnswers = inbox.subscribe((item) => { if (!stopped) void apply(item); });

  // Questions asked, and answers given, while this host was not listening.
  const syncAll = (): void => {
    if (stopped) return;
    try {
      for (const contract of contracts.list({ includeTerminal: false })) if (!synced.has(contract.id)) sync(contract);
    } catch (error) {
      logger.warn('[contracts] open contract questions could not be read; each is posted when its contract is next heard from', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  syncAll();
  options.loaded?.then(syncAll, () => { /* resuming failed and says so itself */ });

  return () => {
    stopped = true;
    stopEvents();
    stopAnswers();
  };
}
