import { randomUUID } from 'node:crypto';
import type { DaemonChannelRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import {
  readBoundedPositiveInteger,
  readChannelConversationKind,
  readChannelLifecycleAction,
  type JsonRecord,
} from './route-helpers.js';
import type { ChannelDirectoryScope, ChannelSurface, DaemonChannelRouteContext } from './channel-route-types.js';

/** The free-form input a channel plugin's tool, action or account action reads; the plugin owns its shape. */
async function readOptionalChannelBody(
  context: DaemonChannelRouteContext,
  req: Request,
): Promise<JsonRecord | undefined | Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  return body ?? undefined;
}

const POLICY_BOOLEAN_FIELDS = [
  'enabled',
  'requireMention',
  'allowDirectMessages',
  'allowGroupMessages',
  'allowThreadMessages',
  'allowTextCommandsWithoutMention',
] as const;
const POLICY_MODE_FIELDS = ['dmPolicy', 'groupPolicy'] as const;
const POLICY_LIST_FIELDS = ['allowlistUserIds', 'allowlistChannelIds', 'allowlistGroupIds', 'allowedCommands'] as const;

function invalidPolicyField(field: string, expected: string): Response {
  return jsonErrorResponse(
    { error: `Channel policy field ${field} must be ${expected}; nothing was changed.`, code: 'INVALID_ARGUMENT' },
    { status: 400 },
  );
}

function invalidChannelField(field: string, expected: string): Response {
  return jsonErrorResponse(
    { error: `Field ${field} must be ${expected}; nothing was changed.`, code: 'INVALID_ARGUMENT', category: 'bad_request', status: 400 },
    { status: 400 },
  );
}

/**
 * Refuse a key the route does not read. A misspelled field on an access-control
 * write would otherwise be dropped while the route answered success, and the
 * caller would report a change that was never made. `surface` is the path
 * parameter a gateway invocation folds into the body.
 */
function refuseUnknownKeys(source: JsonRecord, label: string, known: ReadonlySet<string>): Response | null {
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      return jsonErrorResponse({
        error: `Unknown field ${label ? `${label}.${key}` : key}; nothing was changed. Known fields: ${[...known].sort().join(', ')}.`,
        code: 'INVALID_ARGUMENT',
        category: 'bad_request',
        status: 400,
      }, { status: 400 });
    }
  }
  return null;
}

const ALLOWLIST_KINDS = new Set(['user', 'channel', 'group']);
const ALLOWLIST_KEYS = new Set(['surface', 'add', 'remove', 'groupId', 'channelId', 'workspaceId', 'kind', 'metadata']);

interface AllowlistInput {
  readonly add?: string[];
  readonly remove?: string[];
  readonly groupId?: string;
  readonly channelId?: string;
  readonly workspaceId?: string;
  readonly kind?: 'user' | 'channel' | 'group';
  readonly metadata?: Record<string, unknown>;
}

/** Read an allowlist resolve or edit body, refusing a wrongly typed field or an unknown key by name. */
function readAllowlistBody(body: JsonRecord): AllowlistInput | Response {
  const unknown = refuseUnknownKeys(body, '', ALLOWLIST_KEYS);
  if (unknown) return unknown;
  const input: Record<string, unknown> = {};
  for (const key of ['add', 'remove'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return invalidChannelField(key, 'an array of strings');
    input[key] = value;
  }
  for (const key of ['groupId', 'channelId', 'workspaceId'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return invalidChannelField(key, 'a string');
    input[key] = value;
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !ALLOWLIST_KINDS.has(body.kind)) return invalidChannelField('kind', 'one of user, channel or group');
    input.kind = body.kind;
  }
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata)) return invalidChannelField('metadata', 'an object');
    input.metadata = body.metadata;
  }
  return input as AllowlistInput;
}

/**
 * Read the fields of a policy patch, refusing a value of the wrong type instead
 * of coercing it: `"false"` is a non-empty string, so coercing it turned a
 * request to switch direct messages off into one that switched them on, and a
 * misspelled `dmPolicy` was dropped while the route answered 200.
 */
function readPolicyFields(source: JsonRecord, label: string, keys: {
  readonly booleans: readonly string[];
  readonly modes: readonly string[];
  readonly lists: readonly string[];
}): Record<string, unknown> | Response {
  const fields: Record<string, unknown> = {};
  const name = (key: string) => (label ? `${label}.${key}` : key);
  for (const key of keys.booleans) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return invalidPolicyField(name(key), 'true or false');
    fields[key] = value;
  }
  for (const key of keys.modes) {
    const value = source[key];
    if (value === undefined) continue;
    if (value !== 'allow' && value !== 'deny' && value !== 'inherit') return invalidPolicyField(name(key), 'one of allow, deny or inherit');
    fields[key] = value;
  }
  for (const key of keys.lists) {
    const value = source[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return invalidPolicyField(name(key), 'an array of strings');
    fields[key] = value;
  }
  return fields;
}

