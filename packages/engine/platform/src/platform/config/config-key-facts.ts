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
import { CONFIG_KEYS, CONFIG_SCHEMA, type ConfigValueKind } from './schema.js';
import { configKeyScope } from './config-ownership.js';
import { isSecretBearingConfigKey, isSecretReferenceValue } from './secret-bearing-config-keys.js';
import { isSecret } from '../security/secret.js';
import { maskCredentialCandidates } from '../utils/redaction.js';
import { isPaymentsSyntheticConfigKey } from './payment-config-keys.js';
import { CREDENTIAL_DESTINATION_KEYS } from './credential-destination-keys.js';
import { SAFETY_GATE_CONFIG_PREFIXES } from './settings-ingestion.js';
import { parsePermissionMode } from '../gate/presets.js';
import { timezoneChangeMovesToday } from '../payments/day.js';

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
  'notifications.webhookUrls', ...CREDENTIAL_DESTINATION_KEYS,
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
const PRIVATE_HOSTS: Loosening = {
  loosening: 'let fetch reach a private-network host',
  loosens: (prev, next) => {
    const had = new Set(hostList(prev));
    return hostList(next).some(host => !had.has(host));
  },
};
const STEP_UP: Loosening = {
  loosening: 'change a safety-gate setting',
  loosens: (prev, next) => next !== true && changes(prev, next),
};
// The direction of a change to these cannot be told from the values, so any change counts.
const PINNED: Loosening = { loosening: 'change a safety-gate setting', loosens: changes };

function stringEntries(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value.map(entry => entry.trim())
    : undefined;
}
/** A list that grants: adding an entry widens it, removing one only narrows it. */
function widensList(loosening: string): Loosening {
  return {
    loosening,
    loosens: (prev, next) => {
      const proposed = stringEntries(next);
      if (proposed === undefined) return changes(prev, next);
      const had = new Set(stringEntries(prev) ?? []);
      return proposed.some(entry => !had.has(entry));
    },
  };
}

/** Switches that open a listener or a destination; turning one on loosens security. */
const OPENING_SWITCHES: readonly string[] = [
  'danger.httpListener', 'controlPlane.trustProxy', 'fetch.allowLocalhost',
  // Switches whose direction the value says: on trusts forwarded headers or reaches private hosts; off puts it back.
  'httpListener.trustProxy', 'httpListener.trustCloudflare', 'network.remoteFetch.allowPrivateHosts',
];

/**
 * Safety-gate keys outside the ones with their own rule. The judgment keys
 * have theirs below (a change to which decision model decides is the owner's).
 */
const PINNED_SAFETY_GATE: readonly string[] = SAFETY_GATE_CONFIG_PREFIXES.filter(prefix =>
  !prefix.startsWith('judgment.') && prefix !== 'provider.decisionRouter'
  && prefix !== 'permissions.mode' && prefix !== 'permissions.tools.');

/** Network, listener, sandbox and background-agent keys that widen what the process reaches or accepts. */
const PINNED_NETWORK: readonly string[] = [
  'network.outboundTls.', 'fetch.trustedHosts', 'fetch.sanitizeMode',
  'controlPlane.host', 'controlPlane.hostMode', 'controlPlane.cors.allowedOrigins',
  'httpListener.host', 'httpListener.hostMode',
];
/** An enum value that hands a decision the owner would make to code or a model. */
const becomes = (value: string): ((prev: unknown, next: unknown) => boolean) => (prev, next) => next === value && prev !== value;

/** A number as a settings write may carry it: a number, or a string of one. */
function amountOf(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
/** A switch as a settings write may carry it: a boolean, or the word true or false. */
function flagOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return word === 'true' ? true : word === 'false' ? false : undefined;
}

