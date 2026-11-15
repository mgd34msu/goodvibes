import { DiscordIntegration, SlackIntegration } from '../../integrations/index.js';
import type {
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelDirectoryScope,
  ChannelResolvedTarget,
  ChannelSurface,
  ChannelTargetResolveOptions,
} from '../types.js';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from './shared.js';
import { resolveSurfaceSecret } from './surface-secrets.js';
import { logger } from '../../utils/logger.js';

/** Provider pages are fetched at a fixed size; `limit` only bounds what is returned. */
const PROVIDER_PAGE_SIZE = 200;
/** A workspace larger than this many pages is searched up to the cap, and the answer is marked truncated. */
const PROVIDER_MAX_PAGES = 10;

const TRUNCATED = Symbol('channel-directory-truncated');

/** Mark a directory answer as cut short by the provider page cap; carried through filters by `keepTruncation`. */
function markTruncated<T extends ChannelDirectoryEntry[]>(entries: T, truncated: boolean): T {
  if (truncated) Object.defineProperty(entries, TRUNCATED, { value: true, enumerable: false });
  return entries;
}

/** True when a directory answer stopped at the provider page cap, so a name past it may exist. */
export function isTruncatedDirectory(entries: readonly unknown[]): boolean {
  return (entries as unknown as { [TRUNCATED]?: boolean })[TRUNCATED] === true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BuiltinTargetContext {
  readonly deps: BuiltinChannelRuntimeDeps;
}


export async function resolveBuiltinTarget(
  context: BuiltinTargetContext,
  surface: ChannelSurface,
  options: ChannelTargetResolveOptions,
): Promise<ChannelResolvedTarget | null> {
  const input = options.input.trim();
  if (!input) return null;
  const explicit = parseBuiltinExplicitTarget(surface, input, options);
  const search = explicit?.to ?? input;
  const scope = scopeForTargetKind(explicit?.kind ?? options.preferredKind);
  // A lookup that could not be answered is not the same as "no such
  // conversation": the target is still returned so a send is not lost, and it
  // carries the reason in its metadata.
  let directoryError: string | undefined;
  let directoryEntries: readonly ChannelDirectoryEntry[] = [];
  try {
    directoryEntries = await context.deps.channelPlugins.queryDirectory(surface, {
      query: search,
      limit: 5,
      ...(scope ? { scope } : {}),
      ...(options.live ? { live: true } : {}),
    });
  } catch (error) {
    directoryError = errorText(error);
    logger.warn('Channel directory lookup failed; the target is not verified against the provider', {
      surface,
      error: directoryError,
    });
  }
  const directoryEntry = pickBestDirectoryEntry(directoryEntries, search);
  if (directoryEntry) {
    return resolveDirectoryEntryTarget(surface, options, directoryEntry, explicit);
  }
  const searchTruncated = isTruncatedDirectory(directoryEntries);
  if (explicit) {
    return directoryError || searchTruncated
      ? { ...explicit, metadata: { ...explicit.metadata, ...(directoryError ? { directoryError } : {}), ...(searchTruncated ? { searchTruncated: true } : {}) } }
      : explicit;
  }

  const kind = inferBuiltinTargetConversationKind(input, options);
  const normalized = input.toLowerCase();
  const target: ChannelResolvedTarget = {
    surface,
    input: options.input,
    normalized,
    kind,
    to: input,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
    source: options.createIfMissing ? 'synthetic' : 'miss',
    metadata: {
      fallback: true,
      createIfMissing: Boolean(options.createIfMissing),
      ...(directoryError ? { directoryError } : {}),
      // Nothing matched within the pages searched; past the cap it may exist.
      ...(searchTruncated ? { searchTruncated: true } : {}),
    },
  };
  return {
    ...target,
    sessionTarget: resolveBuiltinSessionTarget(target),
  };
}

export function parseBuiltinExplicitTarget(
  surface: ChannelSurface,
  input: string,
  options?: ChannelTargetResolveOptions,
): ChannelResolvedTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const surfacePrefix = `${surface}:`;
  if (trimmed.toLowerCase().startsWith(surfacePrefix)) {
    return parseBuiltinExplicitTarget(surface, trimmed.slice(surfacePrefix.length), options);
  }

  const typedMatch = trimmed.match(/^(direct|dm|user|channel|group|thread|service):(.+)$/i);
  const hashMatch = trimmed.match(/^#([^/:]+)(?:[:/](.+))?$/);
  const atMatch = trimmed.match(/^@(.+)$/);
  const urlMatch = trimmed.match(/^https?:\/\//i);
  let kind: ChannelConversationKind | null = null;
  let to = trimmed;
  let channelId: string | undefined;
  let groupId: string | undefined;
  let threadId = options?.threadId;
  let display: string | undefined;

  if (typedMatch) {
    const prefix = (typedMatch[1] ?? '').toLowerCase();
    const value = (typedMatch[2] ?? '').trim();
    if (!value) return null;
    to = value;
    kind = prefix === 'direct' || prefix === 'dm' || prefix === 'user'
      ? 'direct'
      : prefix === 'channel'
        ? 'channel'
        : prefix === 'group'
          ? 'group'
          : prefix === 'thread'
            ? 'thread'
            : 'service';
  } else if (hashMatch) {
    to = (hashMatch[1] ?? '').trim();
    display = `#${to}`;
    if (hashMatch[2]?.trim()) {
      kind = 'thread';
      channelId = to;
      groupId = to;
      threadId = (hashMatch[2] ?? '').trim();
      to = threadId;
    } else {
      kind = 'channel';
      channelId = to;
      groupId = to;
    }
  } else if (atMatch) {
    to = (atMatch[1] ?? '').trim();
    display = `@${to}`;
    kind = 'direct';
  } else if (urlMatch) {
    kind = 'service';
  }

  if (!kind || !to.trim()) return null;
  const target: ChannelResolvedTarget = {
    surface,
    input,
    normalized: to.trim().toLowerCase(),
    kind,
    to: to.trim(),
    ...(display ? { display } : {}),
    ...(options?.accountId ? { accountId: options.accountId } : {}),
    ...(kind === 'channel' ? { channelId: channelId ?? to.trim(), groupId: groupId ?? to.trim() } : {}),
    ...(kind === 'group' ? { groupId: groupId ?? to.trim() } : {}),
    ...(kind === 'thread' ? { threadId, channelId, groupId } : {}),
    source: 'explicit',
    metadata: { explicitSyntax: true },
  };
  return {
    ...target,
    sessionTarget: resolveBuiltinSessionTarget(target),
  };
}

export function inferBuiltinTargetConversationKind(
  input: string,
  options?: ChannelTargetResolveOptions,
): ChannelConversationKind {
  const trimmed = input.trim();
  if (trimmed.startsWith('@')) return 'direct';
  if (trimmed.startsWith('#')) return trimmed.includes('/') || trimmed.includes(':') ? 'thread' : 'channel';
  if (/^https?:\/\//i.test(trimmed)) return 'service';
  if (/^thread:/i.test(trimmed)) return 'thread';
  if (/^(direct|dm|user):/i.test(trimmed)) return 'direct';
  if (/^group:/i.test(trimmed)) return 'group';
  if (/^channel:/i.test(trimmed)) return 'channel';
  return options?.preferredKind ?? 'service';
}

export async function resolveBuiltinParentConversationCandidates(
  context: BuiltinTargetContext,
  surface: ChannelSurface,
  options: ChannelTargetResolveOptions,
): Promise<readonly ChannelResolvedTarget[]> {
  const resolved = await resolveBuiltinTarget(context, surface, options);
  if (!resolved) return [];
  if (resolved.kind !== 'thread' || (!resolved.channelId && !resolved.groupId && !resolved.parentId)) {
    return [resolved];
  }
  const parentInput = resolved.channelId ?? resolved.groupId ?? resolved.parentId ?? resolved.to;
  const parent = await resolveBuiltinTarget(context, surface, {
    ...options,
    input: parentInput,
    preferredKind: resolved.channelId ? 'channel' : 'group',
    threadId: undefined,
    createIfMissing: true,
  });
  return parent ? [parent, resolved] : [resolved];
}

export function resolveBuiltinSessionTarget(target: ChannelResolvedTarget): string {
  if (target.sessionId) return `session:${target.sessionId}`;
  const stableId = target.threadId ?? target.channelId ?? target.groupId ?? target.to;
  return `channel:${target.surface}:${stableId.toLowerCase()}`;
}

/**
 * Known conversations (the route directory, the only producer of them), and
 * with `live` the provider's own directory after them. A conversation is
 * listed once: a provider entry with the id a known conversation already
 * carries is dropped.
 */
export async function lookupBuiltinDirectory(
  context: BuiltinTargetContext,
  surface: ManagedSurface,
  query: string,
  options?: ChannelDirectoryQueryOptions,
): Promise<ChannelDirectoryEntry[]> {
  const { entries, truncated } = await lookupBuiltinDirectoryWithTruncation(context, surface, query, options);
  return markTruncated(entries, truncated);
}

export async function lookupBuiltinDirectoryWithTruncation(
  context: BuiltinTargetContext,
  surface: ManagedSurface,
  query: string,
  options?: ChannelDirectoryQueryOptions,
): Promise<{ readonly entries: ChannelDirectoryEntry[]; readonly truncated: boolean }> {
  const routeEntries = await lookupBuiltinRouteDirectory(context, surface, query, options);
  if (!options?.live || surface === 'webhook') return { entries: routeEntries, truncated: false };
  let providerEntries: ChannelDirectoryEntry[];
  try {
    providerEntries = await lookupBuiltinProviderDirectory(context, surface, query, options);
  } catch (error) {
    // With nothing known locally an empty answer would read as "no such
    // conversation", so the cause is raised. Known conversations are still
    // returned, labelled as the partial answer they are in the log.
    logger.warn('Live provider directory lookup failed', {
      surface,
      error: errorText(error),
      action: routeEntries.length > 0
        ? 'only conversations that have already written to this daemon are listed'
        : 'check the surface credential',
    });
    if (routeEntries.length === 0) {
      throw new Error(`The ${surface} directory could not be read: ${errorText(error)}`, { cause: error });
    }
    providerEntries = [];
  }
  // A known conversation is keyed by its binding id but names its provider id
  // as `groupId`/`handle`; both forms are claimed so the provider's own entry
  // for the same conversation is not listed a second time.
  const seen = new Set<string>();
  for (const entry of routeEntries) {
    seen.add(entry.id);
    if (entry.groupId) seen.add(entry.groupId);
    if (entry.kind !== 'member' && entry.handle) seen.add(entry.handle);
  }
  return {
    entries: [...routeEntries, ...providerEntries.filter((entry) => !seen.has(entry.id))],
    truncated: isTruncatedDirectory(providerEntries),
  };
}

export async function lookupBuiltinProviderDirectory(
  context: BuiltinTargetContext,
  surface: ManagedSurface,
  query: string,
  options?: ChannelDirectoryQueryOptions,
): Promise<ChannelDirectoryEntry[]> {
  const needle = query.trim().replace(/^[@#]/, '').toLowerCase();
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
  const scope = options?.scope ?? 'all';
  if (surface === 'slack') {
    const token = await resolveSurfaceSecret(context.deps, 'slack', 'primary');
    // Known conversations come from the route directory; without a token there
    // is no provider directory to add to them.
    if (!token) return [];
    const slack = new SlackIntegration(undefined, token);
    const entries: ChannelDirectoryEntry[] = [];
    let truncated = false;
    // A token may be allowed one half (channels:read without users:read). A half that is refused is
    // left out and logged; the lookup fails only when every half it tried failed.
    let halvesTried = 0;
    const halfFailures: unknown[] = [];
    const readHalf = async (what: string, read: () => Promise<ChannelDirectoryEntry[]>): Promise<void> => {
      halvesTried += 1;
      try {
        const half = await read();
        truncated ||= isTruncatedDirectory(half);
        entries.push(...half);
      } catch (error) {
        halfFailures.push(error);
        logger.warn(`Slack ${what} directory could not be read; the rest is still searched`, { surface, error: errorText(error) });
      }
    };
    if (scope === 'all' || scope === 'channels' || scope === 'groups' || scope === 'peers') {
      await readHalf('conversations', () => collectMatchingPages('slack conversations', needle, limit, async (cursor) => {
        const page = await slack.listConversations({
          token,
          limit: PROVIDER_PAGE_SIZE,
          types: ['public_channel', 'private_channel', 'mpim', 'im'],
          ...(cursor ? { cursor } : {}),
        });
        if (!page.ok) throw new Error(`Slack conversations.list failed: ${page.error ?? 'no reason given'}`);
        return {
          next: page.nextCursor || undefined,
          entries: page.entries.map((channel): ChannelDirectoryEntry => ({
            id: channel.id,
            surface,
            kind: channel.is_im ? 'user' : channel.is_mpim ? 'group' : channel.is_group ? 'group' : 'channel',
            label: channel.name ?? channel.id,
            handle: channel.name ? `#${channel.name}` : channel.id,
            workspaceId: String(context.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined,
            groupId: channel.id,
            memberCount: channel.num_members,
            isDirect: Boolean(channel.is_im),
            isGroupConversation: !channel.is_im,
            searchText: [channel.id, channel.name].filter(Boolean).join(' '),
            metadata: { provider: 'slack' },
          })),
        };
      }));
    }
    if (scope === 'all' || scope === 'users' || scope === 'members' || scope === 'peers') {
      await readHalf('users', () => collectMatchingPages('slack users', needle, limit, async (cursor) => {
        const page = await slack.listUsers({ token, limit: PROVIDER_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        if (!page.ok) throw new Error(`Slack users.list failed: ${page.error ?? 'no reason given'}`);
        return {
          next: page.nextCursor || undefined,
          entries: page.entries.filter((user) => !user.deleted).map((user): ChannelDirectoryEntry => {
            const display = typeof user.profile?.display_name === 'string' && user.profile.display_name
              ? user.profile.display_name
              : user.real_name ?? user.name ?? user.id;
            return {
              id: user.id,
              surface,
              kind: user.is_bot ? 'service' : 'user',
              label: display,
              handle: user.name ? `@${user.name}` : user.id,
              workspaceId: String(context.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined,
              isDirect: true,
              searchText: [user.id, user.name, user.real_name, display].filter(Boolean).join(' '),
              metadata: { provider: 'slack' },
            };
          }),
        };
      }));
    }
    if (halvesTried > 0 && halfFailures.length === halvesTried) throw halfFailures[0];
    return markTruncated(filterProviderDirectory(entries, needle, limit), truncated);
  }

  if (surface === 'discord') {
    const token = await resolveSurfaceSecret(context.deps, 'discord', 'primary');
    const guildId = String(context.deps.configManager.get('surfaces.discord.guildId') || '');
    if (!token || !guildId) return [];
    const discord = new DiscordIntegration(undefined, token);
    const entries: ChannelDirectoryEntry[] = [];
    if (scope === 'all' || scope === 'channels' || scope === 'groups' || scope === 'peers') {
      const channels = await discord.listGuildChannels(guildId, token);
      for (const channel of channels) {
        const id = typeof channel.id === 'string' ? channel.id : '';
        if (!id) continue;
        const name = typeof channel.name === 'string' ? channel.name : id;
        const type = typeof channel.type === 'number' ? channel.type : -1;
        entries.push({
          id,
          surface,
          kind: type === 11 || type === 12 ? 'thread' : type === 3 ? 'group' : 'channel',
          label: name,
          handle: `#${name}`,
          workspaceId: guildId,
          groupId: id,
          parentId: typeof channel.parent_id === 'string' ? channel.parent_id : undefined,
          isGroupConversation: true,
          searchText: [id, name].join(' '),
          metadata: { provider: 'discord' },
        });
      }
    }
    let truncated = false;
    if (scope === 'all' || scope === 'users' || scope === 'members' || scope === 'peers') {
      // Listing members needs a privileged gateway intent; channels are still
      // searchable without it, so a refusal here leaves the answer partial.
      try {
        const members = await collectMatchingPages('discord members', needle, limit, async (cursor) => {
          const members = await discord.listGuildMembers(guildId, {
            token,
            limit: PROVIDER_PAGE_SIZE,
            ...(cursor ? { after: cursor } : {}),
          });
          const lastUser = (members.at(-1)?.user ?? {}) as Record<string, unknown>;
          const lastId = typeof lastUser.id === 'string' ? lastUser.id : undefined;
          return {
            next: members.length >= PROVIDER_PAGE_SIZE ? lastId : undefined,
            entries: members.flatMap((member): ChannelDirectoryEntry[] => {
              const user = (member.user ?? {}) as Record<string, unknown>;
              const id = typeof user.id === 'string' ? user.id : '';
              if (!id) return [];
              const username = typeof user.username === 'string' ? user.username : id;
              const nick = typeof member.nick === 'string' ? member.nick : undefined;
              return [{
                id,
                surface,
                kind: 'user',
                label: nick ?? username,
                handle: `@${username}`,
                workspaceId: guildId,
                isDirect: true,
                searchText: [id, username, nick].filter(Boolean).join(' '),
                metadata: { provider: 'discord' },
              }];
            }),
          };
        });
        truncated = isTruncatedDirectory(members);
        entries.push(...members);
      } catch (error) {
        logger.warn('Discord member directory could not be read; only channels are listed', {
          surface,
          error: errorText(error),
        });
      }
    }
    return markTruncated(filterProviderDirectory(entries, needle, limit), truncated);
  }

  const surfaces = context.deps.configManager.getCategory('surfaces');

  if (surface === 'ntfy') {
    const topic = String(context.deps.configManager.get('surfaces.ntfy.topic') || '');
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!topic) return [];
    return filterProviderDirectory([{
      id: topic,
      surface,
      kind: 'channel',
      label: topic,
      handle: topic,
      groupId: topic,
      isGroupConversation: true,
      searchText: topic,
      metadata: { provider: 'ntfy', baseUrl: context.deps.configManager.get('surfaces.ntfy.baseUrl') },
    }], needle, limit);
  }

  if (surface === 'homeassistant') {
    const conversationId = surfaces.homeassistant.defaultConversationId || surfaces.homeassistant.deviceId || 'goodvibes';
    const candidates: ChannelDirectoryEntry[] = [{
      id: conversationId,
      surface,
      kind: 'service',
      label: surfaces.homeassistant.deviceName || 'GoodVibes Daemon',
      handle: conversationId,
      groupId: conversationId,
      isGroupConversation: false,
      searchText: [
        conversationId,
        surfaces.homeassistant.deviceId,
        surfaces.homeassistant.deviceName,
        surfaces.homeassistant.instanceUrl,
      ].filter(Boolean).join(' '),
      metadata: {
        provider: 'homeassistant',
        instanceUrl: surfaces.homeassistant.instanceUrl,
        eventType: surfaces.homeassistant.eventType,
      },
    }];
    return filterProviderDirectory(candidates, needle, limit);
  }

  if (surface === 'telegram') {
    // Known conversations come from the route directory; this half adds the
    // configured default chat and the bot itself.
    const candidates: ChannelDirectoryEntry[] = [];
    if (surfaces.telegram.defaultChatId) {
      candidates.push({
        id: surfaces.telegram.defaultChatId,
        surface,
        kind: 'channel',
        label: surfaces.telegram.defaultChatId,
        handle: surfaces.telegram.defaultChatId,
        groupId: surfaces.telegram.defaultChatId,
        isGroupConversation: true,
        searchText: [surfaces.telegram.defaultChatId, surfaces.telegram.botUsername].filter(Boolean).join(' '),
        metadata: { provider: 'telegram', mode: surfaces.telegram.mode },
      });
    }
    if (surfaces.telegram.botUsername) {
      candidates.push({
        id: surfaces.telegram.botUsername.replace(/^@/, ''),
        surface,
        kind: 'service',
        label: `@${surfaces.telegram.botUsername.replace(/^@/, '')}`,
        handle: `@${surfaces.telegram.botUsername.replace(/^@/, '')}`,
        searchText: surfaces.telegram.botUsername,
        metadata: { provider: 'telegram', bot: true },
      });
    }
    return filterProviderDirectory(candidates, needle, limit);
  }

  if (surface === 'google-chat') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.googleChat.spaceId && !surfaces.googleChat.appId) return [];
    return filterProviderDirectory([{
      id: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
      surface,
      kind: 'channel',
      label: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
      handle: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
      groupId: surfaces.googleChat.spaceId || surfaces.googleChat.appId,
      isGroupConversation: true,
      searchText: [surfaces.googleChat.spaceId, surfaces.googleChat.appId].filter(Boolean).join(' '),
      metadata: { provider: 'google-chat' },
    }], needle, limit);
  }

  if (surface === 'signal') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.signal.defaultRecipient && !surfaces.signal.account) return [];
    return filterProviderDirectory([{
      id: surfaces.signal.defaultRecipient || surfaces.signal.account,
      surface,
      kind: 'user',
      label: surfaces.signal.defaultRecipient || surfaces.signal.account,
      handle: surfaces.signal.defaultRecipient || surfaces.signal.account,
      isDirect: true,
      searchText: [surfaces.signal.defaultRecipient, surfaces.signal.account].filter(Boolean).join(' '),
      metadata: { provider: 'signal', bridgeUrl: surfaces.signal.bridgeUrl },
    }], needle, limit);
  }

  if (surface === 'whatsapp') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.whatsapp.defaultRecipient && !surfaces.whatsapp.phoneNumberId) return [];
    return filterProviderDirectory([{
      id: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
      surface,
      kind: 'user',
      label: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
      handle: surfaces.whatsapp.defaultRecipient || surfaces.whatsapp.phoneNumberId,
      isDirect: true,
      searchText: [
        surfaces.whatsapp.defaultRecipient,
        surfaces.whatsapp.phoneNumberId,
        surfaces.whatsapp.businessAccountId,
      ].filter(Boolean).join(' '),
      metadata: { provider: 'whatsapp', mode: surfaces.whatsapp.provider },
    }], needle, limit);
  }

  if (surface === 'telephony') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.telephony.defaultRecipient && !surfaces.telephony.fromNumber && !surfaces.telephony.accountSid) return [];
    return filterProviderDirectory([{
      id: surfaces.telephony.defaultRecipient || surfaces.telephony.fromNumber || surfaces.telephony.accountSid,
      surface,
      kind: 'user',
      label: surfaces.telephony.defaultRecipient || surfaces.telephony.fromNumber || surfaces.telephony.accountSid,
      handle: surfaces.telephony.defaultRecipient || surfaces.telephony.fromNumber || surfaces.telephony.accountSid,
      isDirect: true,
      searchText: [
        surfaces.telephony.defaultRecipient,
        surfaces.telephony.fromNumber,
        surfaces.telephony.accountSid,
      ].filter(Boolean).join(' '),
      metadata: { provider: 'telephony', mode: surfaces.telephony.mode },
    }], needle, limit);
  }

  if (surface === 'imessage') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.imessage.defaultChatId && !surfaces.imessage.account) return [];
    return filterProviderDirectory([{
      id: surfaces.imessage.defaultChatId || surfaces.imessage.account,
      surface,
      kind: 'user',
      label: surfaces.imessage.defaultChatId || surfaces.imessage.account,
      handle: surfaces.imessage.defaultChatId || surfaces.imessage.account,
      isDirect: true,
      searchText: [surfaces.imessage.defaultChatId, surfaces.imessage.account].filter(Boolean).join(' '),
      metadata: { provider: 'imessage', bridgeUrl: surfaces.imessage.bridgeUrl },
    }], needle, limit);
  }

  if (surface === 'msteams') {
    const candidates: ChannelDirectoryEntry[] = [];
    if (surfaces.msteams.defaultConversationId) {
      candidates.push({
        id: surfaces.msteams.defaultConversationId,
        surface,
        kind: 'channel',
        label: surfaces.msteams.defaultConversationId,
        handle: surfaces.msteams.defaultConversationId,
        groupId: surfaces.msteams.defaultChannelId || surfaces.msteams.defaultConversationId,
        isGroupConversation: true,
        searchText: [
          surfaces.msteams.defaultConversationId,
          surfaces.msteams.defaultChannelId,
          surfaces.msteams.botId,
        ].filter(Boolean).join(' '),
        metadata: { provider: 'msteams', serviceUrl: surfaces.msteams.serviceUrl },
      });
    }
    if (surfaces.msteams.botId) {
      candidates.push({
        id: surfaces.msteams.botId,
        surface,
        kind: 'service',
        label: surfaces.msteams.botId,
        handle: surfaces.msteams.botId,
        searchText: [surfaces.msteams.botId, surfaces.msteams.appId].filter(Boolean).join(' '),
        metadata: { provider: 'msteams', bot: true },
      });
    }
    return filterProviderDirectory(candidates, needle, limit);
  }

  if (surface === 'bluebubbles') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.bluebubbles.defaultChatGuid && !surfaces.bluebubbles.account) return [];
    return filterProviderDirectory([{
      id: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
      surface,
      kind: 'user',
      label: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
      handle: surfaces.bluebubbles.defaultChatGuid || surfaces.bluebubbles.account,
      isDirect: !(surfaces.bluebubbles.defaultChatGuid || '').includes(';+;'),
      searchText: [surfaces.bluebubbles.defaultChatGuid, surfaces.bluebubbles.account].filter(Boolean).join(' '),
      metadata: { provider: 'bluebubbles', serverUrl: surfaces.bluebubbles.serverUrl },
    }], needle, limit);
  }

  if (surface === 'mattermost') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.mattermost.defaultChannelId && !surfaces.mattermost.teamId) return [];
    return filterProviderDirectory([{
      id: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
      surface,
      kind: 'channel',
      label: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
      handle: surfaces.mattermost.defaultChannelId || surfaces.mattermost.teamId,
      groupId: surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId,
      isGroupConversation: true,
      searchText: [surfaces.mattermost.defaultChannelId, surfaces.mattermost.teamId].filter(Boolean).join(' '),
      metadata: { provider: 'mattermost', baseUrl: surfaces.mattermost.baseUrl },
    }], needle, limit);
  }

  if (surface === 'matrix') {
    // The configured defaults are what this half adds; known conversations come
    // from the route directory whether or not any default is set.
    if (!surfaces.matrix.defaultRoomId && !surfaces.matrix.userId) return [];
    return filterProviderDirectory([{
      id: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
      surface,
      kind: 'channel',
      label: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
      handle: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
      groupId: surfaces.matrix.defaultRoomId || surfaces.matrix.userId,
      isGroupConversation: true,
      searchText: [surfaces.matrix.defaultRoomId, surfaces.matrix.userId].filter(Boolean).join(' '),
      metadata: { provider: 'matrix', homeserverUrl: surfaces.matrix.homeserverUrl },
    }], needle, limit);
  }

  return [];
}

