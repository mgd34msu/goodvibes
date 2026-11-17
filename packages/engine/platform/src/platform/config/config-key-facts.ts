/**
 * The facts about every config key, from declarations in code.
 *
 * Who owns a key, whether a repository's project file may set it, whether its
 * value is a credential or card material, and which changes loosen security are
 * things the program declares, so a writer, a settings screen, the project-file
 * filter and the gate read them here instead of each keeping a list or asking a
 * model about a key's name or value. The declarations themselves stay where
 * their reasons are written: ownership in config-ownership.ts, credentials in
 * secret-bearing-config-keys.ts, card fields in payment-config-keys.ts,
 * credential destinations in credential-destination-keys.ts, the safety-gate
 * keys in settings-ingestion.ts. This module adds the project-file and
 * loosening declarations and combines all of them into one record per key.
 */
import type { ConfigKeyFacts } from './schema-shared.js';
import { CONFIG_KEYS } from './schema.js';
import { configKeyScope } from './config-ownership.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { isPaymentsSyntheticConfigKey } from './payment-config-keys.js';
import { CREDENTIAL_DESTINATION_KEYS } from './credential-destination-keys.js';
import { SAFETY_GATE_CONFIG_PREFIXES } from './settings-ingestion.js';
import { parsePermissionMode } from '../gate/presets.js';

export type { ConfigKeyFacts } from './schema-shared.js';

interface Loosening {
  readonly loosens: (prev: unknown, next: unknown) => boolean;
  readonly loosening: string;
}

/**
 * Keys a project settings file may not set at all, named so a filter can find
 * them at any depth and give the reason: each points work, data or a stored
 * credential at a destination. They are outside the project allow-list below
 * as well.
 */
const PROJECT_UNSETTABLE_KEYS: readonly string[] = [
  'judgment.endpoint', 'notifications.webhookUrls', ...CREDENTIAL_DESTINATION_KEYS,
];

/**
 * What a project settings file, which is repository content, may set: how the
 * session looks and behaves inside that project, how its contracts and
 * worktrees are run, and (only in the stricter direction, see the loosening
 * rules below) the permission posture. Nothing here sends data off the
 * machine, runs a command, names a credential or a model, or changes what is
 * installed. Every other key in a project file is skipped with a notice.
 * A trailing dot is a family; anything else is one key.
 */
const PROJECT_SETTABLE: readonly string[] = [
  'display.', 'ui.', 'behavior.',
  'permissions.mode', 'permissions.tools.', 'sandbox.enabled',
  'contract.', 'worktree.setup.carryOverGlobs',
  'checkpoints.preferGitRoot', 'checkpoints.allowLargeFirstSnapshot', 'checkpoints.maxFirstSnapshotFiles', 'checkpoints.autoRetention',
  'agents.passiveInjection.', 'agents.contextWindowGuard', 'agents.contextCompactThreshold',
];
/** Inside an admitted family, the keys that run a command: never from a repository. */
const PROJECT_COMMAND_KEYS: ReadonlySet<string> = new Set(['contract.gates']);

function isProjectSettable(key: string): boolean {
  if (PROJECT_COMMAND_KEYS.has(key)) return false;
  return PROJECT_SETTABLE.some(entry => entry.endsWith('.') ? key.startsWith(entry) : key === entry);
}

const MODE_RANK: ReadonlyMap<string, number> = new Map([['plan', 0], ['ask-me', 1], ['jev-decides', 2], ['just-vibes', 2], ['yolo', 3]]);
const TOOL_RANK: ReadonlyMap<string, number> = new Map([['deny', 0], ['prompt', 1], ['allow', 2]]);

function modeRank(value: unknown): number | undefined {
  const parsed = parsePermissionMode(value);
  return parsed === undefined ? undefined : MODE_RANK.get(parsed);
}

function hostList(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) : [];
}

const turnsOn = (prev: unknown, next: unknown): boolean => next === true && prev !== true;
const changes = (prev: unknown, next: unknown): boolean => JSON.stringify(next) !== JSON.stringify(prev);

const PERMISSION_MODE: Loosening = {
  loosening: 'loosen the permission mode',
  loosens: (prev, next) => {
    const proposed = modeRank(next), baseline = modeRank(prev);
    return proposed !== undefined && baseline !== undefined && proposed > baseline;
  },
};
const AUTO_APPROVE: Loosening = { loosening: 'turn on automatic approval', loosens: turnsOn };
const SANDBOX: Loosening = { loosening: 'turn the sandbox off', loosens: (prev, next) => next === false && prev !== false };
const TOOL_PERMISSION: Loosening = {
  loosening: 'loosen a per-tool permission',
  loosens: (prev, next) => {
    const proposed = typeof next === 'string' ? TOOL_RANK.get(next) : undefined;
    // A tool nobody configured is held to the default ask posture.
    const baseline = typeof prev === 'string' ? TOOL_RANK.get(prev) : TOOL_RANK.get('prompt');
    return proposed !== undefined && baseline !== undefined && proposed > baseline;
  },
};
const OPENING: Loosening = { loosening: 'open a listener, a remote entry point or local fetching', loosens: turnsOn };
const BLOCKED_HOSTS: Loosening = {
  loosening: 'remove a host from the fetch block list',
  loosens: (prev, next) => {
    const kept = new Set(hostList(next));
    return hostList(prev).some(host => !kept.has(host));
  },
};
const STEP_UP: Loosening = {
  loosening: 'change a safety-gate setting',
  loosens: (prev, next) => next !== true && changes(prev, next),
};
// The direction of a change to these cannot be told from the values, so any change counts.
const PINNED: Loosening = { loosening: 'change a safety-gate setting', loosens: changes };

