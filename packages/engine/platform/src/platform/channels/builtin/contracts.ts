import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { admitByAllowlists, ChannelPolicyManager, type ChannelAllowlists } from '../policy-manager.js';
import type {
  ChannelAccountRecord,
  ChannelAllowlistEditInput,
  ChannelAllowlistEditResult,
  ChannelAllowlistResolution,
  ChannelAllowlistTarget,
  ChannelAllowlistTargetKind,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryScope,
  ChannelDoctorCheck,
  ChannelDoctorReport,
  ChannelDoctorStatus,
  ChannelLifecycleState,
  ChannelRenderPolicy,
  ChannelRepairAction,
  ChannelResolvedTarget,
  ChannelRuntimeObservation,
  ChannelSurface,
  ChannelTargetResolveOptions,
} from '../types.js';
import type { ChannelPlugin } from '../plugin-registry.js';
import { unobservableRuntime } from '../health.js';
import { builtinCredentialFacts, builtinHealthState } from './health.js';
import {
  CHANNEL_SETUP_VERSION,
  type BuiltinChannelRuntimeDeps,
  configSectionForSurface,
} from './shared.js';
import { renderBuiltinPolicy, surfaceLabelForBuiltin } from './presentation.js';
import { builtinSendCredentials, getBuiltinSetupSchema } from './setup-schema.js';
import { INBOUND_CREDENTIAL_SOURCES, resolveInboundCredential, type InboundCredentialSurface } from '../../adapters/surface-credential.js';

interface BuiltinContractContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly channelPolicy: ChannelPolicyManager;
  readonly buildAccount: (surface: ChannelSurface) => Promise<ChannelAccountRecord>;
  readonly resolveAccount: (surface: ChannelSurface, accountId: string) => Promise<ChannelAccountRecord | null>;
  readonly resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => Promise<ChannelResolvedTarget | null>;
  /**
   * What this node can see of the surface's live path. Optional so an embedder
   * that composes this context by hand still type-checks, an absent observer
   * yields `unknown`, which is the honest answer for a caller that supplied no
   * way to look, and never a green.
   */
  readonly observeRuntime?: ((surface: ChannelSurface) => ChannelRuntimeObservation) | undefined;
}

export function buildBuiltinContractHooks(
  context: BuiltinContractContext,
  surface: ChannelSurface,
): Pick<
  ChannelPlugin,
  | 'setupVersion'
  | 'renderPolicy'
  | 'getSetupSchema'
  | 'doctor'
  | 'listRepairActions'
  | 'getLifecycleState'
  | 'resolveAllowlist'
  | 'editAllowlist'
> {
  return {
    setupVersion: CHANNEL_SETUP_VERSION,
    renderPolicy: () => renderBuiltinPolicy(surface),
    getSetupSchema: () => getBuiltinSetupSchema(surface),
    doctor: (accountId) => getBuiltinDoctorReport(context, surface, accountId),
    listRepairActions: (accountId) => listBuiltinRepairActions(context, surface, accountId),
    getLifecycleState: (accountId) => getBuiltinLifecycleState(context, surface, accountId),
    resolveAllowlist: (input) => resolveBuiltinAllowlist(context, surface, input),
    editAllowlist: (input) => editBuiltinAllowlist(context, surface, input),
  };
}