async function lookupBuiltinRouteDirectory(
  context: BuiltinTargetContext,
  surface: ManagedSurface,
  query: string,
  options?: ChannelDirectoryQueryOptions,
): Promise<ChannelDirectoryEntry[]> {
  await context.deps.routeBindings.start();
  const needle = query.trim().toLowerCase();
  const scope = options?.scope ?? 'all';
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
  const entries = context.deps.routeBindings.listBindings()
    .filter((binding) => binding.surfaceKind === surface)
    .flatMap((binding) => {
      const metadata = binding.metadata ?? {};
      const configuredKind = typeof metadata.directoryKind === 'string' ? metadata.directoryKind : undefined;
      const memberEntries = Array.isArray(metadata.members)
        ? metadata.members
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry, index) => ({
              id: typeof entry.id === 'string' ? entry.id : `${binding.id}:member:${index}`,
              surface,
              kind: 'member' as const,
              label: typeof entry.label === 'string'
                ? entry.label
                : typeof entry.handle === 'string'
                  ? entry.handle
                  : `Member ${index + 1}`,
              handle: typeof entry.handle === 'string' ? entry.handle : undefined,
              accountId: typeof entry.accountId === 'string' ? entry.accountId : undefined,
              workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : undefined,
              groupId: binding.channelId ?? binding.externalId,
              parentId: binding.id,
              aliases: Array.isArray(entry.aliases)
                ? entry.aliases.filter((value): value is string => typeof value === 'string')
                : undefined,
              isSelf: Boolean(entry.isSelf),
              isDirect: Boolean(entry.isDirect),
              isGroupConversation: true,
              searchText: [
                typeof entry.handle === 'string' ? entry.handle : '',
                typeof entry.label === 'string' ? entry.label : '',
              ].filter(Boolean).join(' ').trim() || undefined,
              // Ids that tie the member to its conversation, never the stored record.
              metadata: {
                parentBindingId: binding.id,
                ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
              },
            }))
        : [];
      const baseKind = configuredKind === 'group' || configuredKind === 'member' || configuredKind === 'user' || configuredKind === 'self'
        ? configuredKind
        : binding.threadId
          ? 'thread'
          : binding.channelId
            ? 'group'
            : 'service';
      const mainEntry: ChannelDirectoryEntry = {
        id: binding.id,
        surface,
        kind: baseKind,
        label: binding.title ?? binding.externalId,
        handle: binding.channelId ?? binding.externalId,
        accountId: typeof metadata.accountId === 'string' ? metadata.accountId : undefined,
        workspaceId: typeof metadata.workspaceId === 'string' ? metadata.workspaceId : undefined,
        groupId: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
        parentId: binding.channelId && binding.threadId ? binding.channelId : undefined,
        memberCount: memberEntries.length > 0 ? memberEntries.length : undefined,
        memberIds: memberEntries.length > 0 ? memberEntries.map((entry) => entry.id) : undefined,
        aliases: Array.isArray(metadata.aliases)
          ? metadata.aliases.filter((value): value is string => typeof value === 'string')
          : undefined,
        isSelf: Boolean(metadata.isSelf),
        isDirect: Boolean(metadata.isDirect),
        isGroupConversation: baseKind === 'group' || baseKind === 'thread',
        searchText: [
          binding.externalId,
          String(binding.title ?? ''),
          String(binding.channelId ?? ''),
          ...(Array.isArray(metadata.aliases)
            ? metadata.aliases.filter((value): value is string => typeof value === 'string')
            : []),
        ].filter(Boolean).join(' ').trim() || undefined,
        // The binding's ids only. Its stored metadata holds inbound payload
        // fields, which have no place in a directory answer an agent reads.
        metadata: {
          externalId: binding.externalId,
          ...(binding.channelId ? { channelId: binding.channelId } : {}),
          ...(binding.threadId ? { threadId: binding.threadId } : {}),
          ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
          surfaceId: binding.surfaceId,
        },
      };
      return [mainEntry, ...memberEntries];
    });
  return entries
    .filter((entry) => !options?.groupId || entry.groupId === options.groupId || entry.parentId === options.groupId || entry.id === options.groupId)
    .filter((entry) => {
      if (scope === 'all') return true;
      if (scope === 'self') return entry.kind === 'self';
      if (scope === 'users') return entry.kind === 'user' || entry.kind === 'member';
      if (scope === 'peers') return entry.kind === 'user' || entry.kind === 'group' || entry.kind === 'channel';
      if (scope === 'groups') return entry.kind === 'group' || entry.kind === 'channel' || entry.kind === 'thread';
      if (scope === 'channels') return entry.kind === 'channel' || entry.kind === 'group';
      if (scope === 'threads') return entry.kind === 'thread';
      if (scope === 'services') return entry.kind === 'service';
      if (scope === 'members') return entry.kind === 'member';
      return false;
    })
    .filter((entry) => !needle
      || entry.id.toLowerCase().includes(needle)
      || entry.label.toLowerCase().includes(needle)
      || String(entry.handle ?? '').toLowerCase().includes(needle)
      || String(entry.searchText ?? '').toLowerCase().includes(needle))
    .slice(0, limit);
}

