/**
 * What a project settings file may NOT do.
 *
 * The project file lives inside the working directory, so it is repository
 * content: whoever authored the repository wrote it, not necessarily the person
 * opening it. Workspace trust only gates the ask layer, so a project value that
 * makes the permission machinery approve on its own, or that points a secret at
 * a command or a destination at a foreign host, would take effect before any
 * trust question is raised.
 *
 * The rule is one-directional: a project file may make the posture stricter than
 * the user's own settings, never looser, and it may not carry the keys below at
 * all. A refused value stays in the file untouched and is reported through an
 * ingestion notice; the owner who wants it applies it from their own settings.
 */
import { CREDENTIAL_DESTINATION_KEYS } from './credential-destination-keys.js';
import { deleteRawDotPath } from './settings-io.js';
import { readDotPath } from './shared-config-tier.js';
import { parsePermissionMode } from '../gate/presets.js';
import { normalizeSecretRef } from './secret-refs.js';
import { SAFETY_GATE_CONFIG_PREFIXES, type SettingsIngestionNotice } from './settings-ingestion.js';

/** Keys a project file cannot set: they point work or data at a destination. */
const PROJECT_FORBIDDEN_KEYS: readonly string[] = [
  'judgment.endpoint', 'notifications.webhookUrls', ...CREDENTIAL_DESTINATION_KEYS,
];

const MODE_RANK: Readonly<Record<string, number>> = { plan: 0, 'safe-owner': 1, 'safe-jev': 2, yolo: 3 };
const TOOL_RANK: Readonly<Record<string, number>> = { deny: 0, prompt: 1, allow: 2 };

/** Switches that open a listener or a destination; a project file may not turn them on. */
const PROJECT_OPENING_SWITCHES: readonly string[] = [
  'danger.httpListener', 'controlPlane.allowRemote', 'controlPlane.trustProxy', 'fetch.allowLocalhost',
];

/**
 * Safety-gate keys a project file may only repeat, never change. The judgment
 * keys in the gate list are left out: a project legitimately picks its own
 * judgment backend, and the loader already retains the last admitted chain.
 */
const PROJECT_PINNED_PREFIXES: readonly string[] = SAFETY_GATE_CONFIG_PREFIXES.filter(prefix =>
  !prefix.startsWith('judgment.') && prefix !== 'provider.decisionRouter'
  && prefix !== 'permissions.mode' && prefix !== 'permissions.tools.');

/**
 * Network, listener and background-agent keys outside the safety-gate list that
 * still widen what the process reaches or accepts; a project file may only
 * repeat the user's value for them.
 */
const PROJECT_NETWORK_PINNED: readonly string[] = [
  'network.remoteFetch.allowPrivateHosts', 'network.outboundTls.', 'fetch.trustedHosts', 'fetch.sanitizeMode',
  'controlPlane.host', 'controlPlane.hostMode', 'controlPlane.cors.allowedOrigins',
  'httpListener.host', 'httpListener.hostMode', 'httpListener.trustProxy', 'permissions.backgroundAgents',
];

function isPinnedKey(key: string): boolean {
  return PROJECT_NETWORK_PINNED.some(prefix => (prefix.endsWith('.') ? key.startsWith(prefix) : key === prefix))
    || PROJECT_PINNED_PREFIXES.some(prefix => (prefix.endsWith('.') ? key.startsWith(prefix) : key === prefix));
}

/** True for a key whose project value is only honoured when it is stricter (or not at all). */
export function isProjectRestrictedKey(key: string): boolean {
  return PROJECT_FORBIDDEN_KEYS.includes(key) || key === 'permissions.mode' || key === 'behavior.autoApprove'
    || key === 'sandbox.enabled' || key.startsWith('permissions.tools.')
    || PROJECT_OPENING_SWITCHES.includes(key) || isPinnedKey(key);
}