export async function listBuiltinRepairActions(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<readonly ChannelRepairAction[]> {
  const account = accountId ? await context.resolveAccount(surface, accountId) : await context.buildAccount(surface);
  const actions = (account?.actions ?? []).map((action): ChannelRepairAction => ({
    id: action.kind,
    label: action.label,
    description: `Run the ${action.kind} lifecycle action for ${surfaceLabelForBuiltin(surface)}.`,
    // Stop switches the surface off, so the owner's messages on it go unread.
    dangerous: action.kind === 'disconnect' || action.kind === 'logout' || action.kind === 'stop',
    inputSchema: action.kind === 'disconnect' || action.kind === 'logout'
      ? {
          type: 'object',
          properties: {
            confirm: { type: 'boolean' },
          },
          required: ['confirm'],
        }
      : undefined,
    metadata: { actionId: action.id, available: action.available },
  }));
  if (surface === 'telegram') actions.push({ id: 'cursor-migration-preview', label: 'Review previous Telegram cursor',
    description: 'Open Settings → Surfaces → Telegram cursor recovery, or /channels telegram-cursor in an owner terminal. Verify the bot before preserving the saved position.',
    dangerous: false, metadata: { actionId: 'cursor-migration-preview' } });
  return actions;
}

export async function getBuiltinDoctorReport(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<ChannelDoctorReport> {
  const account = accountId ? await context.resolveAccount(surface, accountId) : await context.buildAccount(surface);
  const effectiveAccount = account ?? await context.buildAccount(surface);
  const requestedAccountMissing = accountId !== undefined && account === null;
  const lifecycle = await getBuiltinLifecycleState(context, surface, accountId);
  const checks: ChannelDoctorCheck[] = [];
  const pushCheck = (id: string, label: string, status: ChannelDoctorStatus, detail: string, repairActionId?: string) => {
    checks.push({ id, label, status, detail, ...(repairActionId ? { repairActionId } : {}), metadata: {} });
  };

  if (requestedAccountMissing) {
    // The checks below describe the surface's default account, not the one asked
    // for; say so instead of echoing the requested id over another account's state.
    pushCheck(
      'account-found',
      'Requested account exists',
      'fail',
      `No account '${accountId}' exists on this surface; the checks below describe the surface's default account.`,
    );
  }
  pushCheck(
    'configured',
    'Configuration present',
    effectiveAccount.configured ? 'pass' : 'fail',
    effectiveAccount.configured
      ? 'Surface configuration or account identity is present.'
      : 'No durable configuration is present for this surface.',
    effectiveAccount.configured ? undefined : 'setup',
  );
  // The credentials checked are the ones the setup schema says this surface
  // needs to SEND (builtinSendCredentials), not "any secret": a signing secret
  // alone cannot send, and ntfy on a public topic needs nothing at all.
  const credentials = builtinCredentialFacts(effectiveAccount);
  const needsNone = builtinSendCredentials(surface, { provider: effectiveAccount.metadata['provider'], mode: effectiveAccount.metadata['mode'] }).length === 0;
  pushCheck(
    'credentials',
    'Credentials needed to send',
    credentials.declared ? 'pass' : effectiveAccount.configured ? 'warn' : 'fail',
    credentials.declared
      ? needsNone ? 'This surface sends without a credential.' : 'The credentials this surface needs to send are declared.'
      : effectiveAccount.configured
        ? 'Configuration exists but the credentials this surface needs to send are not declared.'
        : 'No credentials were detected.',
    credentials.declared ? undefined : 'setup',
  );
  // Declared is not resolved. A `goodvibes://secrets/...` reference naming a
  // key that lives in ANOTHER surface's store passes every check above this one
  // and sends nothing, the exact configuration that made a Telegram bot answer
  // "Missing Telegram bot token" while its reported health read fine.
  const unresolvedSecrets = credentials.unresolved;
  if (unresolvedSecrets.length > 0) {
    pushCheck(
      'credentials-resolve',
      'Credentials resolve here',
      'fail',
      `${unresolvedSecrets.map((secret) => secret.label).join(', ')} names a secret that does not resolve in the store `
      + 'this process reads. Put the secret in this surface\'s store, or point the setting at one that resolves here.',
      'setup',
    );
  }
  pushCheck(
    'enabled',
    'Surface enabled',
    effectiveAccount.enabled ? 'pass' : 'warn',
    effectiveAccount.enabled
      ? 'Surface delivery is enabled for the current runtime.'
      : 'Surface delivery is disabled until it is enabled in config or env.',
    effectiveAccount.enabled ? undefined : 'start',
  );
  // Setup and a passing retest record the setup version they completed. A
  // surface configured directly in its settings has recorded none, which is not
  // a fault; one set up for an older version is told to review the new fields.
  if (effectiveAccount.configured) {
    const stale = lifecycle.currentVersion > 0 && lifecycle.currentVersion < lifecycle.targetVersion;
    pushCheck(
      'lifecycle',
      'Setup version',
      stale ? 'warn' : 'pass',
      stale
        ? `Setup was completed for version ${lifecycle.currentVersion}; version ${lifecycle.targetVersion} has settings to review. Run setup again.`
        : lifecycle.currentVersion >= lifecycle.targetVersion
          ? `Setup completed for version ${lifecycle.currentVersion}.`
          : 'Configured directly in settings; retest confirms the credentials with the provider.',
      stale ? 'setup' : undefined,
    );
  }
  const secretResolves = (field: string): boolean => {
    const secret = effectiveAccount.secrets.find((entry) => entry.field === field);
    return secret !== undefined && (secret.resolved ?? secret.configured);
  };

  const surfaces = context.deps.configManager.getCategory('surfaces');
  if (surface === 'telegram' && !surfaces.telegram.defaultChatId) {
    pushCheck('default-target', 'Default chat id', 'warn', 'No default Telegram chat id is configured; direct delivery requires a chat id or route binding.', 'setup');
  }
  if (surface === 'google-chat' && !surfaces.googleChat.webhookUrl && !surfaces.googleChat.spaceId) {
    pushCheck('space-routing', 'Space routing', 'warn', 'Google Chat has neither a webhook URL nor a default space id configured.', 'setup');
  }
  if (surface === 'signal' && !surfaces.signal.bridgeUrl) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'Signal requires a bridge URL.', 'setup');
  }
  if (surface === 'whatsapp' && surfaces.whatsapp.provider === 'bridge' && !surfaces.whatsapp.bridgeUrl
    && !context.deps.serviceRegistry.get('whatsapp')?.baseUrl && !process.env.WHATSAPP_BRIDGE_URL) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'WhatsApp bridge mode requires a bridge URL (surfaces.whatsapp.bridgeUrl).', 'setup');
  }
  if (surface === 'whatsapp' && !surfaces.whatsapp.phoneNumberId && surfaces.whatsapp.provider === 'meta-cloud') {
    pushCheck('provider-shape', 'Provider metadata', 'warn', 'Meta Cloud mode works best with a phone number id configured.', 'setup');
  }
  // Delivery goes through the bridge when either the provider or the delivery mode says so (strategies-bridge.ts).
  const telephonyUsesBridge = surfaces.telephony.provider === 'bridge' || surfaces.telephony.mode === 'bridge';
  if (surface === 'telephony' && telephonyUsesBridge && !surfaces.telephony.bridgeUrl) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'Bridge mode requires a telephony bridge URL.', 'setup');
  }
  if (surface === 'telephony' && !telephonyUsesBridge && surfaces.telephony.provider === 'twilio'
    && (!secretResolves('accountSid') || !secretResolves('authToken') || !(surfaces.telephony.fromNumber || process.env.TWILIO_FROM_NUMBER || process.env.TELEPHONY_FROM_NUMBER))) {
    pushCheck('twilio-credentials', 'Twilio credentials', 'fail', 'Direct provider mode requires account SID, auth token, and a sender/caller number.', 'setup');
  }
  if (surface === 'telephony' && !surfaces.telephony.defaultRecipient) {
    pushCheck('default-recipient', 'Default recipient', 'warn', 'No default phone recipient is configured; proactive delivery requires a route binding or explicit target.', 'setup');
  }
  if (surface === 'imessage' && !surfaces.imessage.bridgeUrl) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'iMessage requires a bridge URL or local companion endpoint.', 'setup');
  }
  if (surface === 'msteams' && !surfaces.msteams.appId) {
    pushCheck('app-id', 'App id', 'fail', 'Microsoft Teams requires an app id.', 'setup');
  }
  if (surface === 'msteams' && !surfaces.msteams.serviceUrl && !surfaces.msteams.defaultConversationId) {
    pushCheck('conversation-routing', 'Conversation routing', 'warn', 'Teams will deliver best after an inbound conversation reference has been captured or a default conversation id is configured.', 'setup');
  }
  if (surface === 'bluebubbles' && !surfaces.bluebubbles.serverUrl) {
    pushCheck('server-url', 'Server URL', 'fail', 'BlueBubbles requires a server URL.', 'setup');
  }
  if (surface === 'mattermost' && !surfaces.mattermost.baseUrl) {
    pushCheck('base-url', 'Base URL', 'fail', 'Mattermost requires a base URL.', 'setup');
  }
  if (surface === 'mattermost' && !surfaces.mattermost.defaultChannelId) {
    pushCheck('default-channel', 'Default channel', 'warn', 'No default Mattermost channel id is configured; proactive delivery will require route bindings.', 'setup');
  }
  if (surface === 'matrix' && !surfaces.matrix.homeserverUrl) {
    pushCheck('homeserver-url', 'Homeserver URL', 'fail', 'Matrix requires a homeserver URL.', 'setup');
  }
  // The Home Assistant credentials are read from the account, which resolves the
  // setting, the services file and the environment the same way ingress does.
  if (surface === 'homeassistant' && !secretResolves('signingSecret')) {
    pushCheck('webhook-secret', 'Webhook secret', 'fail', 'Home Assistant ingress requires a webhook secret because webhook routes are evaluated before daemon bearer auth.', 'setup');
  }
  if (surface === 'homeassistant' && !surfaces.homeassistant.instanceUrl) {
    pushCheck('instance-url', 'Instance URL', 'warn', 'Home Assistant REST-backed tools require an instance URL; daemon-only prompt ingress can work without one.', 'setup');
  }
  if (surface === 'homeassistant' && !secretResolves('primary')) {
    pushCheck('access-token', 'Long-lived access token', 'warn', 'Home Assistant state, service, template, and event-delivery tools require an access token.', 'setup');
  }

  // The credential the surface's inbound webhook checks callers against, read
  // from the same source list the webhook reads. A warning, not a failure:
  // Slack Socket Mode needs none, and a surface used only to send has no
  // webhook to protect.
  if (Object.hasOwn(INBOUND_CREDENTIAL_SOURCES, surface)) {
    const inbound = await resolveInboundCredential(context.deps, surface as InboundCredentialSurface);
    if (inbound.state === 'absent') {
      pushCheck('inbound-credential', 'Inbound webhook credential', 'warn',
        `Inbound messages are refused until ${inbound.setting} is set.`, 'setup');
    } else if (inbound.state === 'unresolvable') {
      pushCheck('inbound-credential', 'Inbound webhook credential', 'warn',
        `Inbound messages are refused: ${inbound.configKey} names a secret that does not resolve in the store this process reads.`, 'setup');
    } else {
      pushCheck('inbound-credential', 'Inbound webhook credential', 'pass', 'The inbound webhook has a credential to verify callers.');
    }
  }

  // The live path, as its own check and as the basis for the reported state.
  // Every check above this line reads configuration; a doctor that stops there
  // pronounces a surface healthy on the strength of a token being present,
  // which is exactly how a dead Telegram bot passed its own examination.
  const runtime = context.observeRuntime?.(surface)
    ?? unobservableRuntime('no runtime observer was supplied to this doctor, so liveness was not checked');
  pushCheck(
    'runtime',
    'Receiving and sending now',
    !runtime.observable || runtime.running === null ? 'warn' : runtime.running ? 'pass' : 'fail',
    runtime.reason,
    runtime.observable && runtime.running === false ? 'start' : undefined,
  );

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const summary = failures > 0
    ? `${failures} failing checks and ${warnings} warnings.`
    : warnings > 0
      ? `${warnings} warnings; no failing checks.`
      : 'All checks passed.';

  return {
    surface,
    ...(accountId ? { accountId } : {}),
    // The same rule the status snapshot and the account record read.
    state: builtinHealthState(effectiveAccount, effectiveAccount.enabled, runtime).state,
    runtime,
    summary,
    checkedAt: Date.now(),
    checks,
    repairActions: await listBuiltinRepairActions(context, surface, accountId),
    metadata: {
      accountId: effectiveAccount.accountId ?? effectiveAccount.id,
      ...(requestedAccountMissing ? { requestedAccountFound: false } : {}),
    },
  };
}

