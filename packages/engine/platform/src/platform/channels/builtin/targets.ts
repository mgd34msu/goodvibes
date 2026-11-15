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
import { resolveDiscordBotToken, resolveSlackBotToken } from './surfaces.js';
// One rule applied identically on every surface: a conversation that has
// already written to us is a target with no configuration at all.
import { directoryEntriesFromBindings } from './directory-bindings.js';
import { logger } from '../../utils/logger.js';

/** Provider pages are fetched at a fixed size; `limit` only bounds what is returned. */
const PROVIDER_PAGE_SIZE = 200;
/** A workspace larger than this many pages is searched up to the cap and the result says so in the log. */
const PROVIDER_MAX_PAGES = 10;

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
  if (explicit) {
    return directoryError ? { ...explicit, metadata: { ...explicit.metadata, directoryError } } : explicit;
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

export async function lookupBuiltinDirectory(
  context: BuiltinTargetContext,
  surface: ManagedSurface,
  query: string,
  options?: ChannelDirectoryQueryOptions,
): Promise<ChannelDirectoryEntry[]> {
  const routeEntries = await lookupBuiltinRouteDirectory(context, surface, query, options);
  if (!options?.live || surface === 'webhook') return routeEntries;
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
  const seen = new Set<string>();
  return [...routeEntries, ...providerEntries].filter((entry) => {
    const key = `${entry.surface}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    const token = await resolveSlackBotToken(context.deps);
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!token) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'slack'), needle, limit);
    const slack = new SlackIntegration(undefined, token);
    const entries: ChannelDirectoryEntry[] = [];
    // A token may be allowed one half (channels:read without users:read). A half that is refused is
    // left out and logged; the lookup fails only when every half it tried failed.
    let halvesTried = 0;
    const halfFailures: unknown[] = [];
    const readHalf = async (what: string, read: () => Promise<ChannelDirectoryEntry[]>): Promise<void> => {
      halvesTried += 1;
      try {
        entries.push(...await read());
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
            metadata: { provider: 'slack', raw: channel },
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
              metadata: { provider: 'slack', raw: user },
            };
          }),
        };
      }));
    }
    if (halvesTried > 0 && halfFailures.length === halvesTried) throw halfFailures[0];
    return filterProviderDirectory(entries, needle, limit);
  }

  if (surface === 'discord') {
    const token = await resolveDiscordBotToken(context.deps);
    const guildId = String(context.deps.configManager.get('surfaces.discord.guildId') || '');
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!token || !guildId) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'discord'), needle, limit);
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
          metadata: { provider: 'discord', raw: channel },
        });
      }
    }
    if (scope === 'all' || scope === 'users' || scope === 'members' || scope === 'peers') {
      // Listing members needs a privileged gateway intent; channels are still
      // searchable without it, so a refusal here leaves the answer partial.
      try {
        entries.push(...await collectMatchingPages('discord members', needle, limit, async (cursor) => {
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
                metadata: { provider: 'discord', raw: member },
              }];
            }),
          };
        }));
      } catch (error) {
        logger.warn('Discord member directory could not be read; only channels are listed', {
          surface,
          error: errorText(error),
        });
      }
    }
    return filterProviderDirectory(entries, needle, limit);
  }

  const surfaces = context.deps.configManager.getCategory('surfaces');

  if (surface === 'ntfy') {
    const topic = String(context.deps.configManager.get('surfaces.ntfy.topic') || '');
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!topic) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'ntfy'), needle, limit);
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
    const candidates: ChannelDirectoryEntry[] = [];
    // Every known conversation is a real target, whether or not the operator
    // ever filled in `defaultChatId`. Those fields exist to INITIATE contact;
    // a chat the bot has already talked to needs no configuration at all, and
    // gating the directory on them is what left a fresh install able to
    // receive messages but unable to answer them.
    candidates.push(...directoryEntriesFromBindings(context, surface, 'telegram'));
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.googleChat.spaceId && !surfaces.googleChat.appId) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'google-chat'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.signal.defaultRecipient && !surfaces.signal.account) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'signal'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.whatsapp.defaultRecipient && !surfaces.whatsapp.phoneNumberId) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'whatsapp'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.telephony.defaultRecipient && !surfaces.telephony.fromNumber && !surfaces.telephony.accountSid) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'telephony'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.imessage.defaultChatId && !surfaces.imessage.account) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'imessage'), needle, limit);
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
    // Same rule as every other surface: a conversation that has written to us
    // is a target with no configuration at all.
    candidates.push(...directoryEntriesFromBindings(context, surface, 'msteams'));
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.bluebubbles.defaultChatGuid && !surfaces.bluebubbles.account) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'bluebubbles'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.mattermost.defaultChannelId && !surfaces.mattermost.teamId) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'mattermost'), needle, limit);
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
    // A conversation that has already written to us is a real target with no
    // configuration at all (see directoryEntriesFromBindings); the optional
    // fields below only matter for INITIATING contact.
    if (!surfaces.matrix.defaultRoomId && !surfaces.matrix.userId) return filterProviderDirectory(directoryEntriesFromBindings(context, surface, 'matrix'), needle, limit);
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
              metadata: {
                ...entry,
                parentBindingId: binding.id,
                sessionId: binding.sessionId,
                jobId: binding.jobId,
                runId: binding.runId,
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
        metadata: {
          externalId: binding.externalId,
          channelId: binding.channelId,
          threadId: binding.threadId,
          sessionId: binding.sessionId,
          jobId: binding.jobId,
          runId: binding.runId,
          surfaceId: binding.surfaceId,
          ...metadata,
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
    if (found.length >= limit || !result.next) return found;
    cursor = result.next;
  }
  logger.warn('Provider directory search stopped at its page cap', { what, pages: PROVIDER_MAX_PAGES, matches: found.length });
  return found;
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
