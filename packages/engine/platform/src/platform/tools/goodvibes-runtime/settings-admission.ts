/** Backend-owned SETTINGS preparation. All semantic observations precede common admission. */
import { lstatSync } from 'node:fs';
import type { ConfigWriteRoute } from '../../config/daemon-config-route.js';
import { preparedReceiptWrites, type ConfigManager, type PreparedConfigMutationFacts, type PreparedConfigMutationReceipt } from '../../config/manager.js';
import { isValidConfigKey } from '../../config/schema.js';
import { admitSettingValue } from '../../config/write-admission.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { agentSettingsWriteRefusal } from '../../gate/policy/agent-settings-refusals.js';
import { configKeyScope, describeConfigOwnership } from '../../config/config-ownership.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { applyRemoteSettingsPrecondition, assertRemoteSettingsPrecondition, captureRemoteSettingsPrecondition,
  inspectRemoteSettingsPrecondition, resolvePreparedConfigWriteRoute, assertPreparedConfigWriteRoute, type RemoteSettingsPrecondition } from '../../config/settings-precondition-client.js';
import type { ToolExecuteOptions } from '../../types/tools.js';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolPreparedSettingsMutation } from '../input-projection.js';
import { assertCurrentToolExecution, claimCurrentToolSettingsDispatch, commitCurrentToolSettings, currentToolSettingsPresentation } from '../registry.js';
import { applyRoutedConfigWrite, readClientOwnedValue, resolveRouterDeps, usesClientOwnedStore, type ClientOwnedStore, type ConfigRoutingOptions } from './config-routing.js';

/**
 * A client-owned key of the surface a hosted session was created for: that
 * surface's own settings file, as it stood when the write was prepared, and
 * the normalized value the write puts there.
 */
interface ClientStoreCapture {
  readonly store: ClientOwnedStore;
  readonly stamp: string;
  readonly value: unknown;
  readonly configManager: ConfigManager;
  readonly routing: ConfigRoutingOptions;
}

interface Capture {
  readonly argsJson: string;
  readonly key: string;
  readonly operation: 'set' | 'reset';
  readonly local?: ToolPreparedSettingsMutation | undefined;
  readonly localFacts?: PreparedConfigMutationFacts | undefined;
  readonly remote?: RemoteSettingsPrecondition | undefined;
  readonly client?: ClientStoreCapture | undefined;
  readonly source: string;
  readonly route: ConfigWriteRoute;
  released: boolean;
  spent: boolean;
}
const captures = new WeakMap<object, Capture>();
let projectionSequence = 0;

function assertCapture(capture: Capture): void {
  if (capture.released || capture.spent) throw new ToolInputProjectionError('stale');
  assertPreparedConfigWriteRoute(capture.route);
  if (capture.local) {
    if (!capture.local.mutation) throw new ToolInputProjectionError('stale');
    capture.local.owner.assertPreparedMutation(capture.local.mutation);
  }
  if (capture.remote) assertRemoteSettingsPrecondition(capture.remote);
  if (capture.client && clientStoreStamp(capture.client.store.settingsPath) !== capture.client.stamp) throw new ToolInputProjectionError('stale');
}
/** File identity, size and change time of a surface's settings file; one `lstat`. */
function clientStoreStamp(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : 'absent';
  } catch {
    return 'unreadable';
  }
}
/**
 * Writes the prepared value to the originating surface's file and reads it
 * back there. One attempt: a write whose read-back fails may or may not have
 * landed, so it is reported as unknown, never retried.
 */
async function applyClientStoreCapture(key: string, client: ClientStoreCapture): Promise<PreparedConfigMutationReceipt & { readonly verifiedInOwningStore: boolean }> {
  if (!isValidConfigKey(key)) throw new ToolInputProjectionError('invalid');
  try {
    const applied = await applyRoutedConfigWrite(client.configManager, key, client.value, client.routing);
    return Object.freeze({ status: 'committed' as const, completedPaths: Object.freeze([applied.persistedTo]), verifiedInOwningStore: true });
  } catch {
    return Object.freeze({ status: 'unknown' as const, completedPaths: Object.freeze([] as string[]), uncertainPath: client.store.settingsPath, verifiedInOwningStore: false });
  }
}
function posture(value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ redacted: true, configured: value !== undefined && value !== null && value !== '' });
}