// Payments: spending beyond what the owner set is his decision alone, so any
// change that lets more be bought without asking him counts as loosening.
// An unknown previous money limit is read as the shipped 0, the strictest.
/** A money limit: a higher amount lets more be bought without asking. */
function raisesLimit(loosening: string): Loosening {
  return {
    loosening,
    loosens: (prev, next) => {
      const proposed = amountOf(next);
      if (proposed === undefined) return changes(prev, next);
      return proposed > (amountOf(prev) ?? 0);
    },
  };
}
/** A threshold or window a purchase must clear: a lower one lets more through unasked. */
function lowersThreshold(loosening: string): Loosening {
  return {
    loosening,
    loosens: (prev, next) => {
      const proposed = amountOf(next), baseline = amountOf(prev);
      if (proposed === undefined || baseline === undefined) return changes(prev, next);
      return proposed < baseline;
    },
  };
}
const flagTurnsOn = (prev: unknown, next: unknown): boolean => flagOf(next) === true && flagOf(prev) !== true;
const flagTurnsOff = (prev: unknown, next: unknown): boolean => flagOf(next) === false && flagOf(prev) !== false;
/** A comma-separated list where an added entry lets more through. */
function addsToList(loosening: string): Loosening {
  return { loosening, loosens: PRIVATE_HOSTS.loosens };
}
/** A comma-separated list where a removed entry lets more through. */
function removesFromList(loosening: string): Loosening {
  return { loosening, loosens: BLOCKED_HOSTS.loosens };
}
/**
 * A choice whose values run from the strictest (first) to the loosest (last): a move to a later value loosens, a move
 * to an earlier one tightens. A value outside the list counts as any change.
 */
