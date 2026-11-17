import { agentResearchSourceOwner } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { withModelReadingSource, captureModelReadingInput, assertModelReadingInputCurrent } from './agent-harness-model-reading-source.ts';
/** Preferred settings and compatibility harness share one exact effect-owner plan. */
import { settingsOutcomeError } from './agent-settings-outcome.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { agentSettingsWriteRefusal } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import { assertCurrentToolInvocation, assertProjectionExecution, claimCurrentToolSettingsDispatch,
  commitCurrentToolSettingsPlan, currentToolSettingsPresentation, ToolInputProjectionError,
  type ToolInputProjector, type ToolRegistry, type ToolPreparedSettingsMutation } from '@goodvibes-jev/engine/platform/platform/tools';
import { assertPreparedConfigWriteRoute, resolvePreparedConfigWriteRoute, captureRemoteSettingsPrecondition,
  assertRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition, applyRemoteSettingsPrecondition, isSecretBearingConfigKey,
  type ConfigKey, type ConfigWriteRoute, type PreparedConfigMutationFacts,
  type PreparedConfigMutationReceipt, type RemoteSettingsPrecondition } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
import { resolveWakeEnablementCompanion } from '@goodvibes-jev/engine/platform/platform/voice';
import { AGENT_WAKE_SURFACE } from '../audio/wake-surface.ts';
import { coerceHarnessSettingValue, bindSettingSchemaDescriptors, resolveHarnessSettingAsync, type HarnessSettingLookup } from '../agent/harness-control.ts';
import { getAgentSettingsSchema } from '../config/settings-catalog.ts';
import { agentDaemonConfigClient, agentDaemonConfigClientRevision, buildAgentConfigRouting, configKeyScope } from '../config/daemon-config-routing.ts';
import { buildGoodVibesSecretKey, defaultSecretBackedScope, isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import { createAgentSettingsImportProjector, isAgentSettingsImportMutation } from './agent-settings-import-admission.ts';
import { readSettingsAction } from './agent-settings-action.ts';

export function preferredSettingsMutation(name: string, args: Record<string, unknown>): 'set' | 'reset' | undefined {
  if (name === 'agent_harness') return args.mode === 'set_setting' ? 'set' : args.mode === 'reset_setting' ? 'reset' : undefined;
  const action = readSettingsAction(args);
  return action === 'set' || action === 'reset' ? action : undefined;
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const posture = (value: unknown) => Object.freeze({ redacted: true, configured: value !== undefined && value !== null && value !== '' });
interface Capture {
  readonly argsJson: string;
  readonly operation: 'set' | 'reset';
  readonly key: string;
  readonly lookup: HarnessSettingLookup;
  readonly local?: ToolPreparedSettingsMutation | undefined;
  readonly remote?: RemoteSettingsPrecondition | undefined;
  readonly applyRemote?: (() => Promise<PreparedConfigMutationReceipt & { verifiedInOwningStore?: boolean }>) | undefined;
  readonly assertOwner: () => void;
  readonly persistedTo: string;
  readonly companion?: Readonly<{ key: string; value: unknown; message: string }> | undefined;
  released: boolean;
  spent: boolean;
}
const captures = new WeakMap<object, Capture>();
let projectionSequence = 0;
function assertCapture(capture: Capture): void {
  if (capture.released || capture.spent) throw new ToolInputProjectionError('stale');
  capture.assertOwner();
  if (capture.local) {
    if (capture.local.mutation) capture.local.owner.assertPreparedMutation(capture.local.mutation);
    const secret = capture.local.secretDeletion; if (secret) secret.owner.assertPreparedScopedDeletion(secret.mutation);
  }
}

export function createPreferredSettingsProjector(platform: Pick<CommandContext['platform'], 'configManager' | 'secretsManager'>,
  fallback?: ToolInputProjector, readingContext?: { readonly registry: ToolRegistry; readonly context: CommandContext }): ToolInputProjector {
  const config = platform.configManager; const secrets = platform.secretsManager;
  const imports = readingContext ? createAgentSettingsImportProjector(readingContext.context, undefined, readingContext.registry) : undefined;
  return { async project(request) {
    if (isAgentSettingsImportMutation(request.name, request.args)) {
      if (!imports) throw new ToolInputProjectionError('unconfigured');
      return imports.project(request);
    }
    const operation = preferredSettingsMutation(request.name, request.args);
    if (!operation) {
      const result = fallback ? await fallback.project(request) : { status: 'projected' as const, args: request.args };
      if (result.status !== 'projected') return result;
      return { ...result, assertRepairedArgs(next) {
        if (preferredSettingsMutation(request.name, next)) throw new ToolInputProjectionError('binding-changed');
        result.assertRepairedArgs?.(next);
      } };
    }
    request.assertCurrent(); request.signal?.throwIfAborted();
    const original = request.args;
    const signal = request.signal, assertRequestCurrent = request.assertCurrent;
    const originalJson = JSON.stringify(captureModelReadingInput(original));
    const schemaMethods = [config.getSchema, config.getHostSettingsSchema];
    const builtinSchema = config.getSchema(), hostSchema = config.getHostSettingsSchema();
    const assertSchemaDescriptors = bindSettingSchemaDescriptors([builtinSchema, hostSchema]);
    const schema = getAgentSettingsSchema(config);
    const client = agentDaemonConfigClient(); const installRevision = agentDaemonConfigClientRevision();
    const incarnation = config.getConfigurationIncarnation();
    const owner = agentResearchSourceOwner(readingContext?.registry);
    const runtime = readingContext?.context.session?.runtime;
    const sessionId = runtime?.sessionId;
    const retained = new Map<string | (() => void), () => void>();
    const assertRoutingOwner = () => {
      assertSchemaDescriptors();
      if (platform.configManager !== config || platform.secretsManager !== secrets || agentDaemonConfigClient() !== client || agentDaemonConfigClientRevision() !== installRevision
        || config.getSchema !== schemaMethods[0] || config.getHostSettingsSchema !== schemaMethods[1]
        || config.getSchema() !== builtinSchema || config.getHostSettingsSchema() !== hostSchema) throw new ToolInputProjectionError('stale');
    };
    const assertSelectionSource = () => {
      if (request.args !== original || request.signal !== signal || request.assertCurrent !== assertRequestCurrent) throw new ToolInputProjectionError('stale');
      signal?.throwIfAborted(); assertRoutingOwner();
      assertModelReadingInputCurrent(original, originalJson);
      if (config.getConfigurationIncarnation() !== incarnation
        || agentResearchSourceOwner(readingContext?.registry) !== owner || readingContext?.context.session?.runtime !== runtime
        || runtime?.sessionId !== sessionId) throw new ToolInputProjectionError('stale');
    };
    // Preparation authority is consume-only. The admitted body must not re-enter it.
    const assertSelection = () => { assertRequestCurrent(); assertSelectionSource(); };
    const reading = { signal, sourceOwner: owner, assertCurrent: assertSelection,
      retainCurrent: (guard: () => void, key?: string) => { if (!retained.has(key ?? guard)) retained.set(key ?? guard, guard); } };

    const lookupArgs = {
      key: text(original.key) || text(original.setting), target: text(original.target), query: text(original.query),
      category: text(original.category), prefix: text(original.prefix), includeHidden: original.includeHidden === true,
    };
    // Resolve/coerce before admission, never reinterpret an alias or a value in the body.
    const input = lookupArgs.key || lookupArgs.target || lookupArgs.query;
    const exactIdentifier = schema.some(setting => setting.key.toLowerCase() === input.toLowerCase());
    const found = exactIdentifier ? await resolveHarnessSettingAsync(config, lookupArgs, undefined, reading)
      : await withModelReadingSource(original, reading, async (_captured, scoped) => resolveHarnessSettingAsync(config, lookupArgs, undefined, scoped));
    assertSelection(); for (const guard of retained.values()) guard();
    // Setting keys are names from the schema, never the caller's text, so they may be named here.
    if (!found) throw new ToolInputProjectionError('invalid', 'No setting matches that key. List candidates with settings action:"list" query:"<words>" and pass the exact key it shows.');
    if (found.status === 'ambiguous') {
      throw new ToolInputProjectionError('invalid', `More than one setting matches; pass one exact key: ${found.candidates.map(candidate => candidate.key).join(', ')}.`);
    }
    if (!found.setting.writable) throw new ToolInputProjectionError('invalid', `The setting ${found.setting.key} is read-only here, so it cannot be ${operation === 'set' ? 'set' : 'reset'}. Tell the owner it can be changed where it is managed.`);
    const key = found.setting.key;
    const setting = schema.find(item => item.key === key)!;
    const secretKey = isSecretConfigKey(key) || isSecretBearingConfigKey(key);
    const coerced = operation === 'set' ? coerceHarnessSettingValue(setting, original.value) : setting.default;
    const value = secretKey && typeof coerced === 'string' ? coerced.trim() : coerced;
    if (operation === 'set' && original.value === undefined) throw new ToolInputProjectionError('invalid', 'settings action:"set" needs value.');
    // An alias must not hide declared credential material from the privacy floor.
    snapshotJudgmentInput({ key, value }, 'goodvibes_settings');
    assertSettingsWriteAllowed(operation, key, value);
    const credentialClear = secretKey && (operation === 'reset' || (typeof value === 'string' && value.trim() === ''));
    if (secretKey && operation === 'set' && typeof value === 'string' && value.trim() && !isSecretReferenceValue(value)) {
      throw new ToolInputProjectionError('invalid', `The setting ${key} stores a credential, so it takes a secret reference, not the credential itself. Ask the owner to store the value with /secrets set <name> and pass its goodvibes://secrets/... reference.`);
    }
    const capability = client?.preparedSettings;
    let route: ConfigWriteRoute | undefined;
    let remote: RemoteSettingsPrecondition | undefined;
    let applyRemote: Capture['applyRemote'];
    let remoteAssert: (() => void) | undefined;
    let local: ToolPreparedSettingsMutation | undefined;
    let localFacts: PreparedConfigMutationFacts | undefined;
    let persistedTo: string;
    let effect: Record<string, unknown>;
    const companion = operation === 'set' ? resolveWakeEnablementCompanion(key, value, next => config.get(next as ConfigKey), AGENT_WAKE_SURFACE) : null;
    const remoteRequest = { operation: operation === 'reset' ? 'reset-default' as const : 'set' as const, key,
      ...(operation === 'set' ? { value } : {}), ...(credentialClear ? { credentialClear: true as const } : {}) };
    if (configKeyScope(key) === 'daemon' && client) {
      if (!client.ownsKey(key) || !capability) {
        throw new ToolInputProjectionError('unconfigured', `The setting ${key} belongs to the daemon, and this session's daemon connection cannot write daemon settings. Change it on the daemon (its settings or the web UI).`);
      }
      remote = await capability.capture(remoteRequest);
      remoteAssert = () => { if (client.preparedSettings !== capability) throw new ToolInputProjectionError('stale'); capability.assertCurrent(remote!); };
      const facts = capability.inspect(remote);
      applyRemote = () => capability.apply(remote!);
      persistedTo = facts.endpoint;
      effect = { operation: facts.operation, key: facts.key, value: facts.value, destinations: facts.destinations,
        ...('credential' in facts ? { credential: facts.credential } : {}), previous: { unavailable: true }, appliedBy: 'daemon', endpoint: facts.endpoint };
    } else {
      route = await resolvePreparedConfigWriteRoute(key, buildAgentConfigRouting({ homeDir: config.getHomeDirectory() ?? undefined }), assertRoutingOwner);
      if (route.mode === 'daemon') {
        remote = await captureRemoteSettingsPrecondition(route.endpoint, remoteRequest);
        remoteAssert = () => assertRemoteSettingsPrecondition(remote!);
        const facts = inspectRemoteSettingsPrecondition(remote);
        applyRemote = () => applyRemoteSettingsPrecondition(remote!);
        persistedTo = facts.endpoint;
        effect = { operation: facts.operation, key: facts.key, value: facts.value, destinations: facts.destinations,
        ...('credential' in facts ? { credential: facts.credential } : {}), previous: { unavailable: true }, appliedBy: 'daemon', endpoint: facts.endpoint };
      } else {
        const mutation = config.prepareSettingMutationPlan([
          operation === 'set' ? { operation, key: key as ConfigKey, value } : { operation, key: key as ConfigKey },
          ...(companion ? [{ operation: 'set' as const, key: companion.key as ConfigKey, value: companion.value }] : []),
        ]);
        localFacts = config.inspectPreparedMutation(mutation);
        const secretDeletion = credentialClear ? (() => {
          if (!secrets) throw new ToolInputProjectionError('unconfigured');
          return Object.freeze({ owner: secrets, mutation: secrets.prepareScopedDeletion(buildGoodVibesSecretKey(key), defaultSecretBackedScope(key as ConfigKey)) });
        })() : undefined;
        local = Object.freeze({ owner: config, mutation, route, ...(secretDeletion ? { secretDeletion } : {}) });
        persistedTo = localFacts.destinations[0]!.path;
        const previous = setting.kind === 'host' ? config.getHostBooleanSetting(key).get() : config.get(key as ConfigKey);
        effect = { operation, key, value: localFacts.value, previous: isSecretBearingConfigKey(key) ? posture(previous) : previous,
          appliedBy: 'local', destinations: localFacts.destinations,
          ...(localFacts.effects ? { effects: localFacts.effects.map(({ operation, key, value, destinations }) => ({ operation, key, value, destinations })) } : {}),
          ...(secretDeletion ? { credential: secretDeletion.owner.inspectPreparedScopedDeletion(secretDeletion.mutation) } : {}) };
      }
    }
    request.assertCurrent(); request.signal?.throwIfAborted();
    // Protect all backend facts, including defaults and every companion, before hashing/judgment.
    effect = snapshotJudgmentInput(effect, 'goodvibes_settings') as Record<string, unknown>;
    const context = Object.freeze({});
    const assertOwner = () => {
      assertSelectionSource(); for (const guard of retained.values()) guard();
      assertRoutingOwner();
      if (config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('stale');
      if (route) assertPreparedConfigWriteRoute(route);
      remoteAssert?.();
    };
    const capture: Capture = { argsJson: originalJson, operation, key, lookup: found.lookup, local, remote, applyRemote,
      assertOwner, persistedTo, ...(companion ? { companion } : {}), released: false, spent: false };
    assertCapture(capture); captures.set(context, capture);
    return { status: 'projected', args: original, executionContext: context, settingsMutation: local,
      settingsAdmissionEvidence: Object.freeze({ kind: 'agent-settings', operation, key, effect,
        revision: `agent-settings-${(++projectionSequence).toString(36)}` }),
      assertCurrent: () => { assertSelection(); assertCapture(capture); },
      assertRepairedArgs(next) { assertSelection(); assertModelReadingInputCurrent(next, capture.argsJson); assertCapture(capture); },
      async release() { capture.released = true; captures.delete(context); },
    };
  } };
}

export async function executeAdmittedPreferredSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<Awaited<ReturnType<Tool['execute']>>> {
  const context = options?.inputProjectionContext; const capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolInvocation(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args);
  assertModelReadingInputCurrent(args, capture.argsJson);
  assertCapture(capture);
  const presentation = currentToolSettingsPresentation(args, options);
  capture.spent = true;
  let receipt: PreparedConfigMutationReceipt & { verifiedInOwningStore?: boolean };
  if (capture.local) receipt = await commitCurrentToolSettingsPlan(args, options);
  else { claimCurrentToolSettingsDispatch(args, options); receipt = await capture.applyRemote!(); }
  let verified = receipt.status === 'committed' && receipt.verifiedInOwningStore === true;
  const local = capture.local;
  if (receipt.status === 'committed' && local) {
    // Whether the commit landed is the owners' question, as for an import.
    try {
      if (local.mutation) local.owner.assertCompletedMutation(local.mutation);
      if (local.secretDeletion) local.secretDeletion.owner.assertCompletedScopedDeletion(local.secretDeletion.mutation);
      verified = true;
    } catch (completionError) {
      // Reporting cannot undo an already committed effect; verified stays false and says so.
      verified = false;
      logger.warn('A committed setting could not be confirmed by its owner', { key: capture.key, error: summarizeError(completionError) });
    }
  }
  const refused = 'refused' in receipt && receipt.refused === true;
  const reportedReason = refused && 'refusalReason' in receipt ? receipt.refusalReason : undefined;
  const refusalReason = (['stale', 'spent', 'managed', 'read-only', 'owner-fault'] as const).find(known => known === reportedReason);
  const unverified = settingsCommitWarning(receipt.status, verified);
  return { success: receipt.status === 'committed', output: JSON.stringify({ key: capture.key, action: capture.operation,
    status: refused ? 'refused' : receipt.status, ...(refusalReason ? { refusalReason } : {}), previous: presentation.previous,
    ...(verified && (capture.operation === 'set' || capture.remote) ? { current: presentation.current } : {}),
    lookup: capture.lookup, scope: configKeyScope(capture.key), appliedBy: capture.local ? 'local' : 'daemon',
    persistedTo: capture.persistedTo, verifiedInOwningStore: verified, completedPaths: receipt.completedPaths,
    ...(capture.companion && receipt.status === 'committed' ? { alsoSet: capture.companion } : {}),
    ...(receipt.uncertainPath ? { uncertainPath: receipt.uncertainPath } : {}),
    ...(unverified ? { warning: unverified } : {}) }),
    ...(unverified ? { warnings: [unverified] } : {}),
    ...(receipt.status !== 'committed' ? { error: settingsOutcomeError(receipt.status, refused, refusalReason) } : {}) };
}

const SETTINGS_COMMITTED_UNVERIFIED = 'The owner reports the change as committed, but it could not be read back from the owning store, so it is not confirmed. Read the setting before telling the user it is set.';

/** A committed write that could not be read back is reported with a next step, not as plain success. */
export function settingsCommitWarning(status: string, verified: boolean): string | undefined {
  return status === 'committed' && !verified ? SETTINGS_COMMITTED_UNVERIFIED : undefined;
}

/**
 * A call that threw. A held or stale admission is the only thing that means
 * "nothing was tried"; anything else may have happened after the capture was
 * spent, so it is reported with its cause and the instruction to read the
 * setting back instead of as an authorization hold.
 */
/** Settings an agent may not write (card material, credential destinations, a literal or another key's secret) are refused before any admission or effect. */
export class SettingsWriteRefusedError extends ToolInputProjectionError {
  // The refusal rides as the error's detail: a projector throw never reaches execute, so the host's describers are the only path to the agent.
  constructor(readonly refusal: string) { super('held', refusal); }
}

export function assertSettingsWriteAllowed(operation: 'set' | 'reset', key: string, value: unknown): void {
  const refusal = agentSettingsWriteRefusal({ mode: operation, key, value });
  if (refusal) throw new SettingsWriteRefusedError(refusal);
}

export function settingsThrownFailure(subject: 'mutation' | 'import', thrown: unknown): { readonly success: false; readonly error: string } {
  if (thrown instanceof SettingsWriteRefusedError) return { success: false, error: thrown.refusal };
  // An admission problem (held, stale, released) means nothing was tried; the tool
  // runtime words it with its cause and next step from the one table.
  if (thrown instanceof ToolInputProjectionError) throw thrown;
  return { success: false, error: `Settings ${subject} did not finish: ${summarizeError(thrown)}. It may or may not have been applied and was not retried; read the setting before requesting it again.` };
}