export function createAgentSettingsInputProjector(configManager: ConfigManager, routing: ConfigRoutingOptions = {}): ToolInputProjector {
  return {
    async project(request) {
      request.assertCurrent(); request.signal?.throwIfAborted();
      const args = request.args;
      if ((args.mode !== 'set' && args.mode !== 'reset') || typeof args.key !== 'string') throw new ToolInputProjectionError('invalid');
      const key = args.key.trim();
      if (!isValidConfigKey(key)) throw new ToolInputProjectionError('invalid');
      // The one refusal of a settings write, before any local or remote write is prepared.
      const refusal = agentSettingsWriteRefusal({ mode: args.mode, key, value: args.value });
      if (refusal) throw new ToolInputProjectionError('held', refusal);
      // A key the surface a hosted session was created for keeps in its own
      // file (a client-owned key, or its own provider.model override) belongs
      // to that file, never to the hosting manager's store: it is prepared
      // against that file alone (see ClientStoreCapture).
      const clientStore = usesClientOwnedStore(key, routing) ? routing.clientOwnedStore : undefined;
      const route = await resolvePreparedConfigWriteRoute(key, resolveRouterDeps(configManager, routing));
      request.assertCurrent(); request.signal?.throwIfAborted();
      let local: ToolPreparedSettingsMutation | undefined;
      let localFacts: PreparedConfigMutationFacts | undefined;
      let remote: RemoteSettingsPrecondition | undefined;
      let client: ClientStoreCapture | undefined;
      let effect: Record<string, unknown>;
      let source: string;
      if (clientStore) {
        const setting = configManager.getSchema().find(entry => entry.key === key);
        if (!setting) throw new ToolInputProjectionError('invalid');
        // A reset writes the schema default to that file, as the routed reset does.
        const admitted = admitSettingValue(key, setting, args.mode === 'set' ? args.value : setting.default);
        if (!admitted.ok) throw new ToolInputProjectionError('held', `${key} was not changed: ${admitted.reason}.`);
        const stamp = clientStoreStamp(clientStore.settingsPath);
        const previous = readClientOwnedValue(clientStore, key, configManager.getSharedTierPath());
        client = { store: clientStore, stamp, value: admitted.value, configManager, routing };
        source = clientStore.settingsPath;
        effect = { operation: args.mode, key, value: admitted.value,
          destinations: [{ path: clientStore.settingsPath, operation: 'set', tier: 'global' }],
          appliedBy: 'local', surface: clientStore.surface, previous: isSecretBearingConfigKey(key) ? posture(previous) : previous };
      } else if (route.mode === 'daemon') {
        remote = await captureRemoteSettingsPrecondition(route.endpoint,
          args.mode === 'reset' ? { operation: 'reset-default', key } : { operation: 'set', key, value: args.value }, routing);
        request.assertCurrent(); request.signal?.throwIfAborted();
        const facts = inspectRemoteSettingsPrecondition(remote);
        source = facts.endpoint;
        effect = { operation: facts.operation, key, value: facts.value, destinations: facts.destinations,
          appliedBy: 'daemon', endpoint: facts.endpoint, previous: { unavailable: true } };
      } else {
        const mutation = configManager.prepareSettingMutation(args.mode === 'set'
          ? { operation: 'set', key, value: args.value } : { operation: 'reset', key });
        local = Object.freeze({ owner: configManager, mutation, route });
        localFacts = configManager.inspectPreparedMutation(mutation);
        // Known credential old values never enter the hosted inspection path.
        const previous = configManager.get(key);
        source = localFacts.destinations[0]?.path ?? configManager.getConfigPath();
        effect = { operation: localFacts.operation, key, value: localFacts.value, destinations: localFacts.destinations,
          appliedBy: 'local', previous: isSecretBearingConfigKey(key) ? posture(previous) : previous };
      }
      // Protect complete raw backend facts before hashing, recording or judgment.
      effect = captureOwnedJson(effect) as Record<string, unknown>;
      request.assertCurrent(); request.signal?.throwIfAborted();
      const context = Object.freeze({});
      const capture: Capture = { argsJson: JSON.stringify(args), key, operation: args.mode, local, localFacts, remote, client, source, route,
        released: false, spent: false };
      assertCapture(capture); captures.set(context, capture);
      const revision = `runtime-settings-${(++projectionSequence).toString(36)}`;
      return { status: 'projected', args, executionContext: context, settingsMutation: local,
        settingsAdmissionEvidence: Object.freeze({ kind: 'agent-settings', operation: args.mode, key, effect, revision }),
        assertCurrent: () => assertCapture(capture),
        assertRepairedArgs: next => {
          if (JSON.stringify(next) !== capture.argsJson) throw new ToolInputProjectionError('binding-changed');
          assertCapture(capture);
        },
        release: async () => { capture.released = true; captures.delete(context); },
      };
    },
  };
}