// Shared by patchChannelPolicy and postChannelPolicy. Excludes `metadata` so
// each caller can place it after its own extra fields (postChannelPolicy
// inserts `groupPolicies` between the fields below and `metadata`).
function buildChannelPolicyPatchFields(body: JsonRecord, extraKeys: readonly string[] = []): Record<string, unknown> | Response {
  const unknown = refuseUnknownKeys(body, '', new Set([...POLICY_KEYS, ...extraKeys]));
  if (unknown) return unknown;
  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
    return invalidPolicyField('metadata', 'an object');
  }
  return readPolicyFields(body, '', { booleans: POLICY_BOOLEAN_FIELDS, modes: POLICY_MODE_FIELDS, lists: POLICY_LIST_FIELDS });
}

const POLICY_KEYS: readonly string[] = ['surface', 'metadata', ...POLICY_BOOLEAN_FIELDS, ...POLICY_MODE_FIELDS, ...POLICY_LIST_FIELDS];
const GROUP_POLICY_BOOLEAN_FIELDS = ['requireMention', 'allowGroupMessages', 'allowThreadMessages', 'allowTextCommandsWithoutMention'] as const;
const GROUP_POLICY_STRING_FIELDS = ['id', 'label', 'groupId', 'channelId', 'workspaceId'] as const;
const GROUP_POLICY_KEYS = new Set<string>(['metadata', ...GROUP_POLICY_STRING_FIELDS, ...GROUP_POLICY_BOOLEAN_FIELDS, ...POLICY_LIST_FIELDS]);

