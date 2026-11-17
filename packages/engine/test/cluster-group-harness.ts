/**
 * cluster-group-harness.ts, a world of group members on one in-memory bus.
 *
 * Not a test file (the runner globs *.test.ts). It builds real
 * `ClusterGroupRuntime` instances, real crypto, real envelopes, real key
 * material, over a fake clock and an in-process bus, so every test here
 * exercises the shipping code paths rather than a model of them.
 *
 * Secrets live in a Map that satisfies the same narrow interface the encrypted
 * store does, and roster files live in a real temp directory that the test
 * removes, so nothing touches a developer's ~/.goodvibes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.js';
import { MemoryClusterBus, type MemoryClusterTransport } from '../platform/src/platform/cluster/memory-transport.js';
import {
  ClusterGroupRuntime,
  type ClusterGroupRuntimeOptions,
} from '../platform/src/platform/cluster/group-runtime.js';
import {
  DEFAULT_CLUSTER_GROUP_SETTINGS,
  type ClusterGroupSettings,
} from '../platform/src/platform/cluster/group-settings.js';
import type { GroupOperationsContext } from '../platform/src/platform/cluster/group-operations.js';
import type { ClusterSecretStore } from '../platform/src/platform/cluster/group-store.js';
import type { ClusterLogger } from '../platform/src/platform/cluster/types.js';

export const SILENT_LOGGER: ClusterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The narrow slice of the encrypted store, backed by a Map. */
export class MemorySecretStore implements ClusterSecretStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * A config store standing in for a ConfigManager.
 *
 * Seeded with a DIFFERENT `controlPlane.port` per node, because "the port did
 * not follow the settings across" is one of the properties under test and it
 * cannot be shown with a store where every node reads the same value anyway.
 */
export class MemoryConfigStore {
  private readonly values = new Map<string, unknown>();

  constructor(seed: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

  get(path: string): unknown {
    return this.values.get(path);
  }

  set(path: string, value: unknown): void {
    this.values.set(path, value);
  }

  reset(path: string): void {
    this.values.delete(path);
  }
}

export interface GroupTestNode {
  readonly id: string;
  readonly runtime: ClusterGroupRuntime;
  readonly context: GroupOperationsContext;
  readonly secrets: ClusterSecretStore;
  readonly config: MemoryConfigStore;
  /** This machine's own control-plane port, which must never replicate. */
  readonly localPort: number;
  readonly transport: MemoryClusterTransport;
  readonly stateDirectory: string;
}

export interface GroupTestWorld {
  readonly clock: FakeClusterClock;
  readonly bus: MemoryClusterBus;
  readonly nodes: GroupTestNode[];
  readonly tempRoot: string;
}

/**
 * Short but proportional settings.
 *
 * Rotation at one hour with a one-minute window keeps the same shape as the
 * 24h/5m defaults while letting a test cross a boundary in a single advance.
 */
export function testGroupSettings(overrides: Partial<ClusterGroupSettings> = {}): ClusterGroupSettings {
  return {
    ...DEFAULT_CLUSTER_GROUP_SETTINGS,
    // On, because every test in this suite is about a machine that IS taking
    // part. The off case has its own coverage.
    enabled: true,
    keyRotationHours: 1,
    keyRotationGraceMinutes: 1,
    beaconSeconds: 5,
    rosterGossipSeconds: 10,
    ...overrides,
  };
}

export function createGroupWorld(): GroupTestWorld {
  const bus = new MemoryClusterBus();
  return {
    clock: new FakeClusterClock(),
    bus,
    nodes: [],
    tempRoot: mkdtempSync(join(tmpdir(), 'gv-cluster-group-')),
  };
}

export function destroyGroupWorld(world: GroupTestWorld): void {
  rmSync(world.tempRoot, { recursive: true, force: true });
}

export interface AddNodeOptions {
  readonly settings?: Partial<ClusterGroupSettings> | undefined;
  readonly displayName?: string | undefined;
  readonly version?: string | undefined;
  readonly surfaceHoldings?: ClusterGroupRuntimeOptions['surfaceHoldings'];
  /** Reuse an existing node's stores, how a restart is simulated. */
  readonly reuse?: GroupTestNode | undefined;
  /**
   * The node id, when it must differ from the bus label.
   *
   * A restart keeps its node id, that is the whole point of the id, while
   * needing a fresh bus label, because the stopped transport is still attached.
   */
  readonly nodeId?: string | undefined;
  /** A logger to capture lines from; silent by default. */
  readonly logger?: ClusterLogger | undefined;
  /**
   * The secret store the runtime writes replicated credentials through.
   *
   * Defaults to the in-memory Map. A test that cares WHERE a credential lands,
   * which tier, which file, passes a real `SecretsManager` instead, so the
   * storage behaviour under test is the shipping one rather than a model of it.
   */
  readonly secrets?: ClusterSecretStore | undefined;
  /** Called when the group's key is seen to have moved past this node's. */
  readonly onKeyGenerationLost?: (() => void) | undefined;
}

/** Build a node and start its runtime. */
export async function addGroupNode(
  world: GroupTestWorld,
  label: string,
  options: AddNodeOptions = {},
): Promise<GroupTestNode> {
  const transport = world.bus.createTransport(label);
  const secrets = options.secrets ?? options.reuse?.secrets ?? new MemorySecretStore();
  const id = options.nodeId ?? options.reuse?.id ?? label;
  const stateDirectory = options.reuse?.stateDirectory ?? join(world.tempRoot, label);
  const settings = testGroupSettings(options.settings);
  const version = options.version ?? '1.0.0';
  const displayName = options.displayName ?? id;
  const localPort = 4300 + world.nodes.length;
  const config = options.reuse?.config ?? new MemoryConfigStore({ 'controlPlane.port': localPort });

  const runtime = new ClusterGroupRuntime({
    settings,
    transport,
    secrets,
    stateDirectory,
    nodeId: id,
    nodeDisplayName: displayName,
    version,
    clock: world.clock,
    logger: options.logger ?? SILENT_LOGGER,
    config,
    ...(options.surfaceHoldings ? { surfaceHoldings: options.surfaceHoldings } : {}),
    ...(options.onKeyGenerationLost ? { onKeyGenerationLost: options.onKeyGenerationLost } : {}),
  });
  await runtime.start();

  const node: GroupTestNode = {
    id,
    runtime,
    secrets,
    config,
    localPort: options.reuse?.localPort ?? localPort,
    transport,
    stateDirectory,
    context: {
      runtime,
      secrets,
      settings,
      nodeId: id,
      nodeDisplayName: displayName,
      version,
      now: () => world.clock.now(),
    },
  };
  world.nodes.push(node);
  return node;
}

/**
 * Let every pending microtask run.
 *
 * The runtime answers datagrams from synchronous transport callbacks with
 * async handlers, so a test that advanced the clock has to give those handlers
 * a turn before asserting. Several passes, because one handler's await chain
 * commonly schedules the next.
 */
export async function settle(passes = 8): Promise<void> {
  for (let index = 0; index < passes; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** Stop every runtime in the world. */
export async function stopGroupWorld(world: GroupTestWorld): Promise<void> {
  for (const node of world.nodes) await node.runtime.stop();
  await settle();
}

