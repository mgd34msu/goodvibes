/** UNRUN: overload refuses before deferred callback creation, entered work drains. */
import { expect, test } from 'bun:test';
import { ClusterIngressWork } from '../sdk/src/platform/cluster/ingress-work.ts';
function logger() { const warnings: string[] = []; return { warnings, debug() {}, info() {}, warn(message: string) { warnings.push(message); }, error() {} }; }
test('authenticated handler admission is bounded without building a secondary backlog', async () => {
  const log = logger(), budget = new ClusterIngressWork(log, () => 0, 2), first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>(); let entered = 0;
  budget.open(); expect(budget.admit(() => { entered++; return first.promise; })).toBe(true); expect(budget.admit(() => { entered++; return second.promise; })).toBe(true);
  for (let i = 0; i < 10000; i++) expect(budget.admit(async () => { entered++; })).toBe(false);
  expect(entered).toBe(2); expect(budget.status).toEqual({ active: 2, dropped: 10000 }); expect(log.warnings).toHaveLength(1);
  budget.close(); let drained = false; const joining = budget.join().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
  first.resolve(); await Promise.resolve(); expect(drained).toBe(false); second.resolve(); await joining; expect(budget.status.active).toBe(0);
});
test('a reentrant stop cannot settle before the original entered callback promise drains', async () => {
  const budget = new ClusterIngressWork(logger(), () => 0, 1), release = Promise.withResolvers<void>(); budget.open(); let stopped: Promise<void> | undefined;
  expect(budget.admit(() => { budget.close(); stopped = budget.join(); return release.promise; })).toBe(true);
  expect(() => budget.open()).toThrow('still draining'); let finished = false; void stopped!.then(() => { finished = true; }); await Promise.resolve(); expect(finished).toBe(false);
  release.resolve(); await stopped; expect(finished).toBe(true); budget.open(); expect(budget.admit(async () => {})).toBe(true); budget.close(); await budget.join();
});
test('overload diagnostics are time-bounded rather than reset by a fast release/refill loop', async () => {
  let now = 0; const log = logger(), budget = new ClusterIngressWork(log, () => now, 1); budget.open();
  for (let i = 0; i < 100; i++) { const release = Promise.withResolvers<void>(); budget.admit(() => release.promise); budget.admit(async () => {}); release.resolve(); await budget.join(); }
  expect(log.warnings).toHaveLength(1); now = 60000; const release = Promise.withResolvers<void>(); budget.admit(() => release.promise); budget.admit(async () => {}); expect(log.warnings).toHaveLength(2); release.resolve(); budget.close(); await budget.join();
});
