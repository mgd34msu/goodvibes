/**
 * work-plans.ts, a piece of work's plan before it runs, held by the daemon.
 *
 * With "Show me the plan before it runs" (`planner.showPlanFirst`) off, the
 * default, nothing here holds a work back: Start runs it, its planner writes
 * the plan, and the plan is opened from the run. With it on, Start writes the
 * plan first (the planning agent splits the goal and its done-when into
 * steps), and the work waits: its steps can be changed, reordered, taken out,
 * or the whole plan written again, then approved (that starts the work with
 * exactly that plan) or thrown away. The approved plan travels in the durable
 * run request (`draftPlan`), so the contract keeps its steps and the stored-run
 * check compares them.
 *
 * Drafts live in the daemon's project (the workstream draft store,
 * `.goodvibes/orchestration/drafts/`); which draft is which work's plan is one
 * small file beside them. Every change is announced (`onChange`), so every
 * surface showing Work reads it again.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { numberDraft } from '../../contract/draft-plan.js';
import type { DraftedPlan } from '../../contract/types.js';
import type { WorkstreamDraft, WorkstreamDraftService } from '../../orchestration/workstream-services.js';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { noteListChanged } from '../../runtime/list-changes.js';

export type WorkPlanState = 'writing' | 'waiting' | 'approved' | 'failed';

export interface WorkPlanStep { readonly id: string; readonly title: string; readonly brief: string; readonly dependsOn: readonly string[] }

export interface WorkPlanView {
  readonly workId: string;
  readonly state: WorkPlanState;
  readonly steps: readonly WorkPlanStep[];
  /** How it was written, in a person's words. */
  readonly how: string;
  readonly reason?: string | undefined;
}

export type WorkPlanGate = { readonly kind: 'run'; readonly draftPlan?: DraftedPlan | undefined } | { readonly kind: 'waiting' };

export interface WorkPlans {
  /** What Start may do for this work now (called by the native execution host before it admits a start). */
  gate(work: WorkPlanSubject): WorkPlanGate;
  get(workId: string): WorkPlanView | undefined;
  list(): readonly WorkPlanView[];
  /** Write the plan again from the work's goal (a person's "write it again"). */
  redo(work: WorkPlanSubject): Promise<WorkPlanView>;
  editStep(workId: string, step: string, brief: string): WorkPlanView;
  dropStep(workId: string, step: string): WorkPlanView;
  moveStep(workId: string, step: string, position: number): WorkPlanView;
  /** Mark it approved: the next Start runs with exactly these steps. */
  approve(workId: string): WorkPlanView;
  /** Throw the plan away; the work stays, not started. */
  discard(workId: string): boolean;
  /** The work started with its approved plan: the draft is done with. */
  started(workId: string): void;
  /**
   * Hold a piece of work proposed with its plan (a plan written in a conversation): it is not yet a piece of work,
   * only a plan waiting for the owner, under an id of its own; approving it asks for the work and `adopt`s the plan.
   */
  propose(proposal: WorkPlanProposal): { readonly id: string; readonly title: string; readonly steps: number };
  /** The proposed pieces of work still waiting, with what each asks for. */
  proposals(): readonly (WorkPlanView & { readonly goal: string; readonly criteria: readonly string[]; readonly at: number })[];
  /** What a proposal asks for, or undefined when `id` is not a proposal held here. */
  proposal(id: string): { readonly goal: string; readonly criteria: readonly string[] } | undefined;
  /** The proposal became the piece of work `workId`: its plan is that work's now. */
  adopt(proposalId: string, workId: string): void;
}

export interface WorkPlanSubject { readonly id: string; readonly goal: string; readonly criteria: readonly string[] }

export interface WorkPlanProposal {
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly steps: readonly { readonly title: string; readonly brief: string; readonly after: readonly number[] }[];
}

interface Held {
  draftId?: string | undefined; state: WorkPlanState; reason?: string | undefined;
  /** Set on a proposed piece of work, not yet asked for: what it asks for and when it was proposed. */
  proposal?: { readonly goal: string; readonly criteria: readonly string[]; readonly at: number } | undefined;
}