export function createDaemonChannelRouteHandlers(
  context: DaemonChannelRouteContext,
): DaemonChannelRouteHandlers {
  return {
    getSurfaces: () => Response.json({ surfaces: context.surfaceRegistry.list() }),
    getChannelAccounts: () => context.channelPlugins.listAccounts().then((accounts) => Response.json({ accounts })),
    getChannelSurfaceAccounts: (surface) => context.channelPlugins
      .listAccounts(surface as ChannelSurface)
      .then((accounts) => Response.json({ accounts })),
    getChannelAccount: async (surface, accountId) => {
      const account = await context.channelPlugins.getAccount(
        surface as ChannelSurface,
        accountId,
      );
      return account
        ? Response.json(account)
        : jsonErrorResponse({ error: 'Unknown channel account' }, { status: 404 });
    },
    getChannelSetupSchema: async (surface, url) => {
      const schema = await context.channelPlugins.getSetupSchema(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return schema
        ? Response.json(schema)
        : jsonErrorResponse({ error: 'Unknown channel setup schema' }, { status: 404 });
    },
    getChannelDoctor: async (surface, url) => {
      const report = await context.channelPlugins.doctor(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return report
        ? Response.json(report)
        : jsonErrorResponse({ error: 'Unknown channel doctor surface' }, { status: 404 });
    },
    getChannelRepairActions: async (surface, url) => Response.json({
      actions: await context.channelPlugins.listRepairActions(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      ),
    }),
    getChannelLifecycle: async (surface, url) => {
      const state = await context.channelPlugins.getLifecycleState(
        surface as ChannelSurface,
        url.searchParams.get('accountId') ?? undefined,
      );
      return state
        ? Response.json(state)
        : jsonErrorResponse({ error: 'Unknown channel lifecycle surface' }, { status: 404 });
    },
    postChannelAccountAction: async (surface, accountId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const lifecycleAction = readChannelLifecycleAction(action);
      if (!lifecycleAction) {
        return jsonErrorResponse({ error: 'Unknown channel account action' }, { status: 400 });
      }
      const result = await context.channelPlugins.runAccountAction(
        surface as ChannelSurface,
        lifecycleAction,
        accountId ?? (typeof input?.accountId === 'string' ? input.accountId : undefined),
        input,
      );
      return result !== null
        ? Response.json({ surface, accountId, action: lifecycleAction, result })
        : jsonErrorResponse({ error: 'Unknown channel account action' }, { status: 404 });
    },
    getChannelCapabilities: () => context.channelPlugins.listCapabilities().then((capabilities) => Response.json({ capabilities })),
    getChannelSurfaceCapabilities: (surface) => context.channelPlugins
      .listCapabilities(surface as ChannelSurface)
      .then((capabilities) => Response.json({ capabilities })),
    getChannelTools: () => context.channelPlugins.listTools().then((tools) => Response.json({ tools })),
    getChannelSurfaceTools: (surface) => context.channelPlugins
      .listTools(surface as ChannelSurface)
      .then((tools) => Response.json({ tools })),
    getChannelAgentTools: () => Response.json({ tools: context.channelPlugins.listAgentTools().map((tool) => tool.definition) }),
    getChannelSurfaceAgentTools: (surface) => Response.json({
      tools: context.channelPlugins
        .listAgentTools(surface as ChannelSurface)
        .map((tool) => tool.definition),
    }),
    postChannelTool: async (surface, toolId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.runTool(
        surface as ChannelSurface,
        toolId,
        input,
      );
      return result !== null
        ? Response.json({ toolId, surface, result })
        : jsonErrorResponse({ error: 'Unknown channel tool' }, { status: 404 });
    },
    getChannelActions: () => context.channelPlugins.listOperatorActions().then((actions) => Response.json({ actions })),
    getChannelSurfaceActions: (surface) => context.channelPlugins
      .listOperatorActions(surface as ChannelSurface)
      .then((actions) => Response.json({ actions })),
    postChannelAction: async (surface, actionId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const input = await readOptionalChannelBody(context, req);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.runOperatorAction(
        surface as ChannelSurface,
        actionId,
        input,
      );
      return result !== null
        ? Response.json({ actionId, surface, result })
        : jsonErrorResponse({ error: 'Unknown channel action' }, { status: 404 });
    },
    postChannelResolveTarget: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const targetInput = typeof body.target === 'string'
        ? body.target
        : typeof body.input === 'string'
          ? body.input
          : typeof body.query === 'string'
            ? body.query
            : '';
      if (!targetInput.trim()) {
        return jsonErrorResponse({ error: 'Target resolution requires target, input, or query.' }, { status: 400 });
      }
      const preferredKind = readChannelConversationKind(body.preferredKind);
      const target = await context.channelPlugins.resolveTarget(
        surface as ChannelSurface,
        {
          input: targetInput,
          ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
          ...(preferredKind ? { preferredKind } : {}),
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body.createIfMissing === 'boolean' ? { createIfMissing: body.createIfMissing } : {}),
          ...(typeof body.live === 'boolean' ? { live: body.live } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return target
        ? Response.json({ surface, target })
        : jsonErrorResponse({ error: 'Unable to resolve channel target' }, { status: 404 });
    },
    postChannelAuthorize: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const target = typeof body.target === 'string' && body.target.trim()
        ? await context.channelPlugins.resolveTarget(
            surface as ChannelSurface,
            {
              input: body.target,
              ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
              createIfMissing: true,
            },
          )
        : null;
      // The catalog declares `actionId` required, and the invoke gate refuses a
      // call without it, but this REST path used to substitute the literal
      // 'unknown' and go on to evaluate authorization against it. So the two
      // routes to the same verb disagreed: one refused, one authorized a
      // made-up action id. Refusing here makes the served behaviour match the
      // contract that was already published, rather than deciding a policy.
      const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';
      if (!actionId) {
        return jsonErrorResponse({ error: 'actionId is required.' }, { status: 400 });
      }
      // A target the caller named that does not resolve is not "authorized with
      // no target": the check would otherwise answer for a different question
      // than the one asked.
      if (typeof body.target === 'string' && body.target.trim() && !target) {
        return jsonErrorResponse({ error: `Unable to resolve channel target ${body.target.trim()}; the authorization check was not run.`, code: 'CHANNEL_TARGET_NOT_FOUND' }, { status: 404 });
      }
      const result = await context.channelPlugins.authorizeActorAction(
        surface as ChannelSurface,
        {
          actionId,
          ...(typeof body.actorId === 'string' ? { actorId: body.actorId } : {}),
          ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
          ...(target ? { target } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        },
      );
      return result
        ? Response.json({ surface, result })
        : jsonErrorResponse({ error: 'Unable to authorize channel action' }, { status: 404 });
    },
    postChannelAllowlistResolve: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = readAllowlistBody(body);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.resolveAllowlist(surface as ChannelSurface, input);
      return result
        ? Response.json(result)
        : jsonErrorResponse({ error: 'Unknown channel allowlist surface' }, { status: 404 });
    },
    postChannelAllowlistEdit: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = readAllowlistBody(body);
      if (input instanceof Response) return input;
      const result = await context.channelPlugins.editAllowlist(surface as ChannelSurface, input);
      return result
        ? Response.json(result)
        : jsonErrorResponse({ error: 'Unknown channel allowlist surface' }, { status: 404 });
    },
    getChannelPolicies: () => Response.json({ policies: context.channelPolicy.listPolicies() }),
    patchChannelPolicy: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const fields = buildChannelPolicyPatchFields(body);
      if (fields instanceof Response) return fields;
      const updated = await context.channelPolicy.upsertPolicy(surface as ChannelSurface, {
        ...fields,
        ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return Response.json(updated);
    },
    postChannelPolicy: async (surface, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const fields = buildChannelPolicyPatchFields(body, ['groupPolicies']);
      if (fields instanceof Response) return fields;
      let groupPolicies: Record<string, unknown>[] | undefined;
      if (body.groupPolicies !== undefined) {
        if (!Array.isArray(body.groupPolicies)) return invalidPolicyField('groupPolicies', 'an array of group policy objects');
        groupPolicies = [];
        for (const [index, value] of body.groupPolicies.entries()) {
          const label = `groupPolicies[${index}]`;
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidPolicyField(label, 'an object');
          const entry = value as JsonRecord;
          const unknown = refuseUnknownKeys(entry, label, GROUP_POLICY_KEYS);
          if (unknown) return unknown;
          for (const key of GROUP_POLICY_STRING_FIELDS) {
            if (entry[key] !== undefined && typeof entry[key] !== 'string') return invalidPolicyField(`${label}.${key}`, 'a string');
          }
          if (entry.metadata !== undefined && (typeof entry.metadata !== 'object' || entry.metadata === null || Array.isArray(entry.metadata))) {
            return invalidPolicyField(`${label}.metadata`, 'an object');
          }
          const checked = readPolicyFields(entry, label, { booleans: GROUP_POLICY_BOOLEAN_FIELDS, modes: [], lists: POLICY_LIST_FIELDS });
          if (checked instanceof Response) return checked;
          groupPolicies.push({
            // use the full UUID to avoid birthday-paradox collisions at scale.
            id: typeof entry.id === 'string' ? entry.id : `group-policy-${randomUUID()}`,
            ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
            ...(typeof entry.groupId === 'string' ? { groupId: entry.groupId } : {}),
            ...(typeof entry.channelId === 'string' ? { channelId: entry.channelId } : {}),
            ...(typeof entry.workspaceId === 'string' ? { workspaceId: entry.workspaceId } : {}),
            ...checked,
            ...(entry.metadata !== undefined ? { metadata: entry.metadata as Record<string, unknown> } : {}),
          });
        }
      }
      const updated = await context.channelPolicy.upsertPolicy(surface as ChannelSurface, {
        ...fields,
        ...(groupPolicies ? { groupPolicies } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return Response.json(updated);
    },

    getChannelPolicyAudit: (limit) => Response.json({ audit: context.channelPolicy.listAudit(limit) }),
    // Channels AND inbound mail, on one surface.
    //
    // `channels` keeps its exact shape so nothing consuming it changes.
    // `health` is the unified answer to "is anything that receives messages
    // working": every channel tagged `kind: 'channel'`, plus inbound mail
    // under its own `kind`. Email is deliberately NOT forced into
    // `ChannelStatusSnapshot`, its states describe what a watcher is doing
    // rather than whether a credential is present, and flattening the two
    // would either lie or dilute the channel model. A discriminated union is
    // what the `kind` field was declared for.
    getChannelStatus: () => context.channelPlugins.listStatus().then((channels) => {
      const inboundMail = context.inboundMailHealth?.() ?? null;
      return Response.json({
        channels,
        health: [
          ...channels.map((entry) => ({ kind: 'channel' as const, channel: entry })),
          ...(inboundMail === null ? [] : [inboundMail]),
        ],
      });
    }),
    getChannelDirectory: (surface, url) => context.channelPlugins.queryDirectory(
      surface as ChannelSurface,
      {
        query: url.searchParams.get('q') ?? '',
        ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope') as ChannelDirectoryScope } : {}),
        ...(url.searchParams.get('groupId') ? { groupId: url.searchParams.get('groupId') as string } : {}),
        ...(url.searchParams.get('limit') ? { limit: readBoundedPositiveInteger(url.searchParams.get('limit'), 100) } : {}),
        ...(url.searchParams.get('live') ? { live: url.searchParams.get('live') === 'true' } : {}),
      },
    ).then((entries) => Response.json({ entries })),
  };
}
