import type {
  ChannelAccountRecord,
  ChannelCapability,
  ChannelCapabilityDescriptor,
  ChannelOperatorActionDescriptor,
  ChannelSurface,
  ChannelToolDescriptor,
} from '../types.js';
import { providerOperationsFor } from './provider-operations.js';
import {
  HOME_ASSISTANT_SURFACE,
  listHomeAssistantOperatorActions,
  listHomeAssistantTools,
} from './homeassistant.js';

const ALLOWLIST_ENTRY_PROPERTIES = {
  add: { type: 'array', items: { type: 'string' }, description: 'Names, handles, or typed ids such as user:U0123 or channel:C0123.' },
  remove: { type: 'array', items: { type: 'string' } },
  kind: { type: 'string', enum: ['user', 'channel', 'group'], description: 'Whether the entries are people (user) or conversations (channel, group). Required unless every entry is a typed id.' },
};

const ALLOWLIST_EDIT_PROPERTIES = {
  ...ALLOWLIST_ENTRY_PROPERTIES,
  groupId: { type: 'string' },
  channelId: { type: 'string' },
  workspaceId: { type: 'string' },
  metadata: { type: 'object' },
  force: { type: 'boolean', description: 'Apply even though the edit would refuse the caller\'s own conversation.' },
  callerUserId: { type: 'string', description: 'Your own provider user id on this surface, kept admitted.' },
  callerConversationId: { type: 'string', description: 'The id of the conversation you are writing from, kept admitted.' },
  callerConversationKind: { type: 'string', enum: ['direct', 'group', 'channel', 'thread', 'service'] },
};

const DIRECTORY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    scope: { type: 'string', enum: ['all', 'self', 'users', 'peers', 'groups', 'channels', 'threads', 'services', 'members'] },
    groupId: { type: 'string' },
    limit: { type: 'number' },
    live: { type: 'boolean', description: 'Also search the provider directory (needs the surface credential).' },
  },
  additionalProperties: false,
};

export function listBuiltinCapabilities(
  surface: ChannelSurface,
  account: ChannelAccountRecord,
  rawCapabilities: readonly ChannelCapability[],
): ChannelCapabilityDescriptor[] {
  const supports = (capability: ChannelCapability): boolean => rawCapabilities.includes(capability);
  return [
    {
      id: 'ingress',
      surface,
      label: 'Inbound messages',
      scope: 'surface',
      supported: supports('ingress'),
      detail: supports('ingress') ? 'Surface can accept inbound traffic into the runtime.' : 'Inbound traffic is not supported.',
      metadata: {},
    },
    {
      id: 'egress',
      surface,
      label: 'Outbound delivery',
      scope: 'delivery',
      supported: supports('egress'),
      detail: supports('egress') ? 'Surface can deliver replies and automation output.' : 'Outbound delivery is not supported.',
      metadata: {},
    },
    {
      id: 'threaded_reply',
      surface,
      label: 'Thread-aware replies',
      scope: 'interaction',
      supported: supports('threaded_reply'),
      detail: supports('threaded_reply') ? 'Replies can preserve thread context.' : 'Replies are not thread-aware.',
      metadata: {},
    },
    {
      id: 'interactive_actions',
      surface,
      label: 'Interactive actions',
      scope: 'interaction',
      supported: supports('interactive_actions'),
      detail: supports('interactive_actions') ? 'Surface supports button or interaction callbacks.' : 'Interactive callbacks are not available.',
      metadata: {},
    },
    {
      id: 'session_binding',
      surface,
      label: 'Session binding',
      scope: 'surface',
      supported: supports('session_binding'),
      detail: supports('session_binding') ? 'Routes can be bound to shared runtime sessions.' : 'Session binding is not supported on this surface.',
      metadata: {},
    },
    {
      id: 'account_posture',
      surface,
      label: 'Account posture',
      scope: 'accounts',
      supported: true,
      detail: `Account state: ${account.state}; auth posture: ${account.authState}.`,
      metadata: {
        accountId: account.accountId,
        configured: account.configured,
        linked: account.linked,
      },
    },
    {
      id: 'directory',
      surface,
      label: 'Directory lookup',
      scope: 'directory',
      supported: true,
      detail: 'Directory and group/member projections are available through the channel runtime.',
      metadata: {},
    },
    {
      id: 'tooling',
      surface,
      label: 'Channel tool bridge',
      scope: 'tooling',
      supported: true,
      detail: 'Channel-owned tools and operator actions can be executed through the shared channel tool bridge.',
      metadata: {},
    },
    {
      id: 'account_lifecycle',
      surface,
      label: 'Account lifecycle',
      scope: 'accounts',
      supported: supports('account_lifecycle'),
      detail: supports('account_lifecycle')
        ? 'Surface exposes account lifecycle commands through the channel runtime.'
        : 'Account lifecycle commands are not available.',
      metadata: {},
    },
    {
      id: 'target_resolution',
      surface,
      label: 'Target resolution',
      scope: 'directory',
      supported: supports('target_resolution'),
      detail: supports('target_resolution')
        ? 'Surface can resolve channel-specific target inputs into structured destinations.'
        : 'Target resolution is not available.',
      metadata: {},
    },
    {
      id: 'agent_tools',
      surface,
      label: 'Direct agent tools',
      scope: 'tooling',
      supported: supports('agent_tools'),
      detail: supports('agent_tools')
        ? 'Surface contributes direct tool entries to agent runtimes when the channel registry is active.'
        : 'Direct channel-owned agent tools are not available.',
      metadata: {},
    },
  ];
}

