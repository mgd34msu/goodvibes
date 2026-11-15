/**
 * The list-valued settings, as ordinary settings: each is one value holding an
 * array, with a validator and a hint, exactly as `judgment.fallbacks` is. Being
 * rows of the one settings table is what lets `goodvibes-daemon config
 * get|set|list`, ownership walks, write admission and the settings screens see
 * them without a hand-kept list per layer.
 *
 * Defaults are the domain defaults the settings tree already holds, so the two
 * tables cannot disagree. Validators check the shape; a consumer that skips one
 * bad entry (a contract gate with a wrong option) keeps doing so. The two
 * sandbox lists are checked strictly: a malformed list there widens what a
 * command may reach, so it is refused whole.
 */
import { isAbsolute } from 'node:path';
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

function objectList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
}

export const listConfigSettings: readonly ListConfigSetting[] = [
  {
    key: 'cluster.peers',
    type: 'object',
    default: [...clusterConfigDefaults.cluster.peers],
    description: 'Static list of cluster peers (host or host:port) contacted directly as well as over multicast. Set it on a network that drops multicast, so the nodes still find each other',
    validate: stringList,
    validationHint: 'list of host or host:port strings, for example ["10.0.0.2", "10.0.0.3:4000"]',
  },
  {
    key: 'conversationGate.gatedSurfaces',
    type: 'object',
    default: [...conversationGateConfigDefaults.conversationGate.gatedSurfaces],
    description: 'Channel surfaces whose inbound messages pass the conversation gate before a session sees them',
    validate: stringList,
    validationHint: 'list of surface names, for example ["slack", "telegram"]',
  },
  {
    key: 'contract.gates',
    type: 'object',
    default: structuredClone(contractConfigDefaults.contract.gates),
    description: 'Quality gates a contract runs before it reports work done: each is { name, command, enabled } with optional required and verification. A gate with a wrong option is skipped with a warning naming it',
    validate: objectList,
    validationHint: 'list of { name, command, enabled } objects',
  },
  {
    key: 'sandbox.egressAllowlist',
    type: 'object',
    default: [...coreConfigDefaults.sandbox.egressAllowlist],
    description: 'Commands the exec sandbox lets reach the network; every other sandboxed command runs with the network off. Applies from the next command',
    validate: (value) => stringList(value) && value.every((entry) => entry.trim().length > 0),
    validationHint: 'list of non-empty command names, for example ["git", "npm"]',
  },
  {
    key: 'sandbox.workspaceWritable',
    type: 'object',
    default: [...coreConfigDefaults.sandbox.workspaceWritable],
    description: 'Extra absolute paths the exec sandbox lets commands write besides the workspace. Applies from the next command',
    validate: (value) => stringList(value) && value.every((entry) => isAbsolute(entry)),
    validationHint: 'list of absolute paths',
  },
  {
    key: 'worktree.setup.commands',
    type: 'object',
    default: [...runtimeConfigDefaults.worktree.setup.commands],
    description: 'Commands run in a new worktree before an isolated agent starts in it, for example installing dependencies',
    validate: stringList,
    validationHint: 'list of shell commands',
  },
  {
    key: 'worktree.setup.carryOverGlobs',
    type: 'object',
    default: [...runtimeConfigDefaults.worktree.setup.carryOverGlobs],
    description: 'Untracked files copied from the main checkout into a new worktree (for example .env files), as glob patterns',
    validate: stringList,
    validationHint: 'list of glob patterns, for example [".env", "config/*.local.json"]',
  },
];
