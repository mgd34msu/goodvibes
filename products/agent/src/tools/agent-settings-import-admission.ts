import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { settingsOutcomeError } from './agent-settings-outcome.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { assertCurrentToolInvocation, assertProjectionExecution, commitCurrentToolSettingsPlan, ToolInputProjectionError,
  type ToolInputProjector, type ToolPreparedSettingsMutation, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { assertPreparedConfigWriteRoute, resolvePreparedConfigWriteRoute, type ConfigKey, type PreparedConfigMutationRequest,
  type PreparedConfigMutationFacts, type ConfigWriteRoute, type SecretImportEntry, isSecretBearingConfigKey,
  captureRemoteSettingsImportPrecondition, assertRemoteSettingsImportPrecondition, inspectRemoteSettingsImportPrecondition,
  assertCompletedRemoteSettingsImportPrecondition, type RemoteSettingsImportPrecondition } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveWakeEnablementCompanion } from '@goodvibes-jev/engine/platform/platform/voice';
import { AGENT_WAKE_SURFACE } from '../audio/wake-surface.ts';
import { agentResearchSourceOwner } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { bindSettingSchemaDescriptors, coerceHarnessSettingValue } from '../agent/harness-control.ts';
import { getAgentSettingsSchema } from '../config/settings-catalog.ts';
import { agentDaemonConfigClient, agentDaemonConfigClientRevision, buildAgentConfigRouting, configKeyScope } from '../config/daemon-config-routing.ts';
import { buildSecretBackedConfigUpdate, defaultSecretBackedScope, isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import { assertSettingsWriteAllowed } from './agent-settings-admission.ts';
import { assertAgentWorkspaceImportPreviewPrivacy, captureAgentWorkspaceTuiSettingsImport } from '../input/agent-workspace-settings.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveWorkspaceActionIdentity } from './agent-harness-workspace-actions.ts';
import { captureModelReadingInput, assertModelReadingInputCurrent, modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { isImportApplyWord, readSettingsAction, settingsImportWord } from './agent-settings-action.ts';

type Options = NonNullable<Parameters<Tool['execute']>[1]>;
export function isAgentSettingsImportMutation(name: string, args: Record<string, unknown>): boolean {
  if (name === 'settings') return readSettingsAction(args) === 'import';
  const word = settingsImportWord(args);
  if (name === 'import_goodvibes_settings') return isImportApplyWord(word);
  if (name !== 'agent_harness' || args.mode !== 'run_workspace_action') return false;
  const resolved = resolveWorkspaceActionIdentity(args);
  return !!resolved && resolved.status !== 'ambiguous' && resolved.action.kind === 'settings-import'
    && word !== 'preview' && (isImportApplyWord(word) || args.confirm === true);
}

/** Select only the native import preview after inspecting the complete caller input. */
export function isAgentWorkspaceSettingsImportPreview(input: Record<string, unknown>): boolean {
  let args: Record<string, unknown>;
  try { args = captureModelReadingInput(input); }
  catch (error) {
    if (error instanceof ToolInputProjectionError) throw error;
    throw new ToolInputProjectionError('held');
  }
  assertAgentWorkspaceImportPreviewPrivacy(args);
  if (args.mode !== 'run_workspace_action') return false;
  const resolved = resolveWorkspaceActionIdentity(args);
  return !!resolved && resolved.status !== 'ambiguous' && resolved.action.kind === 'settings-import'
    && !isAgentSettingsImportMutation('agent_harness', args);
}
interface ImportCapture {
  readonly commandContext: CommandContext;
  readonly argsJson: string;
  readonly plan?: ToolPreparedSettingsMutation;
  readonly configFacts?: PreparedConfigMutationFacts;
  readonly effect: Readonly<Record<string, unknown>>;
  readonly assertCurrent: () => void;
  released: boolean;
  spent: boolean;
}
const captures = new WeakMap<object, ImportCapture>();
let projectionSequence = 0;
function assertCapture(capture: ImportCapture): void {
  if (capture.released || capture.spent) throw new ToolInputProjectionError('stale');
  capture.assertCurrent();
  const plan = capture.plan;
  if (plan?.mutation) plan.owner.assertPreparedMutation(plan.mutation);
  if (plan?.secretImport) plan.secretImport.owner.assertPreparedImport(plan.secretImport.mutation);
  if (plan?.subscriptionImport) plan.subscriptionImport.owner.assertPreparedImport(plan.subscriptionImport.mutation);
  if (plan?.remoteImport) assertRemoteSettingsImportPrecondition(plan.remoteImport);
}

/** Registered private source capture; complete credential/token values stay in native opaque plans. */
export function createAgentSettingsImportProjector(context: CommandContext, fallback?: ToolInputProjector, registry?: ToolRegistry): ToolInputProjector {
  return { async project(request) {
    if (!isAgentSettingsImportMutation(request.name, request.args)) return fallback ? fallback.project(request) : { status: 'projected', args: request.args };
    try {
      request.assertCurrent(); request.signal?.throwIfAborted();
      const args = request.args, argsJson = JSON.stringify(captureModelReadingInput(args));
      const signal = request.signal, assertRequestCurrent = request.assertCurrent;
      const platform = context.platform, workspace = context.workspace;
      const config = platform.configManager, secrets = platform.secretsManager, subscriptions = platform.subscriptionManager;
      const builtin = config.getSchema(), host = config.getHostSettingsSchema();
      const assertSchema = bindSettingSchemaDescriptors([builtin, host]);
      const incarnation = config.getConfigurationIncarnation();
      const client = agentDaemonConfigClient(), clientRevision = agentDaemonConfigClientRevision();
      const clientImport = client?.preparedImport, ownsKey = client?.ownsKey;
      const session = modelReadingServicePath(context, ['session', 'runtime']), sessionId = modelReadingServicePath(session, ['sessionId']);
      const readingOwner = agentResearchSourceOwner(registry);
      const source = captureAgentWorkspaceTuiSettingsImport(context);
      // What can move while the import waits: the request, the source files,
      // the settings schema and owners, and the daemon client. This tool call
      // is the import's one admission (the daemon does not judge it again).
      const assertSource = () => {
        if (request.args !== args || request.signal !== signal || request.assertCurrent !== assertRequestCurrent) throw new ToolInputProjectionError('stale');
        signal?.throwIfAborted(); assertModelReadingInputCurrent(args, argsJson); assertSchema(); source.assertCurrent();
        if (context.platform !== platform || context.workspace !== workspace || platform.configManager !== config
          || platform.secretsManager !== secrets || platform.subscriptionManager !== subscriptions
          || config.getSchema() !== builtin || config.getHostSettingsSchema() !== host
          || agentDaemonConfigClient() !== client || agentDaemonConfigClientRevision() !== clientRevision
          || client?.ownsKey !== ownsKey || client?.preparedImport !== clientImport
          || modelReadingServicePath(context, ['session', 'runtime']) !== session || modelReadingServicePath(session, ['sessionId']) !== sessionId
          || agentResearchSourceOwner(registry) !== readingOwner) throw new ToolInputProjectionError('stale');
      };
      const assertSelection = () => { assertRequestCurrent(); assertSource(); if (config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('stale'); };
      const schema = getAgentSettingsSchema(config), changes = new Map<string, PreparedConfigMutationRequest>();
      const privateValues = new Map<string, unknown>(), credentialBySetting = new Map<string, SecretImportEntry>();
      for (const entry of source.settings) {
        const setting = schema.find(setting => setting.key === entry.key);
        // The key comes from the owner's source settings file, not the model; only a key-shaped name is repeated.
        if (!setting) {
          const named = /^[A-Za-z0-9_.-]{1,120}$/.test(entry.key) ? entry.key : 'a key';
          throw new ToolInputProjectionError('invalid', `The import names ${named}, which is not a setting in this version; remove it from the source settings or update GoodVibes, then import again.`);
        }
        if (setting.kind === 'host') throw new ToolInputProjectionError('invalid', `The import names ${setting.key}, a setting of this machine that an import cannot change; remove it from the source settings, then import again.`);
        const coerced = coerceHarnessSettingValue(setting, entry.value);
        // A raw credential in the import is stored under the key's own secret; only references can name another key's secret.
        if (!((isSecretConfigKey(entry.key) || isSecretBearingConfigKey(entry.key)) && typeof coerced === 'string' && !isSecretReferenceValue(coerced))) {
          assertSettingsWriteAllowed('set', entry.key, coerced);
        }
        privateValues.set(entry.key, coerced);
        let value = coerced;
        if (isSecretConfigKey(entry.key) || isSecretBearingConfigKey(entry.key)) {
          if (typeof coerced !== 'string') throw new ToolInputProjectionError('invalid', `The import's value for ${setting.key} is not text; a credential setting takes a string or a goodvibes://secrets/... reference. Fix it in the source settings, then import again.`);
          const update = buildSecretBackedConfigUpdate(entry.key as ConfigKey, coerced);
          value = update.configValue;
          if (update.secretKey) credentialBySetting.set(entry.key, { key: update.secretKey, value: update.secretValue!, scope: defaultSecretBackedScope(entry.key as ConfigKey) });
          if (update.clearSecretKey) credentialBySetting.set(entry.key, { key: update.clearSecretKey, operation: 'delete', scope: defaultSecretBackedScope(entry.key as ConfigKey) });
        }
        // Import all declared values, including unchanged references; the native owner captures exact destinations.
        changes.set(entry.key, { operation: 'set', key: entry.key as ConfigKey, value });
        const companion = resolveWakeEnablementCompanion(entry.key, value, key => config.get(key as ConfigKey), AGENT_WAKE_SURFACE);
        if (companion) { changes.set(companion.key, { operation: 'set', key: companion.key as ConfigKey, value: companion.value }); privateValues.set(companion.key, companion.value); }
      }
      // Where a setting is written depends only on its scope, so each scope is resolved once per import.
      const routes = new Map<string, ConfigWriteRoute>();
      const localChanges: PreparedConfigMutationRequest[] = [], remoteSettings: { key: string; value: unknown }[] = [], credentials: SecretImportEntry[] = [];
      let remoteEndpoint: Extract<ConfigWriteRoute, { mode: 'daemon' }>['endpoint'] | undefined;
      for (const change of changes.values()) {
        if (client && ownsKey?.call(client, change.key)) {
          if (!clientImport) throw new ToolInputProjectionError('unconfigured', `The import includes ${change.key}, a daemon setting, and this session's daemon connection cannot import daemon settings. Import on the daemon, or remove the daemon settings from the source.`);
          remoteSettings.push({ key: change.key, value: privateValues.get(change.key) });
          continue;
        }
        const scope = configKeyScope(change.key);
        let route = routes.get(scope);
        if (!route) {
          route = await resolvePreparedConfigWriteRoute(change.key, buildAgentConfigRouting({ homeDir: config.getHomeDirectory() ?? undefined }), assertSource);
          assertSelection();
          routes.set(scope, route);
        }
        if (route.mode === 'daemon') {
          if (remoteEndpoint && (remoteEndpoint.baseUrl !== route.endpoint.baseUrl || remoteEndpoint.token !== route.endpoint.token)) throw new ToolInputProjectionError('stale');
          remoteEndpoint = route.endpoint;
          remoteSettings.push({ key: change.key, value: privateValues.get(change.key) });
        } else {
          localChanges.push(change);
          const credential = credentialBySetting.get(change.key); if (credential) credentials.push(credential);
        }
      }
      const assertSourceCurrent = () => { assertSource(); for (const route of routes.values()) assertPreparedConfigWriteRoute(route); };
      let remoteImport: RemoteSettingsImportPrecondition | undefined;
      if (remoteSettings.length) {
        const restriction = { signal, assertCurrent: assertSourceCurrent };
        if (clientImport) remoteImport = await clientImport.capture({ settings: remoteSettings }, restriction);
        else if (remoteEndpoint) remoteImport = await captureRemoteSettingsImportPrecondition(remoteEndpoint, { settings: remoteSettings }, restriction);
        else throw new ToolInputProjectionError('unconfigured', 'The import includes daemon settings and no daemon is reachable to take them. Start the daemon and import again.');
        assertSelection();
      }
      const remoteFacts = remoteImport ? inspectRemoteSettingsImportPrecondition(remoteImport) : undefined;
      // Lease clocks are checked by the private owner, never semantic evidence.
      const remoteEvidence = remoteFacts ? { operation: remoteFacts.operation, effects: remoteFacts.effects, incarnation: remoteFacts.incarnation,
        destinations: remoteFacts.destinations, ...(remoteFacts.credential ? { credential: remoteFacts.credential } : {}), endpoint: remoteFacts.endpoint } : undefined;
      const mutation = localChanges.length ? config.prepareSettingMutationPlan(localChanges) : undefined;
      const configFacts = mutation ? config.inspectPreparedMutation(mutation) : undefined;
      if (credentials.length && !secrets || source.subscriptions.length && !subscriptions) throw new ToolInputProjectionError('unconfigured', 'The import carries credentials or provider subscriptions, and this session has no store for them.');
      const secretImport = credentials.length && secrets ? Object.freeze({ owner: secrets, mutation: secrets.prepareImport(credentials) }) : undefined;
      const subscriptionImport = source.subscriptions.length && subscriptions ? Object.freeze({ owner: subscriptions, mutation: subscriptions.prepareImport(source.subscriptions) }) : undefined;
      const bindings = { owner: config, assertSourceCurrent, ...(remoteImport ? { remoteImport } : {}), ...(secretImport ? { secretImport } : {}), ...(subscriptionImport ? { subscriptionImport } : {}) };
      const plan: ToolPreparedSettingsMutation | undefined = mutation ? Object.freeze({ ...bindings, mutation })
        : secretImport ? Object.freeze({ ...bindings, secretImport }) : subscriptionImport ? Object.freeze({ ...bindings, subscriptionImport })
        : remoteImport ? Object.freeze({ ...bindings, remoteImport }) : undefined;
      const key = remoteFacts?.effects[0]?.key ?? configFacts?.key ?? 'provider.subscriptions';
      const effect = snapshotJudgmentInput({ operation: 'set', key, appliedBy: remoteImport ? 'daemon' : 'local', import: 'goodvibes-tui', sources: source.sources,
        ...(remoteEvidence ? { remote: remoteEvidence } : {}),
        effects: configFacts ? (configFacts.effects ?? [configFacts]).map(({ operation, key, value, destinations }) => ({ operation, key, value, destinations })) : [],
        ...(secretImport ? { credential: secretImport.owner.inspectPreparedImport(secretImport.mutation) } : {}),
        ...(subscriptionImport ? { subscriptions: subscriptionImport.owner.inspectPreparedImport(subscriptionImport.mutation) } : {}),
        skippedSubscriptions: source.skippedSubscriptions }, 'goodvibes_settings') as Readonly<Record<string, unknown>>;
      const executionContext = Object.freeze({});
      const capture: ImportCapture = { commandContext: context, argsJson, plan, configFacts, effect, assertCurrent: assertSelection, released: false, spent: false };
      assertCapture(capture); captures.set(executionContext, capture);
      return { status: 'projected', args, executionContext, ...(plan ? { settingsMutation: plan } : {}),
        settingsAdmissionEvidence: Object.freeze({ kind: 'agent-settings', operation: 'set', key, effect, revision: `agent-import-${(++projectionSequence).toString(36)}` }),
        assertCurrent: () => assertCapture(capture),
        assertRepairedArgs(next) { assertModelReadingInputCurrent(next, argsJson); assertCapture(capture); },
        async release() { capture.released = true; captures.delete(executionContext); } };
    } catch (error) {
      if (error instanceof ToolInputProjectionError) throw error;
      throw new ToolInputProjectionError(request.signal?.aborted ? 'cancelled' : 'invalid');
    }
  } };
}

export async function executeAdmittedAgentSettingsImport(context: CommandContext, args: Record<string, unknown>, options?: Options): Promise<Awaited<ReturnType<Tool['execute']>>> {
  const token = options?.inputProjectionContext, capture = token && captures.get(token);
  if (!token || !capture || capture.commandContext !== context || !assertCurrentToolInvocation(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(token, args); assertModelReadingInputCurrent(args, capture.argsJson); assertCapture(capture);
  capture.spent = true;
  if (!capture.plan) return { success: true, output: JSON.stringify({ status: 'unchanged', action: 'import_goodvibes_settings' }) };
  const receipt = await commitCurrentToolSettingsPlan(args, options);
  let verified = receipt.status === 'committed';
  if (verified) {
    try {
      // Whether the commit landed is a question for the owners' completion checks.
      // The pre-commit source and abort fences are not asked again: a cancel or a
      // source change after the write does not make a finished import partial.
      if (capture.plan.mutation) capture.plan.owner.assertCompletedMutation(capture.plan.mutation);
      if (capture.plan.secretImport) capture.plan.secretImport.owner.assertCompletedImport(capture.plan.secretImport.mutation);
      if (capture.plan.subscriptionImport) capture.plan.subscriptionImport.owner.assertCompletedImport(capture.plan.subscriptionImport.mutation);
      if (capture.plan.remoteImport) assertCompletedRemoteSettingsImportPrecondition(capture.plan.remoteImport);
    } catch { verified = false; }
  }
  return importReceiptResult(receipt, verified);
}

/** What the model is told about an import receipt: refused, partial, unknown and unconfirmed are different next steps. */
export function importReceiptResult(
  receipt: { readonly status: 'committed' | 'partial' | 'unknown'; readonly completedPaths?: unknown; readonly uncertainPath?: unknown; readonly refused?: boolean; readonly refusalReason?: unknown },
  verified: boolean,
): { readonly success: boolean; readonly output: string; readonly error?: string } {
  const refused = receipt.refused === true;
  const refusalReason = (['stale', 'spent', 'managed', 'read-only', 'owner-fault'] as const).find(known => known === receipt.refusalReason && refused);
  return { success: receipt.status === 'committed' && verified, output: JSON.stringify({ status: refused ? 'refused' : receipt.status, action: 'import_goodvibes_settings',
    ...(refusalReason ? { refusalReason } : {}),
    verifiedInOwningStore: verified, completedPaths: receipt.completedPaths, ...(receipt.uncertainPath ? { uncertainPath: receipt.uncertainPath } : {}) }),
    ...(!verified ? { error: receipt.status === 'committed'
      ? 'The import was committed but could not be confirmed in the owning stores. It was not retried; read the imported settings before relying on them.'
      : settingsOutcomeError(receipt.status, refused, refusalReason, 'import') } : {}) };
}
