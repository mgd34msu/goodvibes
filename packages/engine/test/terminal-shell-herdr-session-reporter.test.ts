import { expect, test } from 'bun:test';
import { createHerdrSessionReporter, type HerdrSessionUpdate, type HerdrTransportContext, type HerdrReporterEnvironment } from '../terminal-shell/src/herdr-session-reporter.ts';

const environment = { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p7', HERDR_BIN_PATH: '/owning-herdr/bin/herdr', HERDR_SOCKET_PATH: '/owning-herdr/api.sock' };
const update: HerdrSessionUpdate = { sessionId: 'session-actual', sessionPath: '/tmp/native session.jsonl', busy: false, waitingForOwner: false,
  resumeArgv: ['goodvibes-jev-agent', '--resume', 'session-actual', '--permission-mode', 'safe-owner'] };
const value = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];
const reports = (calls: readonly string[][]) => calls.filter(args => args[1] === 'report-agent');
const mutations = (calls: readonly string[][]) => calls.filter(args => args[0] === 'pane');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(version = 'herdr 0.9.3') {
  const calls: string[][] = [], contexts: HerdrTransportContext[] = [];
  const reporter = createHerdrSessionReporter({ environment, transport: async (argv, context) => {
    calls.push([...argv]); contexts.push(context); return argv[0] === '--version' ? version : '';
  } });
  return { calls, contexts, reporter };
}

const incompleteEnvironments: HerdrReporterEnvironment[] = [{}, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, { ...environment, HERDR_ENV: '0' },
  { ...environment, HERDR_PANE_ID: 'focused' }, { ...environment, HERDR_PANE_ID: 'w1:p1 --source=other' },
  { ...environment, HERDR_BIN_PATH: 'herdr' }, { ...environment, HERDR_SOCKET_PATH: '' }];
test.each(incompleteEnvironments)('Herdr requires all four explicit owning-pane variables: %j', async env => {
  const calls: string[][] = [];
  const reporter = createHerdrSessionReporter({ environment: env, transport: async argv => { calls.push([...argv]); } });
  expect(reporter.enabled).toBe(false);
  await reporter.update(update); await reporter.close();
  expect(calls).toEqual([]);
});

test('native lifecycle atomically reports actual session, native resume argv and state through owning binary/socket', async () => {
  const { reporter, calls, contexts } = fixture();
  expect(reporter.enabled).toBe(true);
  expect(reporter.resumeCommandSupported).toBe(false);
  await reporter.update(update);
  expect(reporter.resumeCommandSupported).toBe(true);
  await reporter.update({ ...update, busy: true });
  await reporter.update({ ...update, busy: true, waitingForOwner: true });
  await reporter.update({ ...update, sessionId: 'session-next', sessionPath: '/tmp/next.jsonl', resumeArgv: ['goodvibes-jev-agent', '--resume', 'session-next'] });
  await reporter.close();
  expect(mutations(calls)[0]).toEqual(['pane', 'release-agent', 'w3:p7', '--source', 'herdr:goodvibes', '--agent', 'goodvibes']);
  expect(reports(calls).map(args => value(args, '--state'))).toEqual(['idle', 'working', 'blocked', 'idle']);
  for (const report of reports(calls)) {
    expect(value(report, '--source')).toBe('goodvibes'); expect(value(report, '--agent')).toBe('goodvibes'); expect(report[2]).toBe('w3:p7');
    expect(report.slice(report.indexOf('--') + 1)[0]).toBe('goodvibes-jev-agent');
  }
  expect(reports(calls)[0]).toContain('--agent-session-id=session-actual');
  expect(reports(calls)[0]).toContain('--agent-session-path=/tmp/native session.jsonl');
  expect(reports(calls)[0]?.slice(reports(calls)[0]!.indexOf('--') + 1)).toEqual([...update.resumeArgv]);
  expect(reports(calls).at(-1)).toContain('--agent-session-id=session-next');
  expect(reports(calls).at(-1)?.slice(-3)).toEqual(['goodvibes-jev-agent', '--resume', 'session-next']);
  expect(mutations(calls).at(-1)?.slice(0, 7)).toEqual(['pane', 'release-agent', 'w3:p7', '--source', 'goodvibes', '--agent', 'goodvibes']);
  const sequences = mutations(calls).slice(1).map(args => Number(value(args, '--seq')));
  expect(sequences.every((seq, index) => Number.isSafeInteger(seq) && (index === 0 || seq > sequences[index - 1]!))).toBe(true);
  expect(contexts.every(context => context.binaryPath === environment.HERDR_BIN_PATH && context.socketPath === environment.HERDR_SOCKET_PATH)).toBe(true);
});

test.each(['herdr 0.8.2', 'herdr 0.9.1', 'unrecognized output'])('older owning protocol %s keeps state/release working without unsupported trailing argv', async version => {
  const { reporter, calls } = fixture(version);
  await reporter.update(update); await reporter.close();
  expect(reporter.resumeCommandSupported).toBe(false);
  expect(reports(calls)).toHaveLength(1);
  expect(reports(calls)[0]).not.toContain('--');
  expect(mutations(calls).at(-1)?.[1]).toBe('release-agent');
});

