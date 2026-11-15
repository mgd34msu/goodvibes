/**
 * Daemon repair: the diagnosis, the repair and the prompt, all driven by one
 * fake platform service control (the same seam the boot-time autostart uses),
 * plus the shell's keypress path. No service manager or daemon is touched.
 */
import { describe, expect, test } from 'bun:test';
import type { DaemonServiceControl, DaemonServiceSnapshot } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { DaemonCliRun } from '../../runtime/daemon-cli-service.ts';
import {
  createDaemonRepairSessionMemory,
  createStandaloneDaemonHost,
  describeDaemonRepairForHeadless,
  diagnoseDaemonRepair,
  runDaemonRepair,
  type DaemonRepairConfig,
  type DaemonRepairOffer,
} from '../../runtime/daemon-repair.ts';
import { createDaemonRepairPrompt } from '../../shell/daemon-repair-prompt.ts';
import { handleBlockingShellInput } from '../../shell/blocking-input.ts';
import type { ConversationManager } from '../../core/conversation';
import type { SystemMessageRouter } from '../../core/system-message-router.ts';

/** A settings double that records what the repair wrote. */
function fakeConfig(daemonEnabled: boolean, options: { readonly throwOnSet?: string } = {}): DaemonRepairConfig & {
  readonly writes: boolean[];
  readonly value: () => boolean;
} {
  const writes: boolean[] = [];
  let value = daemonEnabled;
  return {
    get: (key) => {
      if (key === 'daemon.enabled') return value;
      if (key === 'controlPlane.host') return '127.0.0.1';
      return 3421;
    },
    set: (_key, next) => {
      if (options.throwOnSet) throw new Error(options.throwOnSet);
      writes.push(next);
      value = next;
    },
    writes,
    value: () => value,
  };
}

function fakeRouter(): { high(message: string): void; readonly messages: string[] } {
  const messages: string[] = [];
  return { high: (message: string) => { messages.push(message); }, messages };
}

const NO_SLEEP = async (): Promise<void> => {};

/** A service control double: one entry whose state the test sets, with every start recorded. */
function fakeControl(state: 'running' | 'stopped' | 'absent' | 'unanswered', options: { readonly startError?: string } = {}) {
  const starts: string[] = [];
  let current = state;
  const control: DaemonServiceControl & { readonly starts: string[]; snapshots: number } = {
    starts,
    snapshots: 0,
    snapshot: (): readonly DaemonServiceSnapshot[] => {
      control.snapshots += 1;
      return [{
        serviceName: 'goodvibes',
        platform: current === 'unanswered' ? 'unknown' : 'systemd',
        unitPath: '/units/goodvibes.service',
        installed: current === 'running' || current === 'stopped',
        running: current === 'running',
        startSupported: true,
      }];
    },
    start: (name) => {
      starts.push(name);
      if (options.startError) return { ok: false, error: options.startError };
      current = 'running';
      return { ok: true };
    },
  };
  return control;
}

function hostFor(config: DaemonRepairConfig, control: DaemonServiceControl, reachable: () => boolean) {
  return createStandaloneDaemonHost({
    config,
    control,
    isReachable: async () => reachable(),
    waitTimeoutMs: 30,
    pollIntervalMs: 10,
    sleep: NO_SLEEP,
  });
}

// ── The diagnosis ───────────────────────────────────────────────────────────

describe('diagnoseDaemonRepair', () => {
  test('flag false AND service installed but stopped produces the offer', () => {
    const config = fakeConfig(false);
    const offer = diagnoseDaemonRepair({
      config,
      session: createDaemonRepairSessionMemory(),
      host: hostFor(config, fakeControl('stopped'), () => false),
    });
    expect(offer?.serviceInstalled).toBe(true);
    expect(offer?.serviceName).toBe('goodvibes');
  });

  test('flag false AND no service installed: the offer installs one', () => {
    const config = fakeConfig(false);
    const offer = diagnoseDaemonRepair({
      config,
      session: createDaemonRepairSessionMemory(),
      host: hostFor(config, fakeControl('absent'), () => false),
    });
    expect(offer?.serviceInstalled).toBe(false);
  });

  test('a healthy machine never queries the service manager', () => {
    const config = fakeConfig(true);
    const control = fakeControl('stopped');
    expect(diagnoseDaemonRepair({ config, session: createDaemonRepairSessionMemory(), host: hostFor(config, control, () => false) })).toBeNull();
    expect(control.snapshots).toBe(0);
  });

  test('a running daemon beside a false flag, or an unanswered query, is not an offer', () => {
    for (const state of ['running', 'unanswered'] as const) {
      const config = fakeConfig(false);
      expect(diagnoseDaemonRepair({
        config,
        session: createDaemonRepairSessionMemory(),
        host: hostFor(config, fakeControl(state), () => false),
      })).toBeNull();
    }
  });

  test('a decline is remembered for the session', () => {
    const config = fakeConfig(false);
    const control = fakeControl('stopped');
    const session = createDaemonRepairSessionMemory();
    expect(diagnoseDaemonRepair({ config, session, host: hostFor(config, control, () => false) })).not.toBeNull();
    session.decline();
    expect(diagnoseDaemonRepair({ config, session, host: hostFor(config, control, () => false) })).toBeNull();
    expect(control.snapshots).toBe(1);
  });
});

// ── The repair: set the setting, install when absent, then the autostart ────

