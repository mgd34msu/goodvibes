/**
 * work-tree-wiring.ts, connecting the conversation work tree to the live
 * runtime: the timing store fed by tool and turn events, agent lanes read
 * from the agent manager (contracts from the contract runner, cost from
 * the fleet read model), the call a permission prompt is holding, and the
 * per-session fold state.
 *
 * One call from main.ts; everything the work tree reads at render time goes
 * through the WorkTreeSources this installs.
 */
import type { AgentManager } from '@goodvibes/engine/platform/platform/tools';
import { isTerminalContractStatus, type ContractRunner, type ContractView } from '@goodvibes/engine/platform/platform/contract';
import type { ProcessNode } from '@goodvibes/engine/platform/platform/runtime/fleet';
import type { ConversationMessageSnapshot } from '@goodvibes/engine/platform/platform/core';
import type { UiRuntimeEvents } from '@goodvibes/engine/platform/platform/runtime/ui';
import { readTurnSettlement, TURN_SETTLING_EVENTS } from '@goodvibes/engine/transport-core/turn-settlement';
import type { WorkTreeController } from './work-tree-focus.js';
import type { WorkTreeSources } from './work-tree-sources.js';
export interface WorkTreeConversation {
    readonly workTree: WorkTreeController;
    readMessagesInPlace(): readonly ConversationMessageSnapshot[];
    setWorkTreeSources(sources: WorkTreeSources): void;
}
import { WorkTreeTimingStore, userMessageFingerprint, type AgentLaneInfo, type TurnOutcome } from './work-tree-sources.js';
import { loadWorkTreeFolds, loadWorkTreeTurnOutcomes, saveWorkTreeFolds, sweepOrphanWorkTreeFolds } from './work-tree-fold-store.js';
import { onSemanticSummaryReady } from './semantic-diff-memo.js';
import { onSyntaxHighlightReady } from './renderer/code-block.js';
type AgentRecord = ReturnType<AgentManager['list']>[number];
export interface WorkTreeWiringDeps {
    readonly conversation: WorkTreeConversation;
    /** Native contract-only lanes are a product presentation choice. */
    readonly includeContractOnlyAgents?: boolean | undefined;
    readonly events: UiRuntimeEvents;
    readonly agentManager: Pick<AgentManager, 'getStatus' | 'getConversationSnapshot'>;
    /** The session's cached contract snapshot (createSessionContractViews); its change events repaint the tree. */
    readonly contracts: SessionContractViews;
    readonly fleetNodes: () => readonly ProcessNode[];
    /** The call id a permission prompt is holding, if any. */
    readonly pendingCallId: () => string | undefined;
    readonly turnActive: () => boolean;
    readonly sessionsDir: string;
    readonly sessionId: () => string;
    /** Repaint (a ◈ summary of an opened edit landed). */
    readonly requestRender: () => void;
}
/**
 * One detached snapshot of the session's contracts, shared by every lookup a
 * frame makes (lanes, chips, breadcrumbs, the agent view). It leaves out the
 * captured repository manifest, is indexed by owner agent and by contract id,
 * and is rebuilt only after a contract event or a session change, so drawing a
 * frame copies nothing.
 */
export interface SessionContractViews {
    /** This session's contracts, ended ones included. */
    readonly read: () => readonly ContractView[];
    /** This session's contracts that have not ended. */
    readonly active: () => readonly ContractView[];
    readonly byOwner: (agentId: string) => ContractView | undefined;
    readonly byId: (contractId: string) => ContractView | undefined;
    /** Called after the snapshot is dropped, so a listener's next read is current. */
    readonly subscribe: (listener: () => void) => () => void;
    readonly dispose: () => void;
}
interface ContractSnapshot {
    readonly session: string;
    readonly list: readonly ContractView[];
    active?: readonly ContractView[];
    readonly byOwner: ReadonlyMap<string, ContractView>;
    readonly byId: ReadonlyMap<string, ContractView>;
}
/**
 * The snapshot is dropped on every runner change. `moreChanges` is an optional
 * second feed for contract events the runner does not announce itself (gate
 * results published on the runtime bus), so the snapshot stays current for them.
 */