export function listBuiltinOperatorActions(surface: ChannelSurface): ChannelOperatorActionDescriptor[] {
  const actions: ChannelOperatorActionDescriptor[] = [
    {
      id: 'inspect-account',
      surface,
      label: 'Inspect account',
      description: 'Return the current channel-account posture and safe secret-source summary.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
      },
      metadata: {},
    },
    {
      id: 'inspect-status',
      surface,
      label: 'Inspect status',
      description: 'Return the current surface status snapshot.',
      dangerous: false,
      metadata: {},
    },
    {
      id: 'setup-schema',
      surface,
      label: 'Get setup schema',
      description: 'Return the versioned setup contract, secret targets, and external steps for this surface.',
      dangerous: false,
      metadata: {},
    },
    {
      id: 'doctor',
      surface,
      label: 'Run doctor',
      description: 'Return doctor checks and repair actions for this surface.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
      },
      metadata: {},
    },
    {
      id: 'repair-actions',
      surface,
      label: 'List repair actions',
      description: 'Return repair actions for this surface.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
      },
      metadata: {},
    },
    {
      id: 'lifecycle-state',
      surface,
      label: 'Get lifecycle state',
      description: 'Return lifecycle posture for this surface.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
      },
      metadata: {},
    },
    {
      id: 'list-directory',
      surface,
      label: 'List directory',
      description: 'Search the conversations this surface already knows; with live, the provider directory too.',
      dangerous: false,
      inputSchema: DIRECTORY_INPUT_SCHEMA,
      metadata: {},
    },
    {
      id: 'list-capabilities',
      surface,
      label: 'List capabilities',
      description: 'Return the current channel capability descriptors.',
      dangerous: false,
      metadata: {},
    },
    {
      id: 'account-action',
      surface,
      label: 'Run account lifecycle action',
      description: 'Execute a channel-account lifecycle action such as inspect, retest, start, stop, login, or logout.',
      dangerous: true,
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          action: { type: 'string', enum: ['inspect', 'setup', 'retest', 'connect', 'disconnect', 'start', 'stop', 'login', 'logout', 'wait_login'] },
        },
        required: ['action'],
      },
      metadata: {},
    },
    {
      id: 'resolve-target',
      surface,
      label: 'Resolve target',
      description: 'Resolve a channel-specific target like #channel, @user, a thread id, or a route-backed destination.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          input: { type: 'string' },
          preferredKind: { type: 'string' },
          threadId: { type: 'string' },
          accountId: { type: 'string' },
          createIfMissing: { type: 'boolean' },
          live: { type: 'boolean' },
        },
      },
      metadata: {},
    },
    {
      id: 'authorize-actor-action',
      surface,
      label: 'Authorize actor action',
      description: 'Check whether a channel actor can run a channel action against an account or target.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: {
          actorId: { type: 'string' },
          actionId: { type: 'string' },
          accountId: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['actionId'],
      },
      metadata: {},
    },
    {
      id: 'resolve-allowlist',
      surface,
      label: 'Resolve allowlist entries',
      description: 'Resolve allowlist candidates (names, handles or typed ids) into the provider ids ingress compares; candidates that match nothing are listed as unresolved.',
      dangerous: false,
      inputSchema: {
        type: 'object',
        properties: ALLOWLIST_ENTRY_PROPERTIES,
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: 'edit-allowlist',
      surface,
      label: 'Edit allowlist',
      description: 'Add or remove allowlist entries at the surface or a scoped group/channel. Requires kind; refuses entries that do not resolve to a provider id and edits that would refuse the caller\'s own conversation (unless force).',
      dangerous: true,
      inputSchema: {
        type: 'object',
        properties: ALLOWLIST_EDIT_PROPERTIES,
        additionalProperties: false,
      },
      metadata: {},
    },
    ...providerOperationsFor(surface).map((operation): ChannelOperatorActionDescriptor => ({
      id: operation.id,
      surface,
      label: operation.label,
      description: operation.description,
      dangerous: operation.dangerous,
      inputSchema: operation.inputSchema,
      metadata: { providerOperation: true },
    })),
  ];
  if (surface === 'telegram') actions.push(
    { id: 'restart-ingress', surface, label: 'Restart Telegram receiving',
      description: 'Stop and start Telegram receiving with the current settings and bot token (polling or webhook). Saved positions are kept.', dangerous: false, metadata: {} },
    { id: 'cursor-migration-preview', surface, label: 'Review previous Telegram cursor',
      description: 'Verify the selected bot and review its unbound saved position before explicit migration.', dangerous: false, metadata: {} },
    { id: 'cursor-migration-commit', surface, label: 'Bind previous Telegram cursor',
      description: 'Confirm that the reviewed saved position belongs to this bot, preserve that position and restart polling.', dangerous: true,
      inputSchema: { type: 'object', properties: { previewId: { type: 'string' }, confirm: { const: true } },
        required: ['previewId', 'confirm'], additionalProperties: false }, metadata: {} },
  );
  return surface === HOME_ASSISTANT_SURFACE
    ? [...actions, ...listHomeAssistantOperatorActions()]
    : actions;
}

