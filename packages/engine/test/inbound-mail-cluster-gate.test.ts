/**
 * inbound-mail-cluster-gate.test.ts
 *
 * Inbound mail as a leadership gate (docs/decisions/2026-07-27-inbound-email-design.md §3.5), and the
 * registration hazard that sat directly above it.
 *
 * Why the gate exists: clustering defaults off, but when the owner opts in,
 * two nodes both holding a connection to one mailbox both fetch and both
 * notify, the same message announced twice, by a capability whose entire
 * value is being told exactly once.
 *
 * Why the second half of this file exists: `registerDaemonClusterSurfaces`
 * ended Telegram's registration with an early `return` at the top level of the
 * function, so anything registered AFTER Telegram was skipped on any machine
 * whose bot token failed to resolve. That is a condition which produces no
 * error and looks exactly like a healthy node, and the surface it would have
 * silenced is a mailbox. The registration is now per-surface, and the test
 * below is what stops the early `return` coming back.
 */
import { describe, expect, test } from 'bun:test';
import { registerDaemonClusterSurfaces } from '../platform/src/platform/daemon/facade-cluster.ts';
import { inboxSurface, surfaceIdFor, telegramSurface } from '../platform/src/platform/cluster/surface-id.ts';
import type { ClusterConsumerGate } from '../platform/src/platform/cluster/types.ts';
import type { ClusterCoordinator } from '../platform/src/platform/cluster/index.ts';
import type {
  DaemonFacadeCollaborators,
  ResolvedDaemonFacadeRuntime,
} from '../platform/src/platform/daemon/facade-types.ts';
import { addNode, advance, createWorld, startNode } from './cluster-harness.ts';

// ---------------------------------------------------------------------------
// One node consumes a mailbox, and only one
// ---------------------------------------------------------------------------

describe('only one cluster node consumes a mailbox', () => {
  test('two nodes registering the same mailbox surface leave exactly one reading it', async () => {
    const world = createWorld();
    const surface = inboxSurface('email:primary:INBOX');
    const running = new Map<string, boolean>();

    const nodes = ['node-a', 'node-b'].map((id) => {
      const node = addNode(world, { id, surfaces: [] });
      running.set(id, false);
      node.registry.register({
        id: 'email-inbound',
        surface,
        start: async () => { running.set(id, true); },
        stop: async () => { running.set(id, false); },
      });
      return node;
    });

    for (const node of nodes) await startNode(world, node);
    await advance(world, 10_000);

    const readers = [...running.entries()].filter(([, on]) => on).map(([id]) => id);
    expect(readers).toHaveLength(1);
  });

  test('two mailboxes are two elections, not one', () => {
    // A node watching the signup alias must not stand down for a node watching
    // the owner's personal mailbox, so the discriminator carries both the
    // account and the mailbox.
    const primary = surfaceIdFor(inboxSurface('email:primary:INBOX'));
    expect(primary).not.toBe(surfaceIdFor(inboxSurface('email:primary:Signups')));
    expect(primary).not.toBe(surfaceIdFor(inboxSurface('email:secondary:INBOX')));
  });
});

// ---------------------------------------------------------------------------
// Nothing registered after the telegram branch is skipped
// ---------------------------------------------------------------------------

interface Harness {
  readonly gates: ClusterConsumerGate[];
  /** Ids of the gates withdrawn from the coordinator, in order. */
  readonly withdrawn: string[];
  /** What this node can currently resolve; change it, then `set` a key to notify. */
  readonly resolvable: { telegramBotId: string | null; ntfyTopics: string[]; slackTeam: string | null };
  readonly started: string[];
  readonly stopped: string[];
  register(): Promise<void>;
  /** Change a setting the way the settings API does, notifying subscribers. */
  set(key: string, value: unknown): void;
  /** What channel health is told about which channels this node reads. */
  responsible(surface: string): boolean;
  /** Election state the fake coordinator reports. */
  readonly election: { running: boolean; held: Set<string> };
}