function hostList(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modeRank(value: unknown): number | undefined {
  const parsed = parsePermissionMode(value);
  return parsed === undefined ? undefined : MODE_RANK[parsed];
}

function isExecSecretRef(value: unknown): boolean {
  if (typeof value !== 'string' && !(isPlainObject(value) && ('source' in value || 'provider' in value || 'type' in value))) return false;
  return normalizeSecretRef(value)?.source === 'exec';
}

function collectLeaves(value: unknown, path: string, out: Array<{ path: string; value: unknown }>): void {
  if (isPlainObject(value) && !isExecSecretRef(value)) {
    for (const [field, child] of Object.entries(value)) collectLeaves(child, path ? `${path}.${field}` : field, out);
    return;
  }
  out.push({ path, value });
}

/**
 * Remove from a freshly ingested project layer every value that would loosen the
 * posture already established by `current` (the merged defaults and user file).
 * Mutates and returns the layer.
 */
export function restrictProjectLayer(
  layer: Record<string, unknown>,
  current: unknown,
  file: string,
): { readonly layer: Record<string, unknown>; readonly notices: SettingsIngestionNotice[] } {
  const notices: SettingsIngestionNotice[] = [];
  const refuse = (key: string, reason: string): void => {
    deleteRawDotPath(layer, key);
    notices.push({
      file, key, action: 'skipped', reason,
      remedy: 'Set it in your own settings file; a project settings file can only make this stricter',
    });
  };
  const userValue = (key: string): unknown => readDotPath(current, key).value;

  for (const key of PROJECT_FORBIDDEN_KEYS) {
    if (readDotPath(layer, key).present) refuse(key, 'a project settings file cannot set where data or judgment calls are sent');
  }

  const mode = readDotPath(layer, 'permissions.mode');
  if (mode.present) {
    const proposed = modeRank(mode.value);
    const baseline = modeRank(userValue('permissions.mode'));
    if (proposed !== undefined && baseline !== undefined && proposed > baseline) {
      refuse('permissions.mode', 'a project settings file cannot loosen the permission mode');
    }
  }
  const autoApprove = readDotPath(layer, 'behavior.autoApprove');
  if (autoApprove.present && autoApprove.value === true && userValue('behavior.autoApprove') !== true) {
    refuse('behavior.autoApprove', 'a project settings file cannot turn on automatic approval');
  }
  const sandbox = readDotPath(layer, 'sandbox.enabled');
  if (sandbox.present && sandbox.value === false && userValue('sandbox.enabled') !== false) {
    refuse('sandbox.enabled', 'a project settings file cannot turn the sandbox off');
  }
  const tools = readDotPath(layer, 'permissions.tools');
  if (tools.present && isPlainObject(tools.value)) {
    for (const [tool, proposed] of Object.entries(tools.value)) {
      const key = `permissions.tools.${tool}`;
      const proposedRank = typeof proposed === 'string' ? TOOL_RANK[proposed] : undefined;
      const baselineValue = userValue(key);
      // A tool the user never configured is held to the default ask posture.
      const baseline = typeof baselineValue === 'string' ? TOOL_RANK[baselineValue] : TOOL_RANK['prompt'];
      if (proposedRank !== undefined && baseline !== undefined && proposedRank > baseline) {
        refuse(key, 'a project settings file cannot loosen a per-tool permission');
      }
    }
  }

  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(layer, '', leaves);
  for (const leaf of leaves) {
    if (PROJECT_OPENING_SWITCHES.includes(leaf.path)) {
      if (leaf.value === true && userValue(leaf.path) !== true) {
        refuse(leaf.path, 'a project settings file cannot open a listener, a remote entry point or local fetching');
      }
    } else if (isPinnedKey(leaf.path)) {
      const baseline = userValue(leaf.path);
      if (leaf.path === 'fetch.blockedHosts') {
        const kept = new Set(hostList(leaf.value));
        if (hostList(baseline).some(host => !kept.has(host))) {
          refuse(leaf.path, 'a project settings file cannot remove a host from the fetch block list');
        }
      } else if (leaf.path === 'relay.requireStepUpForMutations' && leaf.value === true) {
        continue;
      } else if (JSON.stringify(leaf.value) !== JSON.stringify(baseline)) {
        refuse(leaf.path, 'a project settings file cannot change a safety-gate setting');
      }
    }
  }
  for (const leaf of leaves) {
    if (leaf.path && isExecSecretRef(leaf.value)) {
      refuse(leaf.path, 'a project settings file cannot reference a secret read by running a command');
    }
  }
  return { layer, notices };
}