/**
 * Every tool whose action is marked dangerous says so in its metadata, so an
 * agent tool bridge can tell the model (and any approval prompt) that the call
 * changes who may reach the agent or acts on something outside the chat.
 */
export function listBuiltinTools(surface: ChannelSurface): ChannelToolDescriptor[] {
  const dangerousActions = new Set(listBuiltinOperatorActions(surface).filter((entry) => entry.dangerous).map((entry) => entry.id));
  return listUnflaggedBuiltinTools(surface).map((tool) => tool.actionIds.some((id) => dangerousActions.has(id))
    ? { ...tool, metadata: { ...tool.metadata, dangerous: true } }
    : tool);
}

function listUnflaggedBuiltinTools(surface: ChannelSurface): ChannelToolDescriptor[] {
  const tools: ChannelToolDescriptor[] = [
    {
      id: `${surface}:account`,
      surface,
      name: `${surface}_account`,
      description: `Inspect account posture for the ${surface} surface.`,
      actionIds: ['inspect-account'],
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:status`,
      surface,
      name: `${surface}_status`,
      description: `Inspect status for the ${surface} surface.`,
      actionIds: ['inspect-status'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:setup_schema`,
      surface,
      name: `${surface}_setup_schema`,
      description: `Return the setup contract for the ${surface} surface.`,
      actionIds: ['setup-schema'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:doctor`,
      surface,
      name: `${surface}_doctor`,
      description: `Run doctor checks for the ${surface} surface.`,
      actionIds: ['doctor'],
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:lifecycle`,
      surface,
      name: `${surface}_lifecycle`,
      description: `Return lifecycle posture for the ${surface} surface.`,
      actionIds: ['lifecycle-state'],
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
        },
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:allowlist_resolve`,
      surface,
      name: `${surface}_allowlist_resolve`,
      description: `Resolve allowlist candidates for the ${surface} surface.`,
      actionIds: ['resolve-allowlist'],
      inputSchema: {
        type: 'object',
        properties: ALLOWLIST_ENTRY_PROPERTIES,
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:allowlist_edit`,
      surface,
      name: `${surface}_allowlist_edit`,
      description: `Edit allowlists for the ${surface} surface.`,
      actionIds: ['edit-allowlist'],
      inputSchema: {
        type: 'object',
        properties: ALLOWLIST_EDIT_PROPERTIES,
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:directory`,
      surface,
      name: `${surface}_directory`,
      description: `Search the ${surface} conversations already known; pass live to search the provider directory too.`,
      actionIds: ['list-directory'],
      inputSchema: DIRECTORY_INPUT_SCHEMA,
      metadata: {},
    },
    {
      id: `${surface}:capabilities`,
      surface,
      name: `${surface}_capabilities`,
      description: `List capability descriptors for the ${surface} surface.`,
      actionIds: ['list-capabilities'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:account_action`,
      surface,
      name: `${surface}_account_action`,
      description: `Run an account lifecycle action (setup, start, stop, login, logout and the rest) for the ${surface} surface; setup takes the surface's credentials and settings.`,
      actionIds: ['account-action'],
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          action: { type: 'string', enum: ['inspect', 'setup', 'retest', 'connect', 'disconnect', 'start', 'stop', 'login', 'logout', 'wait_login'] },
        },
        required: ['action'],
        additionalProperties: true,
      },
      metadata: {},
    },
    {
      id: `${surface}:target`,
      surface,
      name: `${surface}_target`,
      description: `Resolve a ${surface} target into a structured channel destination.`,
      actionIds: ['resolve-target'],
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          input: { type: 'string' },
          preferredKind: { type: 'string' },
          threadId: { type: 'string' },
          accountId: { type: 'string' },
          createIfMissing: { type: 'boolean' },
          live: { type: 'boolean' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      metadata: {},
    },
    {
      id: `${surface}:authorize`,
      surface,
      name: `${surface}_authorize`,
      description: `Check whether a channel actor can run an action on the ${surface} surface.`,
      actionIds: ['authorize-actor-action'],
      inputSchema: {
        type: 'object',
        properties: {
          actorId: { type: 'string' },
          actionId: { type: 'string' },
          accountId: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['actionId'],
        additionalProperties: true,
      },
      metadata: {},
    },
    ...providerOperationsFor(surface).filter((operation) => operation.agentTool).map((operation): ChannelToolDescriptor => {
      const suffix = operation.id.replace(/-/g, '_');
      return {
        id: `${surface}:${suffix}`,
        surface,
        name: `${surface}_${suffix}`,
        description: `${operation.description} (${surface})`,
        actionIds: [operation.id],
        inputSchema: operation.inputSchema,
        metadata: {},
      };
    }),
  ];
  return surface === HOME_ASSISTANT_SURFACE
    ? [...tools, ...listHomeAssistantTools()]
    : tools;
}