export function assertAdmittedAgentSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const context = options?.inputProjectionContext;
  const capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args);
  if (JSON.stringify(args) !== capture.argsJson) throw new ToolInputProjectionError('binding-changed');
  assertCapture(capture);
}

/** Actual adopted backend. No semantic read, route resolution or refreshed retry after claim. */
export async function executeAdmittedAgentSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
  assertAdmittedAgentSettings(args, options);
  const capture = captures.get(options!.inputProjectionContext!)!;
  const presentation = currentToolSettingsPresentation(args, options);
  capture.spent = true;
  let receipt;
  if (capture.local) receipt = commitCurrentToolSettings(args, options);
  else if (capture.client) {
    claimCurrentToolSettingsDispatch(args, options);
    receipt = await applyClientStoreCapture(capture.key, capture.client);
  } else {
    claimCurrentToolSettingsDispatch(args, options);
    receipt = await applyRemoteSettingsPrecondition(capture.remote!);
  }
  let verified = !capture.localFacts && receipt.status === 'committed'
    && 'verifiedInOwningStore' in receipt && receipt.verifiedInOwningStore === true;
  if (receipt.status === 'committed' && capture.localFacts) {
    // The receipt carries what each file holds after the commit, read from the
    // document it wrote; a later write by another process cannot relabel it.
    const written = preparedReceiptWrites(receipt);
    verified = capture.localFacts.destinations.every(destination => {
      const found = written.find(entry => entry.path === destination.path && entry.key === capture.key);
      if (!found) return destination.operation === 'remove';
      return destination.operation === 'remove' ? !found.present
        : found.present && JSON.stringify(found.value) === JSON.stringify(capture.localFacts!.value);
    });
  }
  const refused = 'refused' in receipt && receipt.refused === true;
  return { success: receipt.status === 'committed', output: JSON.stringify({ key: capture.key, action: capture.operation,
    status: refused ? 'refused' : receipt.status, previous: presentation.previous,
    ...(receipt.status === 'committed' && verified && (capture.operation === 'set' || capture.remote) ? { current: presentation.current } : {}),
    persistedTo: capture.source, appliedBy: capture.remote ? 'daemon' : 'local', owner: configKeyScope(capture.key),
    ownership: describeConfigOwnership(capture.key), verifiedInOwningStore: verified,
    completedPaths: receipt.completedPaths, ...(receipt.uncertainPath ? { uncertainPath: receipt.uncertainPath } : {}) }),
    ...(receipt.status !== 'committed' ? { error: settingsOutcomeError(receipt.status, refused) } : {}) };
}

/** What a caller may do next depends on whether anything may have been written. */
function settingsOutcomeError(status: 'partial' | 'unknown', refused: boolean): string {
  if (refused) return 'The settings owner refused this change before applying anything (its precondition was stale or unavailable). Nothing changed; read the setting and request the change again.';
  if (status === 'partial') return 'The settings change was partly applied: the files in completedPaths were written and uncertainPath may or may not have been. It was not retried; read the setting before deciding whether to change it again.';
  return 'The settings change has an unknown outcome: the owner gave no definite answer, so it may or may not have been applied. It was not retried; read the setting to see whether it changed before requesting it again.';
}