export async function getBuiltinLifecycleState(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<ChannelLifecycleState> {
  const currentVersion = getConfiguredSetupVersion(context, surface);
  return {
    surface,
    ...(accountId ? { accountId } : {}),
    currentVersion,
    targetVersion: CHANNEL_SETUP_VERSION,
    metadata: {},
  };
}

/** Input to the built-in allowlist edit: the shared shape plus the lock-out guard's facts. */
export interface BuiltinAllowlistEditInput extends ChannelAllowlistEditInput {
  /** Apply the edit even though it would refuse the caller's own conversation. */
  readonly force?: boolean | undefined;
  /** The caller's own provider user id on this surface, kept admitted unless `force`. */
  readonly callerUserId?: string | undefined;
  /** The caller's own conversation id (group or channel) on this surface. */
  readonly callerConversationId?: string | undefined;
  readonly callerConversationKind?: ChannelConversationKind | undefined;
}

/** The id each surface's allowlist compares, said in the refusal so the caller can supply it. */
function allowlistIdForm(surface: ChannelSurface, kind: ChannelAllowlistTargetKind): string {
  if (kind === 'user') {
    switch (surface) {
      case 'slack': return 'Slack member id (U0123ABCD)';
      case 'discord': return 'Discord user id (a number)';
      case 'telegram': return 'Telegram user id (a number)';
      case 'matrix': return 'Matrix user id (@name:server)';
      case 'signal': case 'whatsapp': case 'telephony': case 'imessage': case 'bluebubbles': return 'phone number or handle the bridge reports';
      default: return `${surface} user id`;
    }
  }
  switch (surface) {
    case 'slack': return 'Slack conversation id (C0123ABCD)';
    case 'discord': return 'Discord channel id (a number)';
    case 'telegram': return 'Telegram chat id (a number)';
    case 'matrix': return 'Matrix room id (!room:server)';
    default: return `${surface} ${kind} id`;
  }
}

const TYPED_ID = /^(user|direct|dm|channel|group):(.+)$/i;

function typedIdKind(prefix: string): ChannelAllowlistTargetKind {
  const lower = prefix.toLowerCase();
  if (lower === 'user' || lower === 'direct' || lower === 'dm') return 'user';
  return lower === 'channel' ? 'channel' : 'group';
}

function directoryScopeFor(kind: ChannelAllowlistTargetKind): ChannelDirectoryScope {
  return kind === 'user' ? 'users' : kind === 'channel' ? 'channels' : 'groups';
}

/** The provider id an exact directory match stands for, or null when the entry is not of the kind asked. */
function allowlistIdFromEntry(kind: ChannelAllowlistTargetKind, entry: ChannelDirectoryEntry): string | null {
  if (kind === 'user') {
    if (entry.kind !== 'user' && entry.kind !== 'member' && entry.kind !== 'self') return null;
    // A route entry's id is the binding's, not the person's; only provider and member entries name a person.
    return typeof entry.metadata['externalId'] === 'string' ? null : entry.id;
  }
  if (entry.kind === 'user' || entry.kind === 'member' || entry.kind === 'self' || entry.kind === 'service') return null;
  return entry.groupId ?? entry.id;
}

function entryNamedBy(entry: ChannelDirectoryEntry, needle: string): boolean {
  return [entry.id, entry.handle, entry.label, entry.groupId, ...(entry.aliases ?? [])]
    .some((value) => typeof value === 'string' && value.replace(/^[@#]/, '').toLowerCase() === needle);
}

/**
 * Turn allowlist candidates into the provider ids ingress compares.
 *
 * A candidate resolves when it is written as a typed id (`user:U123`,
 * `channel:C123`) or names exactly one directory entry of the asked kind; the
 * live provider directory is searched, so a person's name or handle becomes
 * their provider id. Anything else is `unresolved`: a name stored as typed
 * matches no sender and, once the list is non-empty, refuses everyone else.
 */
export async function resolveBuiltinAllowlist(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  input: ChannelAllowlistEditInput,
): Promise<ChannelAllowlistResolution> {
  const requested = [...(input.add ?? []), ...(input.remove ?? [])];
  const resolved: ChannelAllowlistTarget[] = [];
  const unresolved: string[] = [];
  const reasons: Record<string, string> = {};
  const seen = new Set<string>();
  for (const rawInput of requested) {
    const candidate = rawInput.trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const typed = candidate.replace(new RegExp(`^${surface}:`, 'i'), '').match(TYPED_ID);
    if (typed) {
      const typedKind = typedIdKind(typed[1] ?? '');
      const id = (typed[2] ?? '').trim();
      if (!id || (input.kind && input.kind !== typedKind)) {
        unresolved.push(candidate);
        reasons[candidate] = `it is written as a ${typedKind} id but the edit is for kind ${input.kind}`;
        continue;
      }
      resolved.push({ kind: typedKind, input: candidate, id, label: id, metadata: { source: 'typed-id' } });
      continue;
    }
    const kind = input.kind;
    if (!kind) {
      unresolved.push(candidate);
      reasons[candidate] = 'no kind was given, so it is not known whether it names a person or a conversation';
      continue;
    }
    const needle = candidate.replace(/^[@#]/, '').toLowerCase();
    let entries: readonly ChannelDirectoryEntry[] = [];
    try {
      entries = await context.deps.channelPlugins.queryDirectory(surface, { query: needle, scope: directoryScopeFor(kind), limit: 20, live: true });
    } catch (error) {
      unresolved.push(candidate);
      reasons[candidate] = `the ${surface} directory could not be read (${error instanceof Error ? error.message : String(error)})`;
      continue;
    }
    const matches = entries
      .filter((entry) => entryNamedBy(entry, needle))
      .map((entry) => ({ entry, id: allowlistIdFromEntry(kind, entry) }))
      .filter((match): match is { entry: ChannelDirectoryEntry; id: string } => match.id !== null);
    const ids = new Set(matches.map((match) => match.id));
    if (ids.size !== 1) {
      unresolved.push(candidate);
      reasons[candidate] = ids.size === 0 ? `no ${kind} on ${surface} is named that` : `it names ${ids.size} different ${kind}s`;
      continue;
    }
    const match = matches[0]!;
    resolved.push({ kind, input: candidate, id: match.id, label: match.entry.label, metadata: { source: 'directory', directoryEntryId: match.entry.id } });
  }
  return {
    surface,
    resolved,
    unresolved,
    metadata: Object.keys(reasons).length > 0 ? { reasons } : {},
  };
}

/**
 * The stored allowlist entry a removal candidate names: a typed id (`user:U1`)
 * or a bare id of the edit's kind that is already on that list.
 */
function storedAllowlistMatch(
  surface: ChannelSurface,
  candidate: string,
  kind: ChannelAllowlistTargetKind | undefined,
  storedList: (kind: ChannelAllowlistTargetKind) => readonly string[],
): ChannelAllowlistTarget | undefined {
  const bare = candidate.replace(new RegExp(`^${surface}:`, 'i'), '');
  const typed = bare.match(TYPED_ID);
  const entryKind = typed ? typedIdKind(typed[1] ?? '') : kind;
  if (!entryKind || (typed && kind && kind !== entryKind)) return undefined;
  const raw = (typed ? typed[2] ?? '' : bare).trim();
  const list = storedList(entryKind);
  const id = [raw, raw.replace(/^[@#]/, '')].find((value) => value.length > 0 && list.includes(value));
  return id === undefined ? undefined : { kind: entryKind, input: candidate, id, label: id, metadata: { source: 'stored-allowlist' } };
}

function refuseAllowlistEdit(code: string, reason: string, next: readonly string[]): never {
  throw new RefusalError(refusal({ code, state: 'the allowlist was not changed', reason, next, status: 409 }));
}

/**
 * Edit a surface's allowlists. The edit names its kind, every added entry must
 * resolve to a provider id, and an edit that would refuse the caller's own
 * conversation is refused unless `force` is set; each refusal changes nothing
 * and says what to pass instead.
 */
export async function editBuiltinAllowlist(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  input: BuiltinAllowlistEditInput,
): Promise<ChannelAllowlistEditResult> {
  await context.channelPolicy.start();
  const addInputs = new Set((input.add ?? []).map((value) => value.trim()).filter(Boolean));
  const removeInputs = new Set((input.remove ?? []).map((value) => value.trim()).filter(Boolean));
  const typedOnly = [...addInputs, ...removeInputs].every((value) => TYPED_ID.test(value.replace(new RegExp(`^${surface}:`, 'i'), '')));
  if (!input.kind && !typedOnly) {
    refuseAllowlistEdit('CHANNEL_ALLOWLIST_KIND_REQUIRED', 'An allowlist edit must say whether it lists people or conversations.',
      ['Pass kind: user, channel or group, or write each entry as user:<id>, channel:<id> or group:<id>.']);
  }
  const existing = context.channelPolicy.getPolicy(surface);
  const scoped = Boolean(input.groupId || input.channelId || input.workspaceId);
  // The group is the one matching EVERY scope field given: matching on any one
  // of them would let an edit scoped to (group A, workspace W) rewrite another
  // group's policy that merely shares W.
  const match = scoped
    ? existing.groupPolicies.find((entry) => (
      (!input.groupId || entry.groupId === input.groupId)
      && (!input.channelId || entry.channelId === input.channelId)
      && (!input.workspaceId || entry.workspaceId === input.workspaceId)
    ))
    : undefined;
  const before: ChannelAllowlists = scoped
    ? { allowlistUserIds: match?.allowlistUserIds ?? [], allowlistChannelIds: match?.allowlistChannelIds ?? [], allowlistGroupIds: match?.allowlistGroupIds ?? [] }
    : existing;
  const storedList = (kind: ChannelAllowlistTargetKind) => kind === 'user' ? before.allowlistUserIds
    : kind === 'channel' ? before.allowlistChannelIds : before.allowlistGroupIds;

  // A removal names someone already listed, so it is matched against the stored
  // ids first: a person who left, or a surface with no provider directory, can
  // still be removed by the id that admits them. Only the rest ask the directory.
  const storedRemovals: ChannelAllowlistTarget[] = [];
  for (const candidate of removeInputs) {
    if (addInputs.has(candidate)) continue;
    const stored = storedAllowlistMatch(surface, candidate, input.kind, storedList);
    if (stored) storedRemovals.push(stored);
  }
  const storedInputs = new Set(storedRemovals.map((entry) => entry.input));
  const lookedUp = await resolveBuiltinAllowlist(context, surface, { ...input, remove: [...removeInputs].filter((value) => !storedInputs.has(value)) });
  const resolution: ChannelAllowlistResolution = { ...lookedUp, resolved: [...lookedUp.resolved, ...storedRemovals] };
  const reasons = (resolution.metadata['reasons'] ?? {}) as Record<string, string>;
  const unresolvedAdds = resolution.unresolved.filter((value) => addInputs.has(value));
  if (unresolvedAdds.length > 0) {
    const kind = input.kind ?? 'user';
    refuseAllowlistEdit('CHANNEL_ALLOWLIST_UNRESOLVED',
      `These entries do not resolve to a ${surface} id: ${unresolvedAdds.map((value) => `'${value}'${reasons[value] ? ` (${reasons[value]})` : ''}`).join(', ')}.`,
      [`Pass the ${allowlistIdForm(surface, kind)} as ${kind}:<id>, or check the name with the resolve-allowlist action.`]);
  }
  const added = resolution.resolved.filter((entry) => addInputs.has(entry.input));
  const removed = resolution.resolved.filter((entry) => removeInputs.has(entry.input));
  // A removal that takes nobody off the list would leave the person admitted
  // behind a success answer; it is refused and nothing changes.
  const missingRemovals = [...removeInputs].filter((value) => !addInputs.has(value)
    && !removed.some((entry) => entry.input === value && storedList(entry.kind).includes(entry.id)));
  if (missingRemovals.length > 0) {
    const kind = input.kind ?? 'user';
    refuseAllowlistEdit('CHANNEL_ALLOWLIST_UNRESOLVED',
      `These entries match nobody on the ${scoped ? 'scoped ' : ''}${surface} allowlist: ${missingRemovals.map((value) => `'${value}'${reasons[value] ? ` (${reasons[value]})` : ''}`).join(', ')}.`,
      [`Pass the stored ${allowlistIdForm(surface, kind)} as ${kind}:<id>; the surface policy lists the ids it holds.`]);
  }
  const ids = (entries: readonly ChannelAllowlistTarget[], kind: ChannelAllowlistTargetKind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
  const nextLists = (current: ChannelAllowlists) => ({
    allowlistUserIds: applyAllowlistChanges(current.allowlistUserIds, ids(added, 'user'), ids(removed, 'user')),
    allowlistChannelIds: applyAllowlistChanges(current.allowlistChannelIds, ids(added, 'channel'), ids(removed, 'channel')),
    allowlistGroupIds: applyAllowlistChanges(current.allowlistGroupIds, ids(added, 'group'), ids(removed, 'group')),
  });
  const after = nextLists(before);
  if (input.force !== true) assertCallerStaysAdmitted(surface, input, before, after);

  if (scoped) {
    const scopeKey = [input.groupId, input.channelId, input.workspaceId].filter(Boolean).join(':') || 'scope';
    const nextGroup = {
      id: match?.id ?? `allowlist:${surface}:${scopeKey}`,
      ...(match?.label ? { label: match.label } : {}),
      ...(input.groupId ? { groupId: input.groupId } : match?.groupId ? { groupId: match.groupId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : match?.channelId ? { channelId: match.channelId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : match?.workspaceId ? { workspaceId: match.workspaceId } : {}),
      ...after,
      metadata: match?.metadata ?? {},
    };
    const updated = await context.channelPolicy.upsertPolicy(surface, {
      groupPolicies: [
        ...existing.groupPolicies.filter((entry) => entry.id !== nextGroup.id),
        nextGroup,
      ],
    });
    return { surface, updatedPolicy: updated, resolution, metadata: { scoped: true, groupPolicyId: nextGroup.id, rule: ALLOWLIST_RULE } };
  }

  const updated = await context.channelPolicy.upsertPolicy(surface, after);
  return { surface, updatedPolicy: updated, resolution, metadata: { scoped: false, rule: ALLOWLIST_RULE } };
}

/** The rule the edited lists are applied by (admitByAllowlists), stated in every edit result. */
const ALLOWLIST_RULE = 'Every list that is set must admit a message; empty lists restrict nobody. A group, channel or thread must be on the '
  + 'group list and the channel list when each is set, and its sender on the user list when it is set. A direct conversation is judged by '
  + 'the user list when it is set; with only group or channel lists set, only the owner (or a listed chat) is admitted directly.';

/**
 * Refuse an edit that would shut out the caller: their own conversation when
 * they named it, and otherwise the first restriction of an empty user list,
 * which admits only the listed ids from then on and so refuses whoever owns
 * the surface unless they are among them.
 */
function assertCallerStaysAdmitted(
  surface: ChannelSurface,
  input: BuiltinAllowlistEditInput,
  before: ChannelAllowlists,
  after: ChannelAllowlists,
): void {
  if (input.callerUserId || input.callerConversationId) {
    const kind = input.callerConversationKind ?? (input.callerConversationId ? 'group' : 'direct');
    const subject = {
      conversationKind: kind,
      userId: input.callerUserId,
      groupId: input.callerConversationId,
      channelId: input.callerConversationId,
    };
    const was = admitByAllowlists(before, subject);
    const now = admitByAllowlists(after, subject);
    if (was.allowed && !now.allowed) {
      refuseAllowlistEdit('CHANNEL_ALLOWLIST_LOCKOUT',
        `This edit would refuse your own ${surface} conversation (${now.reason}).`,
        ['Add your own id in the same edit, or pass force: true to apply it anyway.']);
    }
    return;
  }
  if (before.allowlistUserIds.length === 0 && after.allowlistUserIds.length > 0) {
    refuseAllowlistEdit('CHANNEL_ALLOWLIST_LOCKOUT',
      `The ${surface} user list is empty, so this edit would admit only ${after.allowlistUserIds.join(', ')} from now on and refuse every other sender, including the owner unless listed.`,
      ['Pass callerUserId with your own id so the edit keeps you admitted, add your own id in the same edit, or pass force: true.']);
  }
}

function getConfiguredSetupVersion(context: BuiltinContractContext, surface: ChannelSurface): number {
  if (surface === 'tui' || surface === 'web') return CHANNEL_SETUP_VERSION;
  const section = configSectionForSurface(surface);
  const surfaces = context.deps.configManager.getCategory('surfaces');
  return Number(surfaces[section].setupVersion ?? 0);
}

function applyAllowlistChanges(existing: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const next = new Set(existing);
  for (const value of add) {
    if (value.trim()) next.add(value.trim());
  }
  for (const value of remove) {
    if (value.trim()) next.delete(value.trim());
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}