describe('runDaemonRepair', () => {
  function cliRunner(exitCode: number, calls: string[]) {
    return async (args: readonly string[]): Promise<DaemonCliRun> => {
      calls.push(args.join(' '));
      return { ran: true, exitCode, stdout: exitCode === 0 ? 'installed' : '', stderr: exitCode === 0 ? '' : 'unit write refused' };
    };
  }

  test('an installed-but-stopped service is started by the autostart and the repair reports it answers', async () => {
    const config = fakeConfig(false);
    const control = fakeControl('stopped');
    const cli: string[] = [];
    const result = await runDaemonRepair({
      config,
      offer: { serviceInstalled: true, serviceName: 'goodvibes', diagnosis: 'd', offer: 'o' },
      host: hostFor(config, control, () => control.starts.length > 0),
      runDaemonCli: cliRunner(0, cli),
      recordReceipt: () => {},
    });
    expect(result.repaired).toBe(true);
    expect(config.writes).toEqual([true]);
    expect(control.starts).toEqual(['goodvibes']);
    // An installed unit is started, never re-installed.
    expect(cli).toEqual([]);
  });

  test('with no unit installed, the daemon CLI installs it and nothing else runs it', async () => {
    const config = fakeConfig(false);
    const control = fakeControl('absent');
    const cli: string[] = [];
    const result = await runDaemonRepair({
      config,
      offer: { serviceInstalled: false, serviceName: null, diagnosis: 'd', offer: 'o' },
      host: { serviceState: () => ({ kind: 'running', serviceName: 'goodvibes' }), bringUp: async () => ({ answered: true, detail: 'answers' }) },
      runDaemonCli: cliRunner(0, cli),
      recordReceipt: () => {},
    });
    expect(result.repaired).toBe(true);
    expect(cli).toEqual(['install-service']);
    expect(control.starts).toEqual([]);
  });

  test('a start that fails is reported and never claimed as repaired; the setting stays written', async () => {
    const config = fakeConfig(false);
    const control = fakeControl('stopped', { startError: 'Failed to connect to bus' });
    const result = await runDaemonRepair({
      config,
      offer: { serviceInstalled: true, serviceName: 'goodvibes', diagnosis: 'd', offer: 'o' },
      host: hostFor(config, control, () => false),
      recordReceipt: () => {},
    });
    expect(result.repaired).toBe(false);
    expect(config.value()).toBe(true);
    expect(result.summary).toContain('Failed to connect to bus');
  });

  test('a settings write that fails stops the repair before any service is touched', async () => {
    const config = fakeConfig(false, { throwOnSet: 'settings.json is read-only' });
    const control = fakeControl('stopped');
    const result = await runDaemonRepair({
      config,
      offer: { serviceInstalled: true, serviceName: 'goodvibes', diagnosis: 'd', offer: 'o' },
      host: hostFor(config, control, () => true),
      recordReceipt: () => {},
    });
    expect(result.repaired).toBe(false);
    expect(control.starts).toEqual([]);
  });
});

// ── Layer 3: the question and its controller ────────────────────────────────

describe('createDaemonRepairPrompt', () => {
  const offer: DaemonRepairOffer = {
    serviceInstalled: true,
    serviceName: 'goodvibes',
    diagnosis: 'diagnosed',
    offer: 'offered',
  };

  function promptWith(repair: () => Promise<{ repaired: boolean; steps: string[]; summary: string }>) {
    const router = fakeRouter();
    const session = createDaemonRepairSessionMemory();
    const config = fakeConfig(false);
    let answer: ((accepted: boolean) => void) | null = null;
    const prompt = createDaemonRepairPrompt({
      offer,
      config,
      session,
      systemMessageRouter: router,
      render: () => {},
      ask: (_offer, reply) => { answer = reply; },
      repair,
    });
    return { prompt, router, session, config, answer: (accepted: boolean) => answer!(accepted) };
  }

  test('only choosing the repair in the question runs it; typed keys never reach it', async () => {
    let runs = 0;
    const { prompt, router, session, answer } = promptWith(async () => {
      runs += 1;
      return { repaired: true, steps: ['step one'], summary: '[Daemon] Repaired: all good.' };
    });
    expect(prompt.pending()).toBe(true);
    // A "y" typed into the composer goes to the composer: the shell's key path no longer knows the question.
    const typed = handleBlockingShellInput({
      data: 'y',
      pendingPermission: null,
      recoveryPending: null,
      abortTurn: () => {},
      conversation: {} as unknown as ConversationManager,
      systemMessageRouter: fakeRouter() as unknown as SystemMessageRouter,
      render: () => {},
      consumeRecovery: () => null,
      removeRecoveryPoint: () => {},
    });
    expect(typed.handled).toBe(false);
    expect(runs).toBe(0);
    answer(true);
    expect(prompt.pending()).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(session.declined()).toBe(false);
    expect(router.messages.some((message) => message.includes('Repaired: all good.'))).toBe(true);
  });

  test('leaving it (or Escape) changes nothing and is remembered for the session', () => {
    let runs = 0;
    const { prompt, router, session, config, answer } = promptWith(async () => { runs += 1; return { repaired: true, steps: [], summary: '' }; });
    answer(false);
    expect(runs).toBe(0);
    expect(config.writes).toEqual([]);
    expect(session.declined()).toBe(true);
    expect(prompt.pending()).toBe(false);
    expect(router.messages[0]).toContain('nothing was changed');
  });
});

// ── Headless run mode ───────────────────────────────────────────────────────

describe('describeDaemonRepairForHeadless', () => {
  test('names the commands that repair the machine instead of asking for a key', () => {
    const offer: DaemonRepairOffer = { serviceInstalled: false, serviceName: null, diagnosis: 'd', offer: 'o' };
    const lines = describeDaemonRepairForHeadless(offer);
    expect(lines[1]).toContain('goodvibes-daemon install-service');
    expect(lines[1]).toContain('-c daemon.enabled=true');
  });
});
