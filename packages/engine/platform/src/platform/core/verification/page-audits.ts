import { JudgmentContextLimitError, type CallOptions, type YesNoReading } from '@goodvibes-jev/judgment';
import { PAGE_AUDIT_SLOTS, PAGE_AUDIT_SLOT_NAMES, verificationAudit, verificationInstructionAudit, verificationInstructionPageAudit, verificationPageAudit } from './batteries.js';
import type { VerificationAccess } from './types.js';

/** How long a page audit waits for the other requirements of its round before it is asked on its own. */
export const PAGE_AUDIT_HOLD_MS = 2_000;

/** One page one requirement needs audited. */
export interface PageAuditAsk {
  /** The page's source ids; equal ids are the same immutable page. */
  readonly ids: readonly string[];
  readonly instruction: boolean;
  /** The page as sent on the wire. */
  readonly sources: readonly unknown[];
}
/** What one requirement brings to every page it asks about. */
export interface PageAuditCase {
  readonly requirement: { readonly id: string; readonly text: string; readonly sources: readonly string[] };
  /** The requirement's case evidence without its sources; those are `evidence`, sent once per request and named by id. */
  readonly caseEvidence: Readonly<Record<string, unknown>>;
  readonly evidence: readonly { readonly id: string }[];
  /** Turn context and proposed response, the same object for every requirement of one check. */
  readonly turnContext: object | undefined;
  readonly response: unknown;
}
export interface PageAuditReading {
  readonly missed: YesNoReading;
  recordAction(action: string): void;
}

type Submission = {
  readonly member: PageAuditMember;
  readonly asks: readonly PageAuditAsk[];
  readonly entry: PageAuditCase;
  readonly access: VerificationAccess;
  readonly readings: (PageAuditReading | undefined)[];
  failure?: { error: unknown };
  resolve(readings: PageAuditReading[]): void;
  reject(error: unknown): void;
  settled: boolean;
};
type Group = { readonly ask: PageAuditAsk; readonly members: { submission: Submission; index: number }[] };

const sharedIds = new WeakMap<object, number>();
let sharedSequence = 0;
function sharedKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return `v${JSON.stringify(value) ?? 'undefined'}`;
  let id = sharedIds.get(value);
  if (id === undefined) { id = ++sharedSequence; sharedIds.set(value, id); }
  return `o${id}`;
}

/**
 * The page audits of one completion check. Each requirement inspected at the
 * same time is a member; a member asking about pages waits until no member is
 * still working toward its own audit (or PAGE_AUDIT_HOLD_MS), then every
 * waiting requirement is asked about each page in one request. A page settled
 * for a requirement is never in an ask: the coordinator's caches answer it.
 */