function resolveDirectoryEntryTarget(
  surface: ChannelSurface,
  options: ChannelTargetResolveOptions,
  entry: ChannelDirectoryEntry,
  explicit?: ChannelResolvedTarget | null,
): ChannelResolvedTarget {
  const kind = explicit?.kind ?? kindForDirectoryEntry(entry);
  const metadataSessionId = typeof entry.metadata.sessionId === 'string' ? entry.metadata.sessionId : undefined;
  const routeBacked = typeof entry.metadata.externalId === 'string' || typeof entry.metadata.parentBindingId === 'string';
  const target: ChannelResolvedTarget = {
    surface,
    input: options.input,
    normalized: (explicit?.normalized ?? entry.handle ?? entry.id).toLowerCase(),
    kind,
    to: explicit?.to ?? entry.handle ?? entry.id,
    display: entry.label,
    accountId: entry.accountId ?? explicit?.accountId ?? options.accountId,
    workspaceId: entry.workspaceId,
    channelId: explicit?.channelId ?? (entry.kind === 'channel' || entry.kind === 'group' || entry.kind === 'thread' ? entry.groupId ?? entry.id : undefined),
    groupId: explicit?.groupId ?? entry.groupId,
    threadId: explicit?.threadId ?? options.threadId ?? entry.threadId,
    parentId: entry.parentId,
    sessionId: metadataSessionId,
    bindingId: routeBacked ? String(entry.metadata.parentBindingId ?? entry.id) : undefined,
    directoryEntryId: entry.id,
    source: routeBacked ? 'route' : 'directory',
    metadata: {
      directoryEntry: entry,
      explicit: explicit ?? null,
    },
  };
  return {
    ...target,
    sessionTarget: resolveBuiltinSessionTarget(target),
  };
}