test('in-flight updates coalesce to the latest state and detach borrowed native resume arguments', async () => {
  const calls: string[][] = [];
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let active = 0, maximum = 0;
  const reporter = createHerdrSessionReporter({ environment, transport: async args => {
    maximum = Math.max(maximum, ++active); calls.push([...args]);
    if (reports(calls).length === 1 && args[1] === 'report-agent') { started.resolve(); await release.promise; }
    active--; return args[0] === '--version' ? 'herdr 0.9.3' : '';
  } });
  const first = reporter.update(update); await started.promise;
  for (let index = 0; index < 20; index++) void reporter.update({ ...update, sessionId: `obsolete-${index}`, busy: index % 2 === 0 });
  const borrowed = { ...update, sessionId: 'latest', resumeArgv: ['goodvibes-jev-agent', '--resume', 'latest'] };
  const last = reporter.update(borrowed); borrowed.sessionId = 'mutated'; borrowed.resumeArgv[2] = 'mutated';
  release.resolve(); await Promise.all([first, last]);
  expect(maximum).toBe(1); expect(reports(calls)).toHaveLength(2);
  expect(reports(calls)[1]).toContain('--agent-session-id=latest');
  expect(reports(calls)[1]?.slice(-3)).toEqual(['goodvibes-jev-agent', '--resume', 'latest']);
  expect(JSON.stringify(calls)).not.toContain('obsolete-'); expect(JSON.stringify(calls)).not.toContain('mutated');
  await reporter.close();
});

test('close aborts one noncooperating report, drops every queued historical state and releases promptly', async () => {
  const calls: string[][] = [];
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let reportSignal: AbortSignal | undefined;
  const reporter = createHerdrSessionReporter({ environment, transport: async (args, context) => {
    calls.push([...args]);
    if (args[1] === 'report-agent') { reportSignal = context.signal; started.resolve(); await release.promise; }
    return args[0] === '--version' ? 'herdr 0.9.3' : '';
  } });
  const first = reporter.update(update); await started.promise;
  for (let index = 0; index < 20; index++) void reporter.update({ ...update, sessionId: `obsolete-${index}`, busy: index % 2 === 0 });
  const start = Date.now(), close = reporter.close(); expect(reporter.close()).toBe(close);
  await close;
  expect(Date.now() - start).toBeLessThan(1_200); expect(reportSignal?.aborted).toBe(true);
  expect(reports(calls)).toHaveLength(1); expect(mutations(calls).at(-1)?.[1]).toBe('release-agent');
  await reporter.update({ ...update, sessionId: 'after-close' });
  release.resolve(); await first; await tick();
  expect(reports(calls)).toHaveLength(1); expect(JSON.stringify(calls)).not.toContain('obsolete-'); expect(JSON.stringify(calls)).not.toContain('after-close');
});

test('even a noncooperating final release cannot keep terminal teardown waiting indefinitely', async () => {
  const { promise } = Promise.withResolvers<string>();
  const reporter = createHerdrSessionReporter({ environment, transport: async args => args[0] === '--version' ? 'herdr 0.9.3' : promise });
  const start = Date.now(); await reporter.close(); expect(Date.now() - start).toBeLessThan(1_200);
});

test('failed state reports do not spin in a retry loop, can retry on the next update and still release', async () => {
  const calls: string[][] = [], failures: string[] = [];
  let fail = true;
  const reporter = createHerdrSessionReporter({ environment, onError: error => { failures.push(error.message); }, transport: async args => {
    calls.push([...args]); if (args[1] === 'report-agent' && fail) { fail = false; throw new Error('Private output'); }
    return args[0] === '--version' ? 'herdr 0.9.3' : '';
  } });
  await expect(reporter.update(update)).resolves.toBeUndefined(); await tick(); expect(reports(calls)).toHaveLength(1);
  await reporter.update(update); await reporter.close();
  expect(failures).toEqual(['Herdr session reporting failed']); expect(reports(calls)).toHaveLength(2);
  expect(mutations(calls).at(-1)?.[1]).toBe('release-agent');
});

test.each([[], ['/absolute/agent', '--resume', 'id'], ['-agent'], ['agent', "owner's argument"], ['agent', 'control\nargument'],
  ['agent', '\u0085'], ['agent', 'x'.repeat(8_192)], Array.from({ length: 65 }, () => 'agent')]
  .map((resumeArgv, index) => ({ resumeArgv, index })))('invalid resume argv case $index never invalidates the state report', async ({ resumeArgv }) => {
  const { reporter, calls } = fixture(); await reporter.update({ ...update, resumeArgv }); await reporter.close();
  expect(reporter.resumeCommandSupported).toBe(true);
  expect(reports(calls)).toHaveLength(1); expect(reports(calls)[0]).not.toContain('--');
});

test.each([['agent', 'x'.repeat(8_187)], ['agent', ...Array.from({ length: 63 }, () => '')]]
  .map((resumeArgv, index) => ({ resumeArgv, index })))('valid resume argv boundary case $index matches the native protocol limits', async ({ resumeArgv }) => {
  const { reporter, calls } = fixture(); await reporter.update({ ...update, resumeArgv }); await reporter.close();
  const report = reports(calls)[0];
  expect(report).toBeDefined();
  expect(report?.slice(report.indexOf('--') + 1)).toEqual(resumeArgv);
});

test('successful protocol fields deduplicate, while changed native resume options publish atomically', async () => {
  const { reporter, calls } = fixture();
  await reporter.update(update); await reporter.update({ ...update });
  await reporter.update({ ...update, resumeArgv: [...update.resumeArgv, '--model', 'actual-model'] });
  expect(reports(calls)).toHaveLength(2); expect(reports(calls)[1]?.slice(-2)).toEqual(['--model', 'actual-model']);
  await reporter.close();
});