export class PageAuditRound {
  private readonly members = new Set<PageAuditMember>();
  private queue: Submission[] = [];
  private hold: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly access: VerificationAccess,
    private readonly options: (access: VerificationAccess) => CallOptions) {}

  join(): PageAuditMember {
    const member = new PageAuditMember(this);
    this.members.add(member);
    return member;
  }

  /** @internal */
  leave(member: PageAuditMember): void {
    this.members.delete(member);
    this.settle();
  }

  /** @internal */
  submit(submission: Submission): void {
    this.queue.push(submission);
    submission.member.state = 'waiting';
    this.hold ??= setTimeout(() => { this.hold = undefined; this.dispatch(); }, PAGE_AUDIT_HOLD_MS);
    this.settle();
  }

  /** @internal */
  withdraw(submission: Submission): void {
    this.queue = this.queue.filter(entry => entry !== submission);
    this.settle();
  }

  private settle(): void {
    if (this.queue.length === 0) { if (this.hold) { clearTimeout(this.hold); this.hold = undefined; } return; }
    for (const member of this.members) if (member.state === 'working') return;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.hold) { clearTimeout(this.hold); this.hold = undefined; }
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    void this.run(batch);
  }

  private async run(batch: readonly Submission[]): Promise<void> {
    // Group by page and by the shared turn context, so one request never mixes two checks.
    const groups = new Map<string, Group>();
    for (const submission of batch) {
      const shared = `${sharedKey(submission.entry.turnContext)}|${sharedKey(submission.entry.response)}`;
      submission.asks.forEach((ask, index) => {
        const key = `${shared}|${ask.instruction ? 'i' : 'o'}|${JSON.stringify(ask.ids)}`;
        let group = groups.get(key);
        if (!group) { group = { ask, members: [] }; groups.set(key, group); }
        group.members.push({ submission, index });
      });
    }
    const jobs = [...groups.values()].flatMap(group => {
      const chunks: Group[] = [];
      for (let start = 0; start < group.members.length; start += PAGE_AUDIT_SLOTS)
        chunks.push({ ask: group.ask, members: group.members.slice(start, start + PAGE_AUDIT_SLOTS) });
      return chunks;
    });
    // As many requests at once as the members would have made on their own.
    const limit = 3 * new Set(batch.map(submission => submission.member)).size;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const live = job.members.filter(({ submission }) => !submission.settled && !submission.failure);
        if (live.length === 0) continue;
        try { await this.ask(job.ask, live); }
        catch (error) { for (const { submission } of live) submission.failure ??= { error }; }
        for (const { submission } of live) this.complete(submission);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    for (const submission of batch) this.complete(submission, true);
  }

  private complete(submission: Submission, final = false): void {
    if (submission.settled) return;
    if (submission.failure) { submission.settled = true; submission.member.state = 'working'; submission.reject(submission.failure.error); this.settle(); return; }
    if (submission.readings.some(reading => reading === undefined)) {
      if (!final) return;
      submission.failure = { error: new Error('page audit ended without a reading') };
      return this.complete(submission);
    }
    submission.settled = true;
    submission.member.state = 'working';
    submission.resolve(submission.readings as PageAuditReading[]);
    this.settle();
  }

  private async ask(page: PageAuditAsk, members: readonly { submission: Submission; index: number }[]): Promise<void> {
    if (members.length === 1) {
      const { submission, index } = members[0]!;
      submission.readings[index] = await this.single(page, submission);
      return;
    }
    const first = members[0]!.submission.entry;
    const evidence = new Map<string, unknown>();
    for (const { submission } of members) for (const source of submission.entry.evidence) if (!evidence.has(source.id)) evidence.set(source.id, source);
    const state = { ...(first.turnContext ?? {}), response: first.response, observedEvidence: [...evidence.values()],
      cases: members.map(({ submission }) => ({ requirement: submission.entry.requirement,
        caseEvidence: { ...submission.entry.caseEvidence, sourceIds: submission.entry.evidence.map(source => source.id) } })),
      sources: page.sources };
    const battery = page.instruction ? verificationInstructionPageAudit : verificationPageAudit;
    const run = await battery.runSome(this.access.port, state as never, PAGE_AUDIT_SLOT_NAMES.slice(0, members.length),
      { ...this.options(this.access), site: battery.name })
      .catch((error: unknown) => {
        // Several requirements' evidence did not fit one request: ask each on its own.
        if (error instanceof JudgmentContextLimitError) return undefined;
        throw error;
      });
    if (!run) {
      await Promise.all(members.map(async ({ submission, index }) => { submission.readings[index] = await this.single(page, submission); }));
      return;
    }
    this.access.assertCurrent();
    members.forEach(({ submission, index }, slot) => {
      const name = PAGE_AUDIT_SLOT_NAMES[slot]!;
      const requirement = submission.entry.requirement.id;
      // An absent slot settles nothing: its requirement reads as uncertain, never as met.
      const missed = run.readings[name] ?? { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' };
      submission.readings[index] = { missed, recordAction: action => run.recordAction(`${requirement}: ${action}`) };
    });
  }

  private async single(page: PageAuditAsk, submission: Submission): Promise<PageAuditReading> {
    const { entry, access } = submission;
    const context = { ...(entry.turnContext ?? {}), requirement: entry.requirement, response: entry.response,
      caseEvidence: { sources: entry.evidence, ...entry.caseEvidence }, sources: page.sources };
    const battery = page.instruction ? verificationInstructionAudit : verificationAudit;
    const run = await battery.run(access.port, context as never, { ...this.options(access), site: battery.name });
    return { missed: run.readings.missed, recordAction: action => run.recordAction(action) };
  }
}

/** One requirement's place in a round. */
export class PageAuditMember {
  /** @internal */
  state: 'working' | 'waiting' = 'working';
  constructor(private readonly round: PageAuditRound) {}

  /** The reading of each page for this requirement, in order; asked together with the round's other waiting requirements. */
  ask(asks: readonly PageAuditAsk[], entry: PageAuditCase, access: VerificationAccess): Promise<PageAuditReading[]> {
    if (asks.length === 0) return Promise.resolve([]);
    access.signal?.throwIfAborted();
    return new Promise<PageAuditReading[]>((resolve, reject) => {
      const signal = access.signal;
      const onAbort = () => {
        if (submission.settled) return;
        submission.settled = true;
        this.state = 'working';
        this.round.withdraw(submission);
        reject(signal?.reason);
      };
      const submission: Submission = { member: this, asks, entry, access, readings: asks.map(() => undefined), settled: false,
        resolve: readings => { signal?.removeEventListener('abort', onAbort); resolve(readings); },
        reject: error => { signal?.removeEventListener('abort', onAbort); reject(error); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.round.submit(submission);
    });
  }

  leave(): void { this.round.leave(this); }
}
