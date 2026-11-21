// Proves: Work the owner agreed to on a channel is dropped at a restart, or is started a second time after a restart that cut its start short.
// Red when: The work-proposal store deletes an accepted proposal whose work never started once its proposal window passed, or hands a proposal whose start was claimed before the restart back as owed work, so it is started again.
/**
 * The owner answers "yes" to a proposal on a channel; the daemon starts the
 * agreed work from that saved yes, at once or at its next start. The real store
 * over a real file; a restart is a second store over the same file, with the
 * clock (the only stand-in) moved past every proposal window. Start-up reads two
 * lists: owed work it starts, and starts cut short it settles and tells the
 * owner about instead of running again.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkProposalStore } from '../platform/src/platform/agents/work-proposal-store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const WINDOW_MS = 10 * 60_000;

test('after a restart past the proposal window, agreed work never started is still owed, a start cut short is not owed again, and started work is neither', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-work-proposals-'));
  roots.push(root);
  const storePath = join(root, 'work-proposals.json');
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const first = new WorkProposalStore({ storePath, now: () => clock });
  await first.init();
  const agree = async (task: string) => {
    const proposal = first.create({ surfaceKind: 'telegram', task, summary: task, ttlMs: WINDOW_MS, routeId: `route-${task}` });
    first.markDelivered(proposal.id);
    expect((await first.resolve(proposal.id, 'accepted'))?.status).toBe('accepted');
    return proposal.id;
  };
  const owed = await agree('renew the domain');
  const cutShort = await agree('archive the invoices');
  const started = await agree('book the dentist');
  expect(await first.markStarting(cutShort)).not.toBeNull();
  expect(await first.markStarting(started)).not.toBeNull();
  await first.markStarted(started);
  await first.flush();
  first.dispose();

  clock += WINDOW_MS * 3;
  const second = new WorkProposalStore({ storePath, now: () => clock });
  await second.init();
  expect({
    owed: second.listAcceptedUnstarted().map((record) => record.id),
    interrupted: second.listInterruptedStarts().map((record) => record.id),
  }).toEqual({ owed: [owed], interrupted: [cutShort] });
  second.dispose();
});
