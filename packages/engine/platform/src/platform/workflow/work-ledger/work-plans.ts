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

/**
 * Who caused a piece of work to run, kept on its record here. The owner's own (`owner`) only when the owner himself
 * submitted it or approved it: a person's press or typed line of his, or his answer in Waiting for you; anything else
 * (a model in a turn on someone else's input, a device, a member, a script, an outside agent) is someone else's
 * (`other`, `who` in words) until he approves it. A turn of that work runs as that party
 * (security/turn-input-party.ts): someone else's work runs reads only and no command outside a real sandbox.
 */
export type WorkCause = { readonly party: 'owner' } | { readonly party: 'other'; readonly who: string };

/** What a piece of work with no cause recorded is: nobody is recorded as its owner's own, so it is not. */
export const UNRECORDED_WORK_CAUSE: WorkCause = Object.freeze({ party: 'other', who: 'work the owner is not recorded as having asked for or approved' });

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
  /**
   * An act made `workId` run (it was handed over, started, approved, resumed, a step run again): who caused it. The
   * owner's own act makes it his; someone else's is kept only where nothing is recorded yet, so it never takes the
   * work away from him. See {@link WorkCause}.
   */
  noteCause(workId: string, cause: WorkCause): void;
  /** Who caused `workId` to run: {@link UNRECORDED_WORK_CAUSE} when nothing is recorded. */
  causeOf(workId: string): WorkCause;
  /**
   * Who caused the work a run's session belongs to (`<asking session>:<work id>`, native-work-session.ts): the work's
   * recorded cause, else {@link UNRECORDED_WORK_CAUSE}.
   */
  causeOfSession(sessionId: string | undefined): WorkCause;
  /** Whether who caused `workId` is recorded at all (work made before causes were kept has none). */
  hasCause(workId: string): boolean;
  /**
   * Work with no recorded cause is put to the owner once, in Waiting for you (work-cause-question.ts): asked here, it
   * runs nothing until he answers (`noteCause` refuses every act that would make it run).
   */
  askCause(workId: string): void;
  causeAsked(workId: string): boolean;
  /** When this project's Work began keeping causes (its first start of this version): older work has none. */
  causesKeptSince(): number;
  /** His answer: `keep` records it as his; `drop` leaves it unrecorded (the caller stops the work). Either way it is no longer asked. */
  answerCause(workId: string, answer: 'keep' | 'drop'): void;
}

export interface WorkPlanSubject { readonly id: string; readonly goal: string; readonly criteria: readonly string[] }

export interface WorkPlanProposal {
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly steps: readonly { readonly title: string; readonly brief: string; readonly after: readonly number[] }[];
  /** How the plan came to be, when it was not proposed in a conversation (work carried from a program's own runner). */
  readonly how?: string | undefined;
}