export function createSessionContractViews(runner: Pick<ContractRunner, 'list' | 'on'>, sessionId: () => string, moreChanges?: (listener: () => void) => () => void): SessionContractViews {
    let snapshot: ContractSnapshot | undefined;
    const listeners = new Set<() => void>();
    const current = (): ContractSnapshot => {
        const session = sessionId();
        if (snapshot !== undefined && snapshot.session === session)
            return snapshot;
        const list = Object.freeze(runner.list({ sessionId: session, includeTerminal: true, includeInputSnapshot: false }));
        const byOwner = new Map<string, ContractView>();
        const byId = new Map<string, ContractView>();
        for (const view of list) {
            // First in the runner's order wins, as the linear search this replaces did.
            if (!byOwner.has(view.ownerAgentId))
                byOwner.set(view.ownerAgentId, view);
            byId.set(view.id, view);
        }
        snapshot = { session, list, byOwner, byId };
        return snapshot;
    };
    const changed = (): void => {
        snapshot = undefined;
        for (const listener of [...listeners])
            listener();
    };
    const stops = [runner.on(changed), ...(moreChanges ? [moreChanges(changed)] : [])];
    const stop = (): void => { for (const unsubscribe of stops) unsubscribe(); };
    return {
        read: () => current().list,
        active: () => {
            const view = current();
            return view.active ??= Object.freeze(view.list.filter((contract) => !isTerminalContractStatus(contract.status)));
        },
        byOwner: (agentId) => current().byOwner.get(agentId),
        byId: (contractId) => current().byId.get(contractId),
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        dispose() {
            stop();
            listeners.clear();
            snapshot = undefined;
        },
    };
}
/** Most finished-agent transcripts kept; a dropped one is simply read again. */
const MAX_SNAPSHOTS = 200;
/** A finished agent's transcript never changes: read it once. */
interface SnapshotMemo {
    readonly stamp: string;
    readonly messages: readonly ConversationMessageSnapshot[];
}
export interface WorkTreeWiring {
    readonly timings: WorkTreeTimingStore;
    readonly unsubs: Array<() => void>;
    readonly syncSession: () => void;
}
export function wireWorkTree(deps: WorkTreeWiringDeps): WorkTreeWiring {
    const timings = new WorkTreeTimingStore();
    const unsubs: Array<() => void> = [];
    const { conversation, events } = deps;
    unsubs.push(deps.contracts.subscribe(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
    unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => timings.callStarted(ev.callId, ev.startedAt)));
    unsubs.push(events.tools.on('TOOL_SUCCEEDED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
    unsubs.push(events.tools.on('TOOL_FAILED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
    unsubs.push(events.tools.on('TOOL_CANCELLED', (ev) => timings.callSettled(ev.callId, undefined, Date.now())));
    // Everything the session sidecar keeps: fold decisions and failed/cancelled turn endings.
    // A session id can move without a resume (crash recovery sets it directly). The
    // first save under a new id, or the next frame's sync, first reads that session's
    // sidecar, so the live state of the previous session never overwrites it. Live keys
    // win: a toggle made this instant is not undone, and a replaced transcript has
    // already cleared its folds (resetAll, fromJSON).
    let syncedSession: string | undefined;
    const reconcileSession = (): void => {
        const current = deps.sessionId();
        if (current === syncedSession)
            return;
        syncedSession = current;
        const liveFolds = new Set(conversation.workTree.foldState().map(([key]) => key));
        conversation.workTree.restoreFoldState(loadWorkTreeFolds(deps.sessionsDir, current).filter(([key]) => !liveFolds.has(key)));
        const liveTurns = new Set(conversation.workTree.turnOutcomes().map((record) => record.index));
        conversation.workTree.restoreTurnOutcomes(loadWorkTreeTurnOutcomes(deps.sessionsDir, current).filter((record) => !liveTurns.has(record.index)));
    };
    const persistView = (): void => {
        reconcileSession();
        saveWorkTreeFolds(deps.sessionsDir, deps.sessionId(), conversation.workTree.foldState(), conversation.workTree.turnOutcomes());
    };
    // A duplicate submission is announced as a new turn and then refused. It never
    // appends a message, so it shares the running turn's message index; its ids are
    // remembered so the refusal cannot close that running turn.
    const rejectedDuplicateTurnIds = new Set<string>();
    unsubs.push(events.turns.on('TURN_SUBMITTED', (ev) => {
        const snapshot = conversation.readMessagesInPlace();
        for (let i = snapshot.length - 1; i >= 0; i--) {
            if (snapshot[i]!.role === 'user') {
                if (timings.isTurnOpen(i))
                    rejectedDuplicateTurnIds.add(ev.turnId);
                else
                    timings.turnStarted(i, Date.now(), userMessageFingerprint(snapshot[i]));
                break;
            }
        }
    }));
    const endTurn = (outcome: TurnOutcome, turnId: string): void => {
        if (rejectedDuplicateTurnIds.delete(turnId))
            return;
        reconcileSession();
        const ended = timings.turnEnded(Date.now(), outcome);
        // The header drops "working" and states a failure on the next build.
        conversation.workTree.invalidate();
        if (!ended || ended.timing.fingerprint === undefined)
            return;
        if (conversation.workTree.recordTurnOutcome({ index: ended.index, fingerprint: ended.timing.fingerprint, outcome }))
            persistView();
    };
    // How the turn ended, from the one settlement reader: an empty answer and a refused turn are failures.
    for (const type of TURN_SETTLING_EVENTS) {
        unsubs.push(events.turns.on(type, (ev) => {
            const settlement = readTurnSettlement({ type, payload: ev });
            if (settlement)
                endTurn(settlement.kind === 'answered' ? 'completed' : settlement.kind === 'cancelled' ? 'cancelled' : 'failed', settlement.turnId);
        }));
    }
    const snapshots = new Map<string, SnapshotMemo>();
    // A new or resumed transcript: turn timings are keyed by message index and belong to the old one.
    unsubs.push(conversation.workTree.onReset(() => { timings.clear(); snapshots.clear(); rejectedDuplicateTurnIds.clear(); }));
    const messagesOf = (record: AgentRecord): readonly ConversationMessageSnapshot[] => {
        const finished = record.status !== 'running' && record.status !== 'pending';
        const stamp = `${record.status}:${record.completedAt ?? ''}:${record.toolCallCount}`;
        const memo = snapshots.get(record.id);
        if (finished && memo && memo.stamp === stamp)
            return memo.messages;
        const messages = deps.agentManager.getConversationSnapshot(record.id);
        if (finished) {
            snapshots.delete(record.id);
            snapshots.set(record.id, { stamp, messages });
            // Oldest first out: a long session keeps the most recent finished agents.
            while (snapshots.size > MAX_SNAPSHOTS) {
                const oldest = snapshots.keys().next();
                if (oldest.done)
                    break;
                snapshots.delete(oldest.value);
            }
        }
        return messages;
    };
    const costOf = (agentId: string): number | undefined => {
        const node = deps.fleetNodes().find((n) => n.id === agentId);
        // Only a real reading: an unpriced node has no cost to state.
        return node && node.costState !== 'unpriced' && typeof node.costUsd === 'number' ? node.costUsd : undefined;
    };
    const agent = (agentId: string): AgentLaneInfo | null => {
        const record = deps.agentManager.getStatus(agentId);
        const contract = deps.contracts.byOwner(agentId);
        if (!record && !contract)
            return null;
        if (!record && contract && deps.includeContractOnlyAgents)
            return {
                id: agentId, name: 'owner', task: contract.ask,
                status: contract.status === 'passed' ? 'completed' : contract.status === 'failed' ? 'failed' : contract.status === 'cancelled' ? 'cancelled' : 'running',
                startedAt: contract.createdAt, completedAt: contract.completedAt,
                toolCallCount: 0, costUsd: costOf(agentId), messages: [], contract,
            };
        if (!record)
            return null;
        return {
            id: record.id,
            name: record.template,
            task: record.task,
            status: record.status,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
            toolCallCount: record.toolCallCount,
            costUsd: costOf(record.id),
            error: record.error,
            messages: contract ? [] : messagesOf(record),
            contract,
        };
    };
    conversation.setWorkTreeSources({
        contract: agentId => deps.contracts.byOwner(agentId),
        callTiming: (callId) => timings.callTiming(callId),
        turnTiming: (index) => timings.turnTiming(index),
        agent,
        waitingCallIds: () => {
            const id = deps.pendingCallId();
            return id ? new Set([id]) : new Set<string>();
        },
        turnActive: deps.turnActive,
        turnOutcome: (index) => conversation.workTree.turnOutcome(index),
        now: () => Date.now(),
    });
    // Fold decisions persist per session, beside the session file.
    conversation.workTree.onFoldChange(persistView);
    unsubs.push(() => conversation.workTree.onFoldChange(null));
    sweepOrphanWorkTreeFolds(deps.sessionsDir);
    unsubs.push(onSemanticSummaryReady(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
    unsubs.push(onSyntaxHighlightReady(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
    // Products may resume or recover sessions through several routes; each frame's call
    // costs one string compare and reads the sidecar once per new session id.
    return { timings, unsubs, syncSession: reconcileSession };
}
/**
 * Restore a resumed session's fold decisions and failed/cancelled turn
 * endings (called by the resume routine, after the transcript is restored).
 */
export function restoreWorkTreeFolds(conversation: WorkTreeConversation, sessionsDir: string, sessionId: string): number {
    const entries = loadWorkTreeFolds(sessionsDir, sessionId);
    conversation.workTree.restoreFoldState(entries);
    conversation.workTree.restoreTurnOutcomes(loadWorkTreeTurnOutcomes(sessionsDir, sessionId));
    return entries.length;
}
