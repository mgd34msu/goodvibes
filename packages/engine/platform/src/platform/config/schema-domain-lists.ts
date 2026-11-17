/**
 * The list-valued settings, as ordinary settings: each is one value holding an
 * array, with a validator and a hint, exactly as `judgment.fallbacks` is. Being
 * rows of the one settings table is what lets `goodvibes-daemon config
 * get|set|list`, ownership walks, write admission and the settings screens see
 * them without a hand-kept list per layer.
 *
 * Defaults are the domain defaults the settings tree already holds, so the two
 * tables cannot disagree. Validators check the shape. `contract.gates` is
 * checked by the same rule the contract runner reports at contract start, so a
 * gate that cannot run is refused when it is saved, with the rule as the hint.
 * The two sandbox lists are checked strictly: a malformed list there widens
 * what a command may reach, so it is refused whole.
 */
import { isAbsolute } from 'node:path';
import { CONTRACT_GATE_LIST_HINT, contractGateListProblems } from './contract-gate-list.js';
import type { ConfigSetting } from './schema-types.js';
import type { ListConfigKey } from './schema-types-lists.js';
import { clusterConfigDefaults } from './schema-domain-cluster.js';
import { conversationGateConfigDefaults } from './schema-domain-conversation-gate.js';
import { contractConfigDefaults } from './schema-domain-contract.js';
import { coreConfigDefaults } from './schema-domain-core.js';
import { runtimeConfigDefaults } from './schema-domain-runtime.js';

export interface ListConfigSetting extends Omit<ConfigSetting, 'key' | 'type'> {
  readonly key: ListConfigKey;
  readonly type: 'object';
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A worktree setup list: the list itself, or `{ mode: 'auto' | 'none' }` (runtime/worktree/setup.ts). */
function worktreeSetupList(value: unknown): boolean {
  if (stringList(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const mode = (value as { readonly mode?: unknown }).mode;
  return keys.length === 1 && (mode === 'auto' || mode === 'none');
}

export const listConfigSettings: readonly ListConfigSetting[] = [
  {
    key: 'cluster.peers',
    type: 'object',
    default: [...clusterConfigDefaults.cluster.peers],
    description: 'Static list of cluster peers (host or host:port) contacted directly as well as over multicast. Set it on a network that drops multicast, so the nodes still find each other',
    validate: stringList,
    closedShape: true,
    validationHint: 'list of host or host:port strings, for example ["10.0.0.2", "10.0.0.3:4000"]',
  },
  {
    key: 'conversationGate.gatedSurfaces',
    type: 'object',
    default: [...conversationGateConfigDefaults.conversationGate.gatedSurfaces],
    description: 'Channel surfaces whose inbound messages pass the conversation gate before a session sees them',
    validate: stringList,
    closedShape: true,
    validationHint: 'list of surface names, for example ["slack", "telegram"]',
  },
  {
    key: 'contract.gates',
    type: 'object',
    default: structuredClone(contractConfigDefaults.contract.gates),
    description: 'Quality gates a contract runs before it reports work done: each is { name, command, enabled } with optional required and verification. Any gate passes or fails on its command\'s exit code. A list with a gate that cannot run is refused when saved',
    validate: (value) => contractGateListProblems(value).length === 0,
    validationHint: CONTRACT_GATE_LIST_HINT,
  },
  {
    key: 'sandbox.egressAllowlist',
    type: 'object',
    default: [...coreConfigDefaults.sandbox.egressAllowlist],
    description: 'Commands the exec sandbox lets reach the network; every other sandboxed command runs with the network off. Applies from the next command',
    validate: (value) => stringList(value) && value.every((entry) => entry.trim().length > 0),
    closedShape: true,
    validationHint: 'list of non-empty command names, for example ["git", "npm"]',
  },
  {
    key: 'sandbox.workspaceWritable',
    type: 'object',
    default: [...coreConfigDefaults.sandbox.workspaceWritable],
    description: 'Extra absolute paths the exec sandbox lets commands write besides the workspace. Applies from the next command',
    validate: (value) => stringList(value) && value.every((entry) => isAbsolute(entry)),
    closedShape: true,
    validationHint: 'list of absolute paths',
  },
  {
    key: 'worktree.setup.commands',
    type: 'object',
    default: [...runtimeConfigDefaults.worktree.setup.commands],
    description: 'Commands run in a new worktree before an isolated agent starts in it. auto (the default, an empty list) runs the install command each lockfile in the repository names (bun install, npm ci, pnpm, yarn, uv sync, cargo fetch, go mod download; pip install -r requirements.txt only inside an active virtual environment). none runs nothing. A list runs exactly those commands, in order; one that exits non-zero marks the worktree setup failed',
    validate: worktreeSetupList,
    closedShape: true,
    validationHint: 'a list of shell commands, [] for auto, or {"mode":"none"}',
  },
  {
    key: 'worktree.setup.carryOverGlobs',
    type: 'object',
    default: [...runtimeConfigDefaults.worktree.setup.carryOverGlobs],
    description: 'Untracked files copied from the main checkout into a new worktree, as glob patterns. auto (the default, an empty list) copies .env and .env.* when the repository root has them. none copies nothing. A list copies exactly the files those patterns match. Copies stay in the worktree until it is removed',
    validate: worktreeSetupList,
    closedShape: true,
    validationHint: 'a list of glob patterns such as [".env", "config/*.local.json"], [] for auto, or {"mode":"none"}',
  },
];