function ranked(loosening: string, strictestFirst: readonly string[]): Loosening {
  return {
    loosening,
    loosens: (prev, next) => {
      const proposed = typeof next === 'string' ? strictestFirst.indexOf(next) : -1;
      const baseline = typeof prev === 'string' ? strictestFirst.indexOf(prev) : -1;
      if (proposed < 0 || baseline < 0) return changes(prev, next);
      return proposed > baseline;
    },
  };
}
/** A tool budget limit, where 0 is no limit: removing it or raising it loosens; lowering a set one tightens. */
const raisesBudget = (prev: unknown, next: unknown): boolean => {
  const proposed = amountOf(next), baseline = amountOf(prev);
  if (proposed === undefined || baseline === undefined) return changes(prev, next);
  if (proposed === baseline) return false;
  return proposed === 0 || (baseline !== 0 && proposed > baseline);
};

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
declareLoosening('sandbox.egressAllowlist', widensList('let another command reach the network from the sandbox'));
declareLoosening('sandbox.workspaceWritable', widensList('let sandboxed commands write another path'));
declareLoosening('permissions.tools.', TOOL_PERMISSION);
for (const key of OPENING_SWITCHES) declareLoosening(key, OPENING);
declareLoosening('fetch.blockedHosts', BLOCKED_HOSTS);
declareLoosening('fetch.allowedPrivateHosts', PRIVATE_HOSTS);
declareLoosening('network.privateDeliveryHosts', addsToList('let a delivery reach a host on your own network'));
declareLoosening('relay.requireStepUpForMutations', STEP_UP);
declareLoosening('sandbox.judgment', { loosening: 'let a model approve sandbox escalations', loosens: becomes('auto-approve') });
declareLoosening('permissions.commandParser', { loosening: 'stop parsing shell commands before they run', loosens: becomes('flat') });
// The decision model decides tool calls in jev-decides; which model answers, where, and with
// which credential is the owner's choice, so any change to it counts.
for (const key of ['judgment.endpoint', 'judgment.model', 'judgment.backend', 'judgment.fallbacks', 'judgment.keySource', 'judgment.keyName']) {
  declareLoosening(key, { loosening: 'change which decision model decides for you', loosens: changes });
}
// No decision model chosen, turned off: a decision model (set here or in the environment) decides again.
declareLoosening('judgment.noDecisionModel', { loosening: 'let a decision model decide for you again', loosens: flagTurnsOff });
// Safety-gate and protection keys whose values say which way a change goes (each strict value is the closed posture
// of settings-ingestion.ts `closedPostureOf`, or the schema row's own words): only a move away from the strict end
// loosens, so a move toward it (secrets only in secure storage, MCP servers contained) is never held back or put to
// the owner. Declared before the pinned keys below, whose first-rule-wins declaration would count any change.
declareLoosening('storage.secretPolicy', ranked('let passwords and keys be kept outside secure storage', ['require_secure', 'preferred_secure', 'plaintext_allowed']));
declareLoosening('sandbox.mcpIsolation', { loosening: 'run MCP servers outside their sandbox', loosens: becomes('disabled') });
declareLoosening('conversationGate.mode', ranked('let a chat message start work with less confirmation', ['confirm-all', 'propose', 'off']));
declareLoosening('fetch.sanitizeMode', ranked('clean fetched pages less', ['strict', 'safe-text', 'none']));
declareLoosening('permissions.engine', { loosening: 'stop the policy engine deciding', loosens: becomes('baseline') });
declareLoosening('policy.registryEnabled', { loosening: 'turn the policy registry off', loosens: flagTurnsOff });
declareLoosening('policy.requireSignedBundles', { loosening: 'accept a policy bundle nobody signed', loosens: flagTurnsOff });
declareLoosening('runtime.toolBudget.enforced', { loosening: 'stop enforcing the tool budget', loosens: flagTurnsOff });
for (const key of ['runtime.toolBudget.maxMs', 'runtime.toolBudget.maxTokens', 'runtime.toolBudget.maxCostUsd']) {
  declareLoosening(key, { loosening: 'raise or remove a tool budget limit', loosens: raisesBudget });
}
for (const key of ['controlPlane.hostMode', 'httpListener.hostMode']) {
  declareLoosening(key, { loosening: 'listen beyond this computer', loosens: (prev, next) => next !== 'local' && changes(prev, next) });
}
declareLoosening('network.outboundTls.mode', { loosening: 'trust another certificate for outgoing connections', loosens: (prev, next) => next !== 'bundled' && changes(prev, next) });
declareLoosening('network.outboundTls.allowInsecureLocalhost', { loosening: 'accept an unchecked certificate from this computer', loosens: flagTurnsOn });
declareLoosening('device.capabilities.mode', ranked('let a paired phone\'s camera, location and more be reached more freely', ['off', 'ask-every-time', 'honor-grants']));
declareLoosening('device.capabilities.allowAlwaysOffer', ranked('let more phone features be allowed for good', ['never', 'standard-only', 'every-capability']));
declareLoosening('device.location.precision', ranked('let the phone report a more exact location', ['coarse-only', 'ask-precise', 'precise-grantable']));
declareLoosening('device.clipboard.readMode', ranked('let the phone\'s clipboard be read more freely', ['off', 'ask-only', 'grantable']));
declareLoosening('voice.wake.indicator', { loosening: 'stop showing when the microphone is listening', loosens: becomes('off') });
declareLoosening('voice.wake.retainAudio', { loosening: 'keep recordings on disk', loosens: becomes('session-temp') });
for (const key of [...PINNED_NETWORK, ...PINNED_SAFETY_GATE]) declareLoosening(key, PINNED);
// Each names a program the host runs or a token variable it hands over when a secret reference resolves.
declareLoosening('storage.secretProviders.', { loosening: 'change the program or token a password manager runs with', loosens: changes });
declareLoosening('payments.enabled', { loosening: 'turn payments on', loosens: flagTurnsOn });
declareLoosening('payments.confirmEveryPurchase', { loosening: 'stop asking you before every purchase', loosens: flagTurnsOff });
declareLoosening('payments.defaultCardId', {
  loosening: 'choose the card a purchase is paid with',
  loosens: (prev, next) => typeof next === 'string' && next.trim() !== '' && changes(prev, next),
});
declareLoosening('payments.cvvHandling', { loosening: 'keep the card code so purchases complete while you are away', loosens: becomes('stored') });
declareLoosening('payments.budget.perPurchaseCeilingEnabled', { loosening: 'turn the per-purchase spending ceiling off', loosens: flagTurnsOff });
declareLoosening('payments.budget.overageToleranceEnabled', { loosening: 'let purchases draw on the overage tolerance', loosens: flagTurnsOn });
declareLoosening('payments.budget.', raisesLimit('raise a spending limit'));
declareLoosening('payments.windows.vetoMinutes', lowersThreshold('shorten the time you have to stop a purchase'));
declareLoosening('payments.majorRetailersAdditional', addsToList('add a shop that buys without asking you'));
declareLoosening('payments.majorRetailersExcluded', removesFromList('let an excluded shop buy without asking you'));
declareLoosening('payments.ebayMinSellerFeedbackCount', lowersThreshold('lower the eBay seller feedback a purchase needs'));
declareLoosening('payments.ebayMinSellerPositivePercent', lowersThreshold('lower the eBay seller rating a purchase needs'));
declareLoosening('payments.notifyChannels', addsToList('let another channel answer purchase approvals'));
// Every limit is counted in this currency, so another one changes what each limit is worth.
declareLoosening('payments.currency', { loosening: 'change the currency your spending limits are counted in', loosens: changes });
// A purchase inside the limits goes without asking, so whoever sets the address receives it.
declareLoosening('payments.shippingAddress.', { loosening: 'change where purchases are delivered', loosens: changes });
// The daily spending limits reset at midnight in this zone; a zone whose day
// started more recently reads today's spend as yesterday's. Read at the moment
// of the write: a change that leaves today's window where it is moves nothing.
declareLoosening('daemon.timezone', {
  loosening: 'move the day your daily spending limits are counted in',
  loosens: (prev, next) => timezoneChangeMovesToday(prev, next, Date.now()),
});