function scopeForTargetKind(kind?: ChannelConversationKind): ChannelDirectoryScope | undefined {
  if (kind === 'direct') return 'users';
  if (kind === 'channel') return 'channels';
  if (kind === 'group') return 'groups';
  if (kind === 'thread') return 'threads';
  if (kind === 'service') return 'services';
  return undefined;
}

function kindForDirectoryEntry(entry: ChannelDirectoryEntry): ChannelConversationKind {
  if (entry.kind === 'self' || entry.kind === 'user' || entry.kind === 'member') return 'direct';
  if (entry.kind === 'thread') return 'thread';
  if (entry.kind === 'channel') return 'channel';
  if (entry.kind === 'group') return 'group';
  return 'service';
}

function pickBestDirectoryEntry(entries: readonly ChannelDirectoryEntry[], query: string): ChannelDirectoryEntry | undefined {
  const normalized = query.trim().replace(/^[@#]/, '').toLowerCase();
  // Only an exact match resolves. A name that merely contains the input is a
  // candidate for a directory listing, not the conversation the caller meant:
  // sending to it, or allow-listing it, would reach somebody else.
  return entries.find((entry) => [
    entry.id,
    entry.handle,
    entry.label,
    entry.groupId,
    entry.threadId,
    ...(entry.aliases ?? []),
  ].some((value) => typeof value === 'string' && value.replace(/^[@#]/, '').toLowerCase() === normalized));
}

/**
 * Follow a provider's pages until `limit` entries match the needle or the pages
 * run out. The needle is applied to every page before anything is truncated, so
 * a name in the second page of a large workspace is found.
 */
async function collectMatchingPages(
  what: string,
  needle: string,
  limit: number,
  fetchPage: (cursor: string | undefined) => Promise<{ readonly entries: readonly ChannelDirectoryEntry[]; readonly next: string | undefined }>,
): Promise<ChannelDirectoryEntry[]> {
  const found: ChannelDirectoryEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PROVIDER_MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    found.push(...filterProviderDirectory(result.entries, needle, Number.MAX_SAFE_INTEGER));
    // An exact name is the conversation or person being looked for; the pages
    // after it can only add near misses, each one a request against a rate limit.
    if (found.length >= limit || !result.next || (needle && pickBestDirectoryEntry(found, needle))) return found;
    cursor = result.next;
  }
  logger.warn('Provider directory search stopped at its page cap', { what, pages: PROVIDER_MAX_PAGES, matches: found.length });
  return markTruncated(found, true);
}

function filterProviderDirectory(entries: readonly ChannelDirectoryEntry[], needle: string, limit: number): ChannelDirectoryEntry[] {
  return entries
    .filter((entry) => !needle
      || entry.id.toLowerCase().includes(needle)
      || entry.label.toLowerCase().includes(needle)
      || String(entry.handle ?? '').replace(/^[@#]/, '').toLowerCase().includes(needle)
      || String(entry.searchText ?? '').toLowerCase().includes(needle))
    .slice(0, limit);
}
