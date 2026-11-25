/**
 * group-view.ts, another machine's own view of the group, asked of it over the
 * group's signed channel (group-tenants.ts): "see its group" on that machine's
 * row shows what that machine holds (its machines and when it heard each, its
 * key generation, whether it holds the group's settings), not this machine's
 * view under its name.
 *
 * Two messages, both identity-signed and checked against the roster before they
 * reach here: GROUP_VIEW_ASK (to one member) and GROUP_VIEW (its answer, to the
 * asker). Nothing is written. A member not heard within the group's silence is
 * said to be out of reach at once, without asking; one that was heard is asked
 * and given a few seconds to answer (one bounded wait per ask, no repeat).
 */
import type { GroupTenantHost } from './group-tenants.js';

export const GROUP_VIEW_MESSAGE_TYPES = ['GROUP_VIEW_ASK', 'GROUP_VIEW'] as const;

/** How long one ask waits for the member's answer. */
export const GROUP_VIEW_WAIT_MS = 5_000;

/** One machine as another member sees it. */
export interface MemberViewMachine {
  readonly name: string;
  readonly thisMachine: boolean;
  /** False when that member heard nothing from it since it started listening. */
  readonly heard: boolean;
  readonly lastSeenAt: number;
}

/** A member's own view of the group, as it answers it. No key material of any kind. */
export interface MemberGroupView {
  readonly nodeName: string;
  readonly groupName: string;
  readonly keyGeneration: number | null;
  readonly awaitingSync: boolean;
  readonly machines: readonly MemberViewMachine[];
  /** When that member answered, by its own clock. */
  readonly at: number;
}

export type MemberViewOutcome =
  | { readonly ok: true; readonly view: MemberGroupView }
  /** `silent`: not heard within the group's silence, so not asked; `no-answer`: asked, and no answer came in time. */
  | { readonly ok: false; readonly reason: 'silent' | 'no-answer'; readonly lastHeardAt: number | null };

const MAX_MACHINES = 64;

function text(value: unknown, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A view another machine sent, read field by field; anything malformed is dropped, never trusted. */
function readView(raw: unknown): MemberGroupView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const machines = Array.isArray(body['machines']) ? body['machines'].slice(0, MAX_MACHINES).flatMap((entry): MemberViewMachine[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const machine = entry as Record<string, unknown>;
    const name = text(machine['name']);
    return name ? [{ name, thisMachine: machine['thisMachine'] === true, heard: machine['heard'] === true, lastSeenAt: number(machine['lastSeenAt']) ?? 0 }] : [];
  }) : [];
  return {
    nodeName: text(body['nodeName']), groupName: text(body['groupName']), keyGeneration: number(body['keyGeneration']),
    awaitingSync: body['awaitingSync'] === true, machines, at: number(body['at']) ?? 0,
  };
}

export class GroupViewTenant {
  private readonly waiting = new Map<string, { readonly nodeId: string; readonly settle: (view: MemberGroupView) => void }>();
  private next = 0;

  constructor(
    private readonly host: GroupTenantHost,
    /** This machine's own view, to answer an ask; null outside a group. */
    private readonly own: () => MemberGroupView | null,
    private readonly timer: (fn: () => void, ms: number) => () => void,
    private readonly now: () => number,
  ) {}

  /** Take this tenant's messages; returns its removal. */
  start(): () => void {
    return this.host.register({ types: GROUP_VIEW_MESSAGE_TYPES, handle: (envelope, from) => this.handle(envelope.type, envelope.body, from.nodeId) });
  }

  /** Ask one member for its own view of the group. */
  ask(nodeId: string, waitMs = GROUP_VIEW_WAIT_MS): Promise<MemberViewOutcome> {
    const heard = this.host.lastHeardFrom(nodeId);
    if (heard === null || this.now() - heard > this.host.silenceMs) return Promise.resolve({ ok: false, reason: 'silent', lastHeardAt: heard });
    const id = `${this.host.selfNode.slice(0, 8)}-${(this.next += 1)}-${Math.trunc(this.now())}`;
    return new Promise((resolve) => {
      let cancel = (): void => {};
      this.waiting.set(id, { nodeId, settle: (view) => { cancel(); this.waiting.delete(id); resolve({ ok: true, view }); } });
      cancel = this.timer(() => {
        if (!this.waiting.delete(id)) return;
        resolve({ ok: false, reason: 'no-answer', lastHeardAt: this.host.lastHeardFrom(nodeId) });
      }, waitMs);
      this.host.send('GROUP_VIEW_ASK', { asks: id }, nodeId).catch(() => {
        if (!this.waiting.delete(id)) return;
        cancel();
        resolve({ ok: false, reason: 'no-answer', lastHeardAt: this.host.lastHeardFrom(nodeId) });
      });
    });
  }

  private async handle(type: string, body: Readonly<Record<string, unknown>>, from: string): Promise<void> {
    if (type === 'GROUP_VIEW_ASK') {
      const asks = text(body['asks'], 80);
      const view = this.own();
      if (!asks || !view) return;
      await this.host.send('GROUP_VIEW', { answers: asks, view: { ...view, machines: view.machines.slice(0, MAX_MACHINES) } }, from);
      return;
    }
    if (type === 'GROUP_VIEW') {
      const answers = text(body['answers'], 80);
      const asked = this.waiting.get(answers);
      // Only the member asked answers its own ask (the roster and its identity signature checked the sender).
      if (!asked || asked.nodeId !== from) return;
      const view = readView(body['view']);
      if (view) asked.settle(view);
    }
  }
}