interface Held {
  draftId?: string | undefined; state: WorkPlanState; reason?: string | undefined;
  /** Set on a proposed piece of work, not yet asked for: what it asks for and when it was proposed. */
  proposal?: { readonly goal: string; readonly criteria: readonly string[]; readonly at: number; readonly how?: string | undefined } | undefined;
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
  /** The project these plans are (its root, as the daemon routes Work): the `work` notice names it. */
  readonly project?: string | undefined;
  /** Told after each change; every change is also announced as the `work` list changing. */
  readonly onChange?: (() => void) | undefined;
}): WorkPlans {
  const held = new Map<string, Held>();
  // Who caused each piece of work to run (WorkCause), kept beside its plan and not dropped when the work starts.
  const causes = new Map<string, WorkCause>();
  // Work with no recorded cause put to the owner and not answered yet: it runs nothing.
  const asked = new Set<string>();
  // When this record began keeping causes: work made before it is the work no cause was ever kept for.
  let causesKeptSince: number | undefined;
  try {
    const stored = JSON.parse(readFileSync(deps.file, 'utf8')) as { readonly plans?: Record<string, Held>; readonly causes?: Record<string, unknown>; readonly causeAsked?: unknown; readonly causesKeptSince?: unknown };
    if (Array.isArray(stored.causeAsked)) for (const workId of stored.causeAsked) if (typeof workId === 'string') asked.add(workId);
    if (typeof stored.causesKeptSince === 'number' && Number.isFinite(stored.causesKeptSince)) causesKeptSince = stored.causesKeptSince;
    for (const [workId, cause] of Object.entries(stored.causes ?? {})) {
      const read = cause as { readonly party?: unknown; readonly who?: unknown } | null;
      if (read?.party === 'owner') causes.set(workId, { party: 'owner' });
      else if (read?.party === 'other') causes.set(workId, { party: 'other', who: typeof read.who === 'string' && read.who ? read.who : UNRECORDED_WORK_CAUSE.who });
    }
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
  const firstKept = causesKeptSince === undefined;
  causesKeptSince ??= Date.now();

  function save(): void {
    try {
      writeFileAtomic(deps.file, `${JSON.stringify({ version: 1, plans: Object.fromEntries(held), causes: Object.fromEntries(causes), causesKeptSince, ...(asked.size > 0 ? { causeAsked: [...asked] } : {}) }, null, 2)}\n`, { mkdirp: true, mode: 0o600 });
    } catch (error) {
      logger.warn('The work plans file could not be written; the plans are held until the daemon stops', { error: summarizeError(error) });
    }
    deps.onChange?.();
    // A project's Work changed: only that project's screens read again.
    noteListChanged({ list: 'work', change: 'changed', ...(deps.project !== undefined ? { project: deps.project } : {}) });
  }
  // The mark is kept from the first start of this version on (nothing else in the file changes, nothing to announce).
  if (firstKept) {
    try {
      writeFileAtomic(deps.file, `${JSON.stringify({ version: 1, plans: Object.fromEntries(held), causes: Object.fromEntries(causes), causesKeptSince, ...(asked.size > 0 ? { causeAsked: [...asked] } : {}) }, null, 2)}\n`, { mkdirp: true, mode: 0o600 });
    } catch (error) {
      logger.warn('The work plans file could not be written; when causes began to be kept is held until the daemon stops', { error: summarizeError(error) });
    }
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
      workId, state: entry.state, steps: draft ? stepsOf(draft) : [], how: entry.proposal?.how ?? (draft ? howOf(draft) : 'being written'),
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
      held.set(id, { draftId: draft.id, state: 'waiting', proposal: { goal: proposal.goal, criteria: [...proposal.criteria], at: Date.now(), ...(proposal.how ? { how: proposal.how } : {}) } });
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
    noteCause(workId, cause) {
      // Made before causes were kept, and put to the owner: nothing makes it run until he answers.
      if (asked.has(workId)) throw new WorkPlanRefusal('This work was asked for before GoodVibes kept who asked for each piece of work: answer "keep it as mine" or "drop it" in Waiting for you first. Nothing was run.');
      const known = causes.get(workId);
      if (cause.party === 'other' ? known !== undefined : known?.party === 'owner') return;
      causes.set(workId, cause.party === 'owner' ? { party: 'owner' } : { party: 'other', who: cause.who });
      save();
    },
    causeOf(workId) {
      return causes.get(workId) ?? UNRECORDED_WORK_CAUSE;
    },
    causeOfSession(sessionId) {
      if (!sessionId) return UNRECORDED_WORK_CAUSE;
      for (const [workId, cause] of causes) if (sessionId.endsWith(`:${workId}`)) return cause;
      return UNRECORDED_WORK_CAUSE;
    },
    hasCause: (workId) => causes.has(workId),
    askCause(workId) {
      if (causes.has(workId) || asked.has(workId)) return;
      asked.add(workId);
      save();
    },
    causeAsked: (workId) => asked.has(workId),
    causesKeptSince: () => causesKeptSince!,
    answerCause(workId, answer) {
      asked.delete(workId);
      if (answer === 'keep') causes.set(workId, { party: 'owner' });
      save();
    },
  };
}