function harness(options: {
  readonly config: Record<string, unknown>;
  readonly telegramBotId: string | null;
  readonly mailbox: { readonly account: string; readonly mailbox: string } | null;
}): Harness {
  const gates: ClusterConsumerGate[] = [];
  const withdrawn: string[] = [];
  const resolvable = { telegramBotId: options.telegramBotId, ntfyTopics: [] as string[], slackTeam: null as string | null };
  const started: string[] = [];
  const stopped: string[] = [];
  const election = { running: false, held: new Set<string>() };
  let responsibility: ((surface: string) => boolean) | null = null;
  const coordinator = {
    register: (gate: ClusterConsumerGate) => { gates.push(gate); return () => { withdrawn.push(gate.id); }; },
    reportConsumerConflict: () => {},
    get running() { return election.running; },
    holdsSurface: (surface: ClusterConsumerGate['surface']) => election.held.has(surfaceIdFor(surface)),
  } as unknown as ClusterCoordinator;
  const values: Record<string, unknown> = { ...options.config };
  const subscribers = new Map<string, Set<(next: unknown, previous: unknown) => void>>();
  const runtime = {
    configManager: {
      get: (key: string) => values[key],
      subscribe: (key: string, callback: (next: unknown, previous: unknown) => void) => {
        const set = subscribers.get(key) ?? new Set<(next: unknown, previous: unknown) => void>();
        set.add(callback);
        subscribers.set(key, set);
        return () => { set.delete(callback); };
      },
    },
  } as unknown as ResolvedDaemonFacadeRuntime;
  const collaborators = {
    providerRuntime: {
      ntfyBaseUrl: () => 'https://ntfy.test',
      ntfyTopics: () => resolvable.ntfyTopics,
      resolveSocketSurfaceIdentity: async (kind: string) => (kind === 'slack' ? resolvable.slackTeam : null),
      setSocketLostHandler: () => {},
    },
    builtinChannels: {
      resolveServableTelegramBotId: async () => resolvable.telegramBotId,
      setConsumerConflictHandler: () => {},
      setSurfaceResponsibility: (fn: ((surface: string) => boolean) | null) => { responsibility = fn; },
      inboundMailIdentity: () => options.mailbox,
      startInboundMail: async () => { started.push('email'); },
      stopInboundMail: async () => { stopped.push('email'); },
      startIngress: async () => { started.push('telegram'); },
      stopIngress: async () => { stopped.push('telegram'); },
    },
  } as unknown as DaemonFacadeCollaborators;
  return {
    gates,
    withdrawn,
    resolvable,
    started,
    stopped,
    register: () => registerDaemonClusterSurfaces(coordinator, runtime, collaborators),
    set: (key, value) => {
      const previous = values[key];
      values[key] = value;
      for (const callback of [...(subscribers.get(key) ?? [])]) callback(value, previous);
    },
    responsible: (surface) => responsibility?.(surface) ?? true,
    election,
  };
}

const EMAIL_ON = {
  'surfaces.ntfy.enabled': false,
  'surfaces.slack.enabled': false,
  'surfaces.discord.enabled': false,
  'surfaces.telegram.enabled': true,
  'surfaces.email.inbound.enabled': true,
};

