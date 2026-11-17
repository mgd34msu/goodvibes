/** Explicit Discord account/DM scope over the canonical source and registration owners. */
import { realpath } from 'node:fs/promises';
import { createInboxRouteResolver } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import { acquireDiscordInboxIdentity, resolveDiscordInboxElectionScope, acquireDiscordInboxRegistryRevision, createDiscordInboxOwner, createOwnedTriagedInboxSource,
  type DiscordInboxOwnerOptions, type VerifiedDiscordInboxOwner, type OwnedInboxSource, type InboxTriageAuthority,
} from '@goodvibes-jev/engine/platform/platform/intake';
import { createMultiOwnerDaemonInboxFactory, type DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import { attachDaemonInboxTagging, type DaemonTriageTaggingActivation } from './tagged-inbox-composition.js';
import { ownAccountInboxStore } from './account-inbox-store.js';
import { atInboxBuildStage, type InboxBuildStage } from './inbox-admission-refusal.js';

export interface DiscordDaemonInboxOptions extends Pick<DiscordInboxOwnerOptions, 'account' | 'channels' | 'screening' | 'timeoutMs'> {
  /** Separately established semantic destination/account grant, never inferred from screening. */
  readonly triageAuthority?: InboxTriageAuthority;
  readonly triageTagging?: DaemonTriageTaggingActivation & {
    /** Exact constructor-owned custom label to forum-tag mapping. */
    readonly forumTagIds?: Readonly<Record<string, string>>;
  };
}
export interface DiscordDaemonInboxSourceFactories {
  readonly createOwner?: typeof createDiscordInboxOwner;
  readonly eligibilityClock?: ClusterClock;
}
export function createDiscordDaemonInboxFactory(options: DiscordDaemonInboxOptions,
  factories: DiscordDaemonInboxSourceFactories = {}) {
  return createMultiOwnerDaemonInboxFactory([createDiscordDaemonInboxSourceFactory(options, factories)]);
}

/** The configured Discord inbox account: the bot user and its one-to-one DM channels. */
export interface ConfiguredDiscordInboxAccount {
  readonly userId: string;
  readonly channelIds: readonly string[];
}

const snowflake = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < (1n << 64n);

/**
 * The one parser of the configured Discord inbox account. Returns why it is
 * incomplete instead of the account; the caller decides how to refuse.
 */
export function parseConfiguredDiscordInboxAccount(config: { get(key: string): unknown }):
  { readonly account: ConfiguredDiscordInboxAccount } | { readonly incomplete: string } {
  const userId = config.get('surfaces.discord.inboxBotUserId');
  const registry = config.get('surfaces.discord.inboxChannelIds');
  if (!snowflake(userId) || typeof registry !== 'string' || registry.length > 4_300) {
    return { incomplete: 'Discord inbox requires its expected bot and one-to-one DM registry' };
  }
  const channelIds = registry.split(',').map(value => value.trim());
  if (channelIds.length < 1 || channelIds.length > 200 || channelIds.some(id => !snowflake(id))
    || new Set(channelIds).size !== channelIds.length) {
    return { incomplete: 'Discord inbox requires 1–200 unique canonical one-to-one DM channel IDs' };
  }
  return { account: Object.freeze({ userId, channelIds: Object.freeze(channelIds) }) };
}

/**
 * Operator-selected bot identity and DM registry; the host separately owns both
 * screening services. With `selected`, the account was parsed once by the
 * configured-account selector and its lifetime (aborted by that selector's
 * setting and credential subscriptions) is the only currentness check here.
 */
export function createConfiguredDiscordDaemonInboxSourceFactory(
  screening: DiscordDaemonInboxOptions['screening'],
  factories: DiscordDaemonInboxSourceFactories = {},
  selected?: {
    readonly account: ConfiguredDiscordInboxAccount;
    readonly operation: { readonly signal: AbortSignal; assertCurrent(): void };
    /** Triage asks on the route screening was admitted on, like Slack and email. */
    readonly triageAuthority?: InboxTriageAuthority | undefined;
    /** Label write-back for this account, as Slack and email receive it. */
    readonly triageTagging?: DiscordDaemonInboxOptions['triageTagging'] | undefined;
  },
): DaemonInboxSourceFactory {
  return async (context, routing, controls) => {
    const config = context.configManager;
    const keys = ['surfaces.discord.inboxBotUserId', 'surfaces.discord.inboxChannelIds'] as const;
    let account: ConfiguredDiscordInboxAccount;
    if (selected) account = selected.account;
    else {
      const parsed = parseConfiguredDiscordInboxAccount(config);
      if ('incomplete' in parsed) throw new Error(parsed.incomplete);
      account = parsed.account;
    }
    const { userId, channelIds } = account;
    const registryAtStart = selected ? undefined : config.get(keys[1]);
    const lifetime = new AbortController();
    const unsubscribe: Array<() => void> = [];
    let source: OwnedInboxSource | undefined;
    let closing: Promise<void> | undefined;
    const signal = selected ? AbortSignal.any([lifetime.signal, selected.operation.signal]) : lifetime.signal;
    const current = selected
      ? (): void => { lifetime.signal.throwIfAborted(); selected.operation.assertCurrent(); }
      : (): void => {
        if (lifetime.signal.aborted || config.get(keys[0]) !== userId || config.get(keys[1]) !== registryAtStart) {
          throw new Error('Discord inbox configured account or DM registry changed');
        }
      };
    const close = (): Promise<void> => {
      if (!closing) {
        lifetime.abort();
        closing = Promise.resolve().then(async () => {
          const results = await Promise.allSettled([
            ...unsubscribe.map(release => Promise.resolve().then(release)),
            Promise.resolve().then(() => source?.close()),
          ]);
          if (results.some(result => result.status === 'rejected')) throw new Error('Configured Discord inbox did not close cleanly');
        });
      }
      return closing;
    };
    try {
      if (!selected) {
        if (!controls.onConfigurationChange) throw new Error('Discord inbox requires its native configuration subscription owner');
        for (const key of keys) unsubscribe.push(controls.onConfigurationChange(key, () => lifetime.abort()));
      }
      current();
      const workingDirectory = await realpath(context.workingDirectory); current();
      const revision = await acquireDiscordInboxRegistryRevision({ workingDirectory, assertCurrent: current, beforeWrite: controls.beforeDiscordIdentityWrite }, { userId }, [...channelIds]); current();
      source = await createDiscordDaemonInboxSourceFactory({
        account: { userId },
        channels: { channelIds: [...channelIds], signal, assertCurrent: current, revision },
        screening,
        ...(selected?.triageAuthority ? { triageAuthority: selected.triageAuthority } : {}),
        ...(selected?.triageTagging ? { triageTagging: selected.triageTagging } : {}),
      }, factories, true, selected !== undefined)(context, routing, controls);
      current();
      return { ...source, close, unregister() { void close().catch(() => {}); } };
    } catch (error) { await close(); throw error; }
  };
}
export function createDiscordDaemonInboxSourceFactory(options: DiscordDaemonInboxOptions,
  factories: DiscordDaemonInboxSourceFactories = {}, configuredRegistry = false, selectedLifetime = false): DaemonInboxSourceFactory {
  const createOwner = factories.createOwner ?? createDiscordInboxOwner;
  const authority = options.triageAuthority;
  const triageTagging = options.triageTagging ? Object.freeze({ onReady: options.triageTagging.onReady,
    ...(options.triageTagging.forumTagIds ? { forumTagIds: Object.freeze({ ...options.triageTagging.forumTagIds }) } : {}),
  }) : undefined;
  if (triageTagging && typeof triageTagging.onReady !== 'function') throw new Error('Discord tagging requires an explicit owner callback');
  return async (context, routing, controls) => {
    if (triageTagging && !controls.createTriageTagging) throw new Error('Discord tagging requires the canonical permission owner');
    if (!controls.onAccountInvalidation) throw new Error('Discord inbox requires account and configuration invalidation');
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered Discord inbox requires owned gate retirement');
    const keys = ['surfaces.discord.enabled', 'surfaces.discord.applicationId', 'surfaces.discord.guildId', 'surfaces.discord.defaultChannelId',
      'surfaces.discord.inboxBotUserId', 'surfaces.discord.inboxChannelIds'] as const;
    const settings = keys.map(key => context.configManager.get(key));
    if (settings[0] !== true) throw new Error('Discord inbox composition requires Discord to be enabled');
    let generation = 0, closed = false;
    let owner: VerifiedDiscordInboxOwner | undefined;
    // Subscribe before the first await, including owner and storage construction.
    const unsubscribe = controls.onAccountInvalidation(() => { generation++; owner?.invalidateCredential(); });
    const startupGeneration = generation;
    // A selected account's lifetime is aborted by the selector's own setting and
    // credential subscriptions; nothing here re-reads what they already watch.
    const current = selectedLifetime
      ? (): void => { if (closed) throw new Error('Discord inbox configuration scope changed'); options.channels.assertCurrent(); }
      : (): void => {
        const quarantine = context.configManager.getIngestionQuarantine?.();
        if (closed || !quarantine || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
          || entry.key === 'surfaces.discord' || entry.key.startsWith('surfaces.discord.'))
          || (context.configManager.get('cluster.enabled') === true) !== clustered
          || keys.some((key, i) => context.configManager.get(key) !== settings[i])) {
          throw new Error('Discord inbox configuration scope changed');
        }
      };
    const startupCurrent = () => { current(); if (generation !== startupGeneration) throw new Error('Discord inbox startup was revoked'); };
    let workingDirectory: string;
    let identity: Awaited<ReturnType<typeof acquireDiscordInboxIdentity>>;
    let stage: InboxBuildStage = 'identity';
    try {
      startupCurrent();
      workingDirectory = await realpath(context.workingDirectory); startupCurrent();
      const resolveProfileId = routing.resolveProfileId.bind(routing);
      const resolveRouteId = createInboxRouteResolver({ getProfileForChannel: resolveProfileId, resolveProfile: resolveProfileId });
      identity = await acquireDiscordInboxIdentity({ workingDirectory, assertCurrent: startupCurrent, beforeWrite: controls.beforeDiscordIdentityWrite }, options, { configuredRegistry });
      startupCurrent();
      stage = 'owner';
      owner = await createOwner({ ...context, resolveRouteId }, {
        identity, account: options.account, channels: options.channels, screening: options.screening, assertCurrent: current,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      closed = true;
      try { unsubscribe(); } catch { /* The acquisition failure is the error reported. */ }
      await Promise.allSettled([owner?.close()]);
      throw atInboxBuildStage('discord', stage, error);
    }
    const owned = owner, ownedIdentity = identity, ownedDirectory = workingDirectory;
    let result: OwnedInboxSource;
    try {
      result = await ownAccountInboxStore({
        provider: 'discord', controls, workingDirectory: ownedDirectory, clustered, owner: owned, assertCurrent: startupCurrent,
        ...(factories.eligibilityClock ? { eligibilityClock: factories.eligibilityClock } : {}),
        prepare: startupCurrent,
        electionScope: () => clustered ? resolveDiscordInboxElectionScope(ownedIdentity) : owned.scopeId,
        register: store => createOwnedTriagedInboxSource({ ...context, workingDirectory: ownedDirectory }, {
          beforeSourceRevisionWrite: controls.beforeSourceRevisionWrite, beforeReceiptWrite: controls.beforeInboxTriageReceiptWrite,
          providerId: 'discord', accountScopeId: owned.scopeId, ...(authority ? { authority } : {}),
          adapters: new Map([['discord', owned.adapter]]), triageStoreFileName: owned.triageStoreFileName,
          acquireReadLease: () => owned.acquireReadLease(), ...store,
        }),
        releaseExtras: () => { closed = true; unsubscribe(); },
      });
    } catch (error) { closed = true; throw error; }
    // Fence new reads synchronously, before asynchronous drainage.
    const drain = result.close;
    result = { ...result, close: () => { closed = true; return drain(); }, unregister() { closed = true; void drain().catch(() => {}); } };
    return triageTagging ? attachDaemonInboxTagging(result, triageTagging, controls, {
      provider: 'discord', accountScopeId: owned.scopeId, assertCurrent: current,
      ...(triageTagging.forumTagIds ? { forumTagIds: triageTagging.forumTagIds } : {}),
    }) : result;
  };
}
