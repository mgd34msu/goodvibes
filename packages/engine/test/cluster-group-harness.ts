/**
 * cluster-group-harness.ts, group members over a real secrets store.
 *
 * Not a test file (the runner globs *.test.ts). Each node is a real
 * `ClusterGroupRuntime` with real crypto and key material, its key saved in a
 * real encrypted `SecretsManager` under the test's temp directory (seen through
 * the same `clusterSecretStoreFrom` view the daemon builds), its replicated
 * settings in a real `ConfigManager`, and its roster and key generations in a
 * real authority record file in its state directory. Only
 * the network (an in-process bus) and the clock (moved by the test) stand in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.ts';
import { MemoryClusterBus } from '../platform/src/platform/cluster/memory-transport.ts';
import { ClusterGroupRuntime } from '../platform/src/platform/cluster/group-runtime.ts';
import { DEFAULT_CLUSTER_GROUP_SETTINGS, type ClusterGroupSettings } from '../platform/src/platform/cluster/group-settings.ts';
import type { GroupOperationsContext } from '../platform/src/platform/cluster/group-operations.ts';
import { clusterSecretStoreFrom } from '../platform/src/platform/cluster/group-store.ts';
import type { ClusterLogger } from '../platform/src/platform/cluster/types.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema-types.ts';

const SILENT_LOGGER: ClusterLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export interface GroupTestNode {
  readonly runtime: ClusterGroupRuntime;
  readonly context: GroupOperationsContext;
  /** The directory holding this node's daemon-tier secret store. */
  readonly daemonSecretsDirectory: string;
}

export interface GroupTestWorld {
  readonly clock: FakeClusterClock;
  readonly bus: MemoryClusterBus;
  readonly nodes: GroupTestNode[];
  readonly tempRoot: string;
}

/** The shipped settings, switched on, with a one-hour rotation a test can cross in one step. */
function testGroupSettings(): ClusterGroupSettings {
  return { ...DEFAULT_CLUSTER_GROUP_SETTINGS, enabled: true, keyRotationHours: 1, keyRotationGraceMinutes: 1 };
}

export function createGroupWorld(): GroupTestWorld {
  return { clock: new FakeClusterClock(), bus: new MemoryClusterBus(), nodes: [], tempRoot: mkdtempSync(join(tmpdir(), 'gv-cluster-group-')) };
}

export function destroyGroupWorld(world: GroupTestWorld): void {
  rmSync(world.tempRoot, { recursive: true, force: true });
}

/** Build a node over its own stores and start its runtime. */
export async function addGroupNode(world: GroupTestWorld, label: string): Promise<GroupTestNode> {
  const home = join(world.tempRoot, `${label}-home`);
  const daemonSecretsDirectory = join(home, 'daemon');
  const secrets = clusterSecretStoreFrom(new SecretsManager({
    projectRoot: join(home, 'project'), globalHome: home, surfaceRoot: 'goodvibes', daemonHome: daemonSecretsDirectory,
  }));
  const configManager = new ConfigManager({ configDir: join(home, 'config') });
  const settings = testGroupSettings();
  const runtime = new ClusterGroupRuntime({
    settings,
    transport: world.bus.createTransport(label),
    secrets,
    stateDirectory: join(world.tempRoot, label),
    nodeId: label,
    nodeDisplayName: label,
    version: '1.0.0',
    clock: world.clock,
    logger: SILENT_LOGGER,
    // The daemon's own adapter: replication passes only replicated config paths.
    config: {
      get: (path) => (configManager as unknown as { get(key: string): unknown }).get(path),
      set: (path, value) => (configManager as unknown as { set(key: string, value: unknown): void }).set(path, value),
      reset: (path) => configManager.reset(path as ConfigKey),
    },
  });
  await runtime.start();
  const node: GroupTestNode = {
    runtime,
    daemonSecretsDirectory,
    context: { runtime, secrets, settings, nodeId: label, nodeDisplayName: label, version: '1.0.0', now: () => world.clock.now() },
  };
  world.nodes.push(node);
  return node;
}

/** Stop every runtime in the world; each stop returns once the exchanges it had started have ended. */
export async function stopGroupWorld(world: GroupTestWorld): Promise<void> {
  for (const node of world.nodes) await node.runtime.stop();
}