export class WorkPlanRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'WorkPlanRefusal'; }
}

function taskOf(work: WorkPlanSubject): string {
  return [work.goal, '', 'Done when:', ...work.criteria.map((criterion) => `- ${criterion}`)].join('\n');
}

function stepsOf(draft: WorkstreamDraft): readonly WorkPlanStep[] {
  // A step kept whole carries the goal and its done-when as its task: its title is the goal's first line.
  return draft.spec.items.map((item, index) => ({
    id: item.id ?? `item-${index + 1}`, title: item.title.split('\n')[0]!.trim() || item.title, brief: item.task, dependsOn: [...(item.dependsOn ?? [])],
  }));
}

function howOf(draft: WorkstreamDraft): string {
  const kind = draft.provenance.kind;
  return kind === 'agent' ? 'split into steps by a planning agent'
    : kind === 'proposed' ? 'proposed in a conversation'
      : kind === 'heuristic-configured' ? 'kept as one step (your settings keep plans in one step)'
        : `kept as one step${draft.provenance.fallbackReason ? ` (${draft.provenance.fallbackReason})` : ''}`;
}

export function createWorkPlans(deps: {
  readonly drafts: WorkstreamDraftService;
  /** The file that says which draft is which work's plan. */
  readonly file: string;
  readonly showPlanFirst: () => boolean;
  /** Told after each change; every change is also announced as the `work` list changing. */
  readonly onChange?: (() => void) | undefined;
}): WorkPlans {
  const held = new Map<string, Held>();
  try {
    const stored = JSON.parse(readFileSync(deps.file, 'utf8')) as { readonly plans?: Record<string, Held> };
    for (const [workId, entry] of Object.entries(stored.plans ?? {})) {
      // A plan being written when the daemon stopped was never finished: it is written again on the next Start.
      // A proposal whose plan was being written again is kept: its plan reads as not written, to be written again.
      if (entry.state === 'writing') {
        if (entry.proposal) held.set(workId, { state: 'failed', reason: 'the daemon stopped while the plan was written again', proposal: entry.proposal });
        continue;
      }
      if (entry.draftId && !deps.drafts.getDraft(entry.draftId)) continue;
      held.set(workId, { ...entry });
    }
  } catch { /* No file yet: no plans held. */ }

  function save(): void {
    try {
      writeFileAtomic(deps.file, `${JSON.stringify({ version: 1, plans: Object.fromEntries(held) }, null, 2)}\n`, { mkdirp: true, mode: 0o600 });
    } catch (error) {
      logger.warn('The work plans file could not be written; the plans are held until the daemon stops', { error: summarizeError(error) });
    }
    deps.onChange?.();
    noteListChanged({ list: 'work', change: 'changed' });
  }

  function draftOf(workId: string): WorkstreamDraft {
    const entry = held.get(workId);
    const draft = entry?.draftId ? deps.drafts.getDraft(entry.draftId) : undefined;
    if (!entry || !draft) throw new WorkPlanRefusal('This work has no plan waiting: start it to have its plan written.');
    return draft;
  }

  function view(workId: string): WorkPlanView | undefined {
    const entry = held.get(workId);
    if (!entry) return undefined;
    const draft = entry.draftId ? deps.drafts.getDraft(entry.draftId) : undefined;
    return {
      workId, state: entry.state, steps: draft ? stepsOf(draft) : [], how: draft ? howOf(draft) : 'being written',
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
  }

  function write(work: WorkPlanSubject): Promise<WorkPlanView> {
    const prior = held.get(work.id);
    const previous = prior?.draftId;
    // A proposed piece of work stays a proposal while its plan is written again.
    const proposal = prior?.proposal ? { proposal: prior.proposal } : {};
    held.set(work.id, { state: 'writing', ...proposal });
    save();
    return deps.drafts.proposeDraft(taskOf(work)).then((draft) => {
      if (previous) deps.drafts.removeDraft(previous);
      held.set(work.id, { draftId: draft.id, state: 'waiting', ...proposal });
      save();
      return view(work.id)!;
    }, (error: unknown) => {
      held.set(work.id, { state: 'failed', reason: `the plan could not be written: ${summarizeError(error)}`, ...proposal });
      save();
      return view(work.id)!;
    });
  }

  function edited(workId: string, result: WorkstreamDraft | { readonly error: string } | undefined): WorkPlanView {
    if (result === undefined) throw new WorkPlanRefusal('The plan is no longer held.');
    if ('error' in result) throw new WorkPlanRefusal(result.error);
    // A changed plan is approved again before it runs.
    held.set(workId, { ...held.get(workId)!, state: 'waiting' });
    save();
    return view(workId)!;
  }

  return {
    gate(work) {
      const entry = held.get(work.id);
      if (entry?.state === 'approved' && entry.draftId) {
        const draft = deps.drafts.getDraft(entry.draftId);
        if (draft) {
          const steps = stepsOf(draft);
          return { kind: 'run', draftPlan: numberDraft({ goal: work.goal, units: steps.map((step) => ({ id: step.id, title: step.title, brief: step.brief, dependsOn: step.dependsOn })) }) };
        }
      }
      if (!deps.showPlanFirst()) return { kind: 'run' };
      if (!entry || entry.state === 'failed') void write(work);
      return { kind: 'waiting' };
    },
    get: view,
    list: () => [...held.keys()].map((workId) => view(workId)!).filter(Boolean),
    redo: write,
    editStep: (workId, step, brief) => { const draft = draftOf(workId); return edited(workId, deps.drafts.editItem(draft.id, step, brief)); },
    dropStep: (workId, step) => { const draft = draftOf(workId); return edited(workId, deps.drafts.removeItem(draft.id, step)); },
    moveStep: (workId, step, position) => { const draft = draftOf(workId); return edited(workId, deps.drafts.moveItem(draft.id, step, position)); },
    approve(workId) {
      const draft = draftOf(workId);
      if (!deps.drafts.approveDraft(draft.id)) throw new WorkPlanRefusal('The plan is no longer held.');
      held.set(workId, { draftId: draft.id, state: 'approved' });
      save();
      return view(workId)!;
    },
    discard(workId) {
      const entry = held.get(workId);
      if (!entry) return false;
      if (entry.draftId) deps.drafts.removeDraft(entry.draftId);
      held.delete(workId);
      save();
      return true;
    },
    started(workId) {
      const entry = held.get(workId);
      if (!entry) return;
      if (entry.draftId) deps.drafts.removeDraft(entry.draftId);
      held.delete(workId);
      save();
    },
    propose(proposal) {
      const draft = deps.drafts.holdDraft(taskOf({ id: '', goal: proposal.goal, criteria: proposal.criteria }), proposal.steps);
      const id = `proposed-${randomUUID()}`;
      held.set(id, { draftId: draft.id, state: 'waiting', proposal: { goal: proposal.goal, criteria: [...proposal.criteria], at: Date.now() } });
      save();
      return { id, title: proposal.goal.split('\n')[0]!.trim() || proposal.goal, steps: draft.spec.items.length };
    },
    proposals() {
      return [...held.entries()].filter(([, entry]) => entry.proposal !== undefined).map(([id, entry]) => ({
        ...view(id)!, goal: entry.proposal!.goal, criteria: entry.proposal!.criteria, at: entry.proposal!.at,
      }));
    },
    proposal(id) {
      const entry = held.get(id)?.proposal;
      return entry ? { goal: entry.goal, criteria: entry.criteria } : undefined;
    },
    adopt(proposalId, workId) {
      const entry = held.get(proposalId);
      if (!entry?.proposal) throw new WorkPlanRefusal('This proposal is no longer held.');
      held.delete(proposalId);
      held.set(workId, { draftId: entry.draftId, state: entry.state });
      save();
    },
  };
}