/**
 * The rule a key gets from what its value IS (schema-types.ts `ConfigSetting.valueKind`), declared on its schema row,
 * so a new key of such a kind is held back by every import, put to the owner when another caller sets it and refused
 * from a project file, with nothing listed here. A key with its own rule above keeps that rule.
 */
const VALUE_KIND_LOOSENING: Readonly<Record<ConfigValueKind, Loosening>> = {
  command: { loosening: 'change a command or program GoodVibes runs by itself', loosens: changes },
  endpoint: { loosening: 'change where GoodVibes sends data or credentials', loosens: changes },
  'request-target': { loosening: 'change which provider or model your requests are sent to', loosens: changes },
  path: { loosening: 'change a file or folder GoodVibes reads or writes outside the project', loosens: changes },
  'trusted-list': { loosening: 'change who or what GoodVibes trusts', loosens: changes },
  'protection-switch': {
    loosening: 'turn a protection off',
    loosens: (prev, next) => (typeof next === 'boolean' || typeof prev === 'boolean' ? flagTurnsOff(prev, next) : changes(prev, next)),
  },
  'opening-switch': { loosening: 'open a door to this computer or its data', loosens: flagTurnsOn },
};

let valueKinds: Map<string, ConfigValueKind> | null = null;
function valueKindOf(key: string): ConfigValueKind | undefined {
  valueKinds ??= new Map(CONFIG_SCHEMA.flatMap((setting) => setting.valueKind ? [[setting.key, setting.valueKind] as const] : []));
  return valueKinds.get(key);
}

function looseningFor(key: string): Loosening | undefined {
  const exact = EXACT_LOOSENING.get(key);
  if (exact) return exact;
  for (const [prefix, loosening] of PREFIX_LOOSENING) if (key.startsWith(prefix)) return loosening;
  const kind = valueKindOf(key);
  return kind === undefined ? undefined : VALUE_KIND_LOOSENING[kind];
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

/**
 * The one projection of a setting's value for every screen, receipt and undo
 * file. A credential or card field shows `(secret)`, or its
 * `goodvibes://secrets/...` reference when that is what is stored (a
 * reference is the safe at-rest shape); a `Secret` shows its label only; any
 * other value is shown as written, with every credential-shaped span masked
 * (maskCredentialCandidates, a local pass).
 */
export function displaySettingValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return '(unset)';
  if (value === '') return '(empty)';
  if (isSecret(value)) return value.toString();
  if (isProtectedConfigValue(key)) return isSecretReferenceValue(value) ? String(value).trim() : '(secret)';
  if (typeof value === 'string') return maskCredentialCandidates(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return maskCredentialCandidates(JSON.stringify(value) ?? String(value));
}