describe('the telegram inert branch cannot skip a later registration', () => {
  test('an unresolvable Telegram token still leaves the mailbox gate registered', async () => {
    const rig = harness({
      config: EMAIL_ON,
      // The exact condition the early `return` used to trigger on: the surface
      // is enabled and no bot token resolves, so Telegram is reported inert.
      telegramBotId: null,
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();

    expect(rig.gates.map((gate) => gate.id)).toEqual(['email-inbound']);
    expect(surfaceIdFor(rig.gates[0]!.surface)).toBe(surfaceIdFor(inboxSurface('email:primary:INBOX')));
  });

  test('both gates register when both surfaces are servable, and the mailbox one is last', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: '1234567',
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress', 'email-inbound']);
  });

  test('the mailbox gate drives the supervisor through the channel runtime', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: null,
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    const gate = rig.gates.find((entry) => entry.id === 'email-inbound')!;
    await gate.start({ replayFromMs: null, reason: 'won the election' });
    expect(rig.started).toEqual(['email']);
    await gate.stop('standing down');
    expect(rig.stopped).toEqual(['email']);
  });

  test('a node that watches no mailbox does not contest the surface', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: '1234567',
      mailbox: null,
    });
    await rig.register();
    // Winning an election for a mailbox this node cannot read would stand every
    // other node down and then read nothing.
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
  });

  test('the mailbox gate is not registered when the surface is switched off', async () => {
    const rig = harness({
      config: { ...EMAIL_ON, 'surfaces.email.inbound.enabled': false },
      telegramBotId: '1234567',
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
  });

  test('switching the mailbox on later registers its gate without a restart, once', async () => {
    const rig = harness({
      config: { ...EMAIL_ON, 'surfaces.email.inbound.enabled': false },
      telegramBotId: '1234567',
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    rig.set('surfaces.email.inbound.enabled', true);
    rig.set('surfaces.email.inbound.enabled', false);
    rig.set('surfaces.email.inbound.enabled', true);
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress', 'email-inbound']);
  });
});

// A macrotask turn runs every queued microtask first, so the registration
// chain may grow awaits without this flush becoming too short.
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('a surface enabled or credentialed while the daemon runs is registered without a restart', () => {
  const OFF = { ...EMAIL_ON, 'surfaces.telegram.enabled': false, 'surfaces.email.inbound.enabled': false };

  test('Telegram switched on registers once, follows a token for another bot, and withdraws when switched off', async () => {
    const rig = harness({ config: OFF, telegramBotId: '1111', mailbox: null });
    await rig.register();
    rig.election.running = true; // a live daemon's coordinator is running while settings change
    expect(rig.gates).toHaveLength(0);

    rig.set('surfaces.telegram.enabled', true);
    rig.set('surfaces.telegram.botToken', 'goodvibes://secrets/telegram');
    await settle();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
    expect(surfaceIdFor(rig.gates[0]!.surface)).toBe(surfaceIdFor(telegramSurface('1111')));

    rig.resolvable.telegramBotId = '2222';
    rig.set('surfaces.telegram.botToken', 'goodvibes://secrets/telegram-2');
    await settle();
    expect(rig.withdrawn).toEqual(['telegram-ingress']);
    expect(rig.gates).toHaveLength(2);
    expect(surfaceIdFor(rig.gates[1]!.surface)).toBe(surfaceIdFor(telegramSurface('2222')));

    rig.set('surfaces.telegram.enabled', false);
    await settle();
    expect(rig.withdrawn).toEqual(['telegram-ingress', 'telegram-ingress']);
    expect(rig.gates).toHaveLength(2);
  });

  test('a Telegram token added after boot is picked up, and a token that still does not resolve registers nothing', async () => {
    const rig = harness({ config: { ...OFF, 'surfaces.telegram.enabled': true }, telegramBotId: null, mailbox: null });
    await rig.register();
    rig.election.running = true; // a live daemon's coordinator is running while settings change
    expect(rig.gates).toHaveLength(0);

    rig.set('surfaces.telegram.botToken', 'not-yet');
    await settle();
    expect(rig.gates).toHaveLength(0);

    rig.resolvable.telegramBotId = '3333';
    rig.set('surfaces.telegram.botToken', 'goodvibes://secrets/telegram');
    await settle();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
  });

  test('a setting changed after the daemon stopped registers nothing', async () => {
    const rig = harness({ config: OFF, telegramBotId: '1111', mailbox: null });
    await rig.register();
    rig.election.running = true;
    rig.resolvable.ntfyTopics = ['agent-one'];
    rig.election.running = false;
    rig.set('surfaces.ntfy.enabled', true);
    rig.set('surfaces.telegram.enabled', true);
    await settle();
    expect(rig.gates).toHaveLength(0);
    rig.election.running = true;
    rig.set('surfaces.telegram.botToken', 'goodvibes://secrets/telegram');
    await settle();
    expect(rig.gates.map((gate) => gate.id).sort()).toEqual(['ntfy-topic:agent-one', 'telegram-ingress']);
  });

  test('ntfy topics follow the settings: added, renamed and switched off', async () => {
    const rig = harness({ config: OFF, telegramBotId: null, mailbox: null });
    await rig.register();
    rig.election.running = true; // a live daemon's coordinator is running while settings change

    rig.resolvable.ntfyTopics = ['agent-one'];
    rig.set('surfaces.ntfy.enabled', true);
    await settle();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['ntfy-topic:agent-one']);

    rig.set('surfaces.ntfy.agentTopic', 'agent-one');
    await settle();
    expect(rig.gates).toHaveLength(1);

    rig.resolvable.ntfyTopics = ['agent-two'];
    rig.set('surfaces.ntfy.agentTopic', 'agent-two');
    await settle();
    expect(rig.withdrawn).toEqual(['ntfy-topic:agent-one']);
    expect(rig.gates.map((gate) => gate.id)).toEqual(['ntfy-topic:agent-one', 'ntfy-topic:agent-two']);

    rig.set('surfaces.ntfy.enabled', false);
    await settle();
    expect(rig.withdrawn).toEqual(['ntfy-topic:agent-one', 'ntfy-topic:agent-two']);
  });

  test('Slack switched on, or given a token that identifies a workspace, is contested under that workspace', async () => {
    const rig = harness({ config: OFF, telegramBotId: null, mailbox: null });
    await rig.register();
    rig.election.running = true;
    rig.set('surfaces.slack.enabled', true);
    await settle();
    // Enabled but the token identifies nothing yet: nothing to contest.
    expect(rig.gates).toHaveLength(0);

    rig.resolvable.slackTeam = 'T100';
    rig.set('surfaces.slack.botToken', 'goodvibes://secrets/slack');
    await settle();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['slack-socket']);

    rig.resolvable.slackTeam = 'T200';
    rig.set('surfaces.slack.botToken', 'goodvibes://secrets/slack-other');
    await settle();
    expect(rig.withdrawn).toEqual(['slack-socket']);
    expect(rig.gates.map((gate) => gate.id)).toEqual(['slack-socket', 'slack-socket']);

    rig.set('surfaces.slack.enabled', false);
    await settle();
    expect(rig.withdrawn).toEqual(['slack-socket', 'slack-socket']);
  });

  test('running the registration again at the next start registers nothing twice', async () => {
    const rig = harness({ config: { ...EMAIL_ON }, telegramBotId: '1234567', mailbox: { account: 'primary', mailbox: 'INBOX' } });
    await rig.register();
    await rig.register();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress', 'email-inbound']);
  });
});

describe('channel health knows which channels this node is standing by for', () => {
  test('a contested channel another node holds is not this node\'s; an uncontested one is', async () => {
    const rig = harness({ config: EMAIL_ON, telegramBotId: '1234567', mailbox: null });
    await rig.register();
    // Before the election runs, every channel reports its own state.
    expect(rig.responsible('telegram')).toBe(true);

    rig.election.running = true;
    expect(rig.responsible('telegram')).toBe(false);
    // Slack was never contested on this node, so its own state is the answer.
    expect(rig.responsible('slack')).toBe(true);

    rig.election.held.add(surfaceIdFor(rig.gates.find((gate) => gate.id === 'telegram-ingress')!.surface));
    expect(rig.responsible('telegram')).toBe(true);
  });
});