/** Switches that open a listener or a destination; turning one on loosens security. */
const OPENING_SWITCHES: readonly string[] = [
  'danger.httpListener', 'controlPlane.trustProxy', 'fetch.allowLocalhost',
];

/**
 * Safety-gate keys outside the ones with their own rule above. The judgment
 * keys are left out: a project legitimately picks its own judgment backend, and
 * the loader already retains the last admitted chain.
 */
const PINNED_SAFETY_GATE: readonly string[] = SAFETY_GATE_CONFIG_PREFIXES.filter(prefix =>
  !prefix.startsWith('judgment.') && prefix !== 'provider.decisionRouter'
  && prefix !== 'permissions.mode' && prefix !== 'permissions.tools.');

/** Network, listener, sandbox and background-agent keys that widen what the process reaches or accepts. */
const PINNED_NETWORK: readonly string[] = [
  'network.remoteFetch.allowPrivateHosts', 'network.outboundTls.', 'fetch.trustedHosts', 'fetch.sanitizeMode',
  'controlPlane.host', 'controlPlane.hostMode', 'controlPlane.cors.allowedOrigins',
  'httpListener.host', 'httpListener.hostMode', 'httpListener.trustProxy', 'httpListener.trustCloudflare',
  'sandbox.egressAllowlist', 'sandbox.workspaceWritable',
];
/** An enum value that hands a decision the owner would make to code or a model. */
const becomes = (value: string): ((prev: unknown, next: unknown) => boolean) => (prev, next) => next === value && prev !== value;

const EXACT_LOOSENING = new Map<string, Loosening>();
const PREFIX_LOOSENING: Array<readonly [string, Loosening]> = [];

function declareLoosening(keyOrPrefix: string, loosening: Loosening): void {
  if (keyOrPrefix.endsWith('.')) PREFIX_LOOSENING.push([keyOrPrefix, loosening]);
  else if (!EXACT_LOOSENING.has(keyOrPrefix)) EXACT_LOOSENING.set(keyOrPrefix, loosening);
}

// Specific rules first; a key declared twice keeps its first rule.
declareLoosening('permissions.mode', PERMISSION_MODE);
declareLoosening('behavior.autoApprove', AUTO_APPROVE);
declareLoosening('sandbox.enabled', SANDBOX);
declareLoosening('permissions.tools.', TOOL_PERMISSION);
for (const key of OPENING_SWITCHES) declareLoosening(key, OPENING);
declareLoosening('fetch.blockedHosts', BLOCKED_HOSTS);
declareLoosening('relay.requireStepUpForMutations', STEP_UP);
declareLoosening('sandbox.judgment', { loosening: 'let a model approve sandbox escalations', loosens: becomes('auto-approve') });
declareLoosening('permissions.commandParser', { loosening: 'stop parsing shell commands before they run', loosens: becomes('flat') });
for (const key of [...PINNED_NETWORK, ...PINNED_SAFETY_GATE]) declareLoosening(key, PINNED);
// Each names a program the host runs or a token variable it hands over when a secret reference resolves.
declareLoosening('storage.secretProviders.', { loosening: 'change the program or token a password manager runs with', loosens: changes });

function looseningFor(key: string): Loosening | undefined {
  const exact = EXACT_LOOSENING.get(key);
  if (exact) return exact;
  for (const [prefix, loosening] of PREFIX_LOOSENING) if (key.startsWith(prefix)) return loosening;
  return undefined;
}

function computeFacts(key: string): ConfigKeyFacts {
  const loosening = looseningFor(key);
  return Object.freeze({
    owner: configKeyScope(key),
    projectSettable: isProjectSettable(key),
    secret: isSecretBearingConfigKey(key),
    cardMaterial: isPaymentsSyntheticConfigKey(key),
    inSchema: CONFIG_KEYS.has(key),
    ...(loosening ? { loosens: loosening.loosens, loosening: loosening.loosening } : {}),
  });
}

let schemaFacts: Map<string, ConfigKeyFacts> | null = null;

/**
 * The facts about `key`. A schema key's record is built once and then read
 * from a map; any other path (a per-tool permission, a non-schema daemon path)
 * is combined from the same declarations on each call, a handful of set and
 * prefix lookups.
 */
export function configKeyFacts(key: string): ConfigKeyFacts {
  schemaFacts ??= new Map([...CONFIG_KEYS].map(schemaKey => [schemaKey, computeFacts(schemaKey)]));
  return schemaFacts.get(key) ?? computeFacts(key);
}

/** Destination keys a project settings file may not set, for a filter that must find them at any depth. */
export function listProjectUnsettableConfigKeys(): readonly string[] {
  return PROJECT_UNSETTABLE_KEYS;
}

/**
 * True when a project file's value for `key` is honoured only when it is
 * stricter than the owner's own, or not at all.
 */
export function isProjectRestrictedKey(key: string): boolean {
  const facts = configKeyFacts(key);
  return !facts.projectSettable || facts.loosens !== undefined;
}

/**
 * True when the value at `key` must be kept out of view: a declared
 * credential, card material, or a key the schema does not know (a name alone
 * cannot clear it, so it is treated as one).
 */
export function isProtectedConfigValue(key: string): boolean {
  const facts = configKeyFacts(key);
  return facts.secret || facts.cardMaterial || !facts.inSchema;
}
