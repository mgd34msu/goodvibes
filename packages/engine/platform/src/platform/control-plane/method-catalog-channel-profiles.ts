/**
 * method-catalog-channel-profiles.ts
 *
 * Contract descriptors for the per-channel profile binding verbs
 * (channels.profiles.list / get / set / delete). These expose the
 * ChannelProfileRegistry (../../channel-profiles) over the operator surface so a
 * channel can bind the model/provider and permission-mode defaults applied to
 * the sessions it originates.
 *
 * Which applies when both name a channel: these bindings are the only values
 * the daemon applies to a session it originates from a channel message. The
 * channels.routing.* table maps a channel to a named profile id that the
 * surface owning the profile resolves; the daemon carries that id on the
 * inbound item and applies none of it. The descriptions below say so, so a
 * caller asking "what model does this channel get" reads one answer.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  JSON_VALUE_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import { METADATA_SCHEMA } from './operator-contract-schemas-shared.js';
import { OWNER_APPROVAL_PENDING_SCHEMA } from './operator-contract-schemas-admin.js';
import { CHANNEL_PERMISSION_MODES } from '../channel-profiles/types.js';

const CHANNEL_PERMISSION_MODE_SCHEMA = { type: 'string', enum: CHANNEL_PERMISSION_MODES } as const;

/** One channel→profile binding record. */
export const CHANNEL_PROFILE_BINDING_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  permissionMode: CHANNEL_PERMISSION_MODE_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
  // Present when the stored row holds a value this build cannot use: that
  // field is left out of every resolution until the binding is set again or deleted.
  invalid: objectSchema({
    field: { type: 'string', enum: ['permissionMode'] },
    value: JSON_VALUE_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['field', 'value', 'reason']),
}, ['id', 'surfaceKind', 'updatedAt']);

/** What a channel's sessions get: each field merged from the channel binding and the surface-wide one, and the binding id that supplied it. */
const CHANNEL_PROFILE_EFFECTIVE_SCHEMA = objectSchema({
  profile: objectSchema({
    model: STRING_SCHEMA,
    provider: STRING_SCHEMA,
    permissionMode: CHANNEL_PERMISSION_MODE_SCHEMA,
  }, []),
  sources: objectSchema({
    model: STRING_SCHEMA,
    provider: STRING_SCHEMA,
    permissionMode: STRING_SCHEMA,
  }, []),
}, ['profile', 'sources']);

export const CHANNEL_PROFILES_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const CHANNEL_PROFILES_LIST_OUTPUT_SCHEMA = listOutputSchema('bindings', CHANNEL_PROFILE_BINDING_SCHEMA);

export const CHANNEL_PROFILES_GET_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_GET_OUTPUT_SCHEMA = objectSchema({
  binding: CHANNEL_PROFILE_BINDING_SCHEMA,
  effective: CHANNEL_PROFILE_EFFECTIVE_SCHEMA,
}, ['binding', 'effective']);

export const CHANNEL_PROFILES_SET_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  permissionMode: CHANNEL_PERMISSION_MODE_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_SET_OUTPUT_SCHEMA = { anyOf: [entityOutputSchema('binding', CHANNEL_PROFILE_BINDING_SCHEMA), OWNER_APPROVAL_PENDING_SCHEMA] };

export const CHANNEL_PROFILES_DELETE_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_DELETE_OUTPUT_SCHEMA = { anyOf: [objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
}, ['surfaceKind', 'deleted']), OWNER_APPROVAL_PENDING_SCHEMA] };

export const builtinGatewayChannelProfilesMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'channels.profiles.list',
    title: 'List Channel Profile Bindings',
    description: 'Return every per-channel profile binding: the model, provider and permission-mode defaults the daemon applies to the sessions each channel originates. These are the values that apply; a channels.routing assignment for the same channel names a profile that only the surface owning it resolves.',
    category: 'channels',
    effects: ['channels.read'],
    http: { method: 'GET', path: '/api/channels/profiles' },
    inputSchema: CHANNEL_PROFILES_LIST_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.get',
    title: 'Get Channel Profile Binding',
    description: 'Return the profile binding for a channel (surfaceKind plus optional channelId) and `effective`: what a session that channel originates gets, each field merged from this binding and the surface-wide one, with `sources` naming the binding id that supplied each field. Returns 404 when no binding for that exact key exists. A listed or returned binding with `invalid` holds a value this build cannot use; that field is left out until the binding is set again or deleted.',
    category: 'channels',
    effects: ['channels.read'],
    http: { method: 'GET', path: '/api/channels/profiles/{surfaceKind}' },
    inputSchema: CHANNEL_PROFILES_GET_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.set',
    repeat: 'safe',
    title: 'Bind Channel Profile',
    description: 'Bind (upsert) the model/provider and permission-mode defaults for a channel. Keyed on (surfaceKind, channelId?): field by field, a channelId-scoped binding wins over the surface-wide default; setting the same key again replaces it. A session the daemon originates from the channel uses these values whatever a channels.routing assignment names. A set that loosens the permission mode the channel\'s sessions run under (against the mode they get now, the host\'s when no binding sets one; leaving permissionMode out of a set removes the key\'s own mode) is the owner\'s own act, as sessions.permissionMode.set is: from a caller who is not the owner it is put to the owner and answers 202 OWNER_APPROVAL_PENDING with approvalId, followable, the current binding, mode, requestedMode, state and next, and applies when the owner approves it; with no approval path it is 403 OWNER_ONLY and nothing is changed.',
    category: 'channels',
    effects: ['channels.administer'],
    http: { method: 'POST', path: '/api/channels/profiles' },
    inputSchema: CHANNEL_PROFILES_SET_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.delete',
    repeat: 'safe',
    effects: ['channels.administer', 'record.destroy'],
    title: 'Unbind Channel Profile',
    description: 'Remove a channel profile binding. Returns { deleted: false } when no binding for that key existed, an honest boolean, never a phantom removal. Removing a binding whose permission mode is tighter than the one its channel\'s sessions would fall back to (the surface-wide binding\'s, else the host\'s) loosens it, which is the owner\'s own act: from a caller who is not the owner it answers 202 OWNER_APPROVAL_PENDING and is removed when the owner approves it; with no approval path it is 403 OWNER_ONLY.',
    category: 'channels',
    http: { method: 'DELETE', path: '/api/channels/profiles/{surfaceKind}' },
    inputSchema: CHANNEL_PROFILES_DELETE_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_DELETE_OUTPUT_SCHEMA,
    dangerous: true,
  }),
];
