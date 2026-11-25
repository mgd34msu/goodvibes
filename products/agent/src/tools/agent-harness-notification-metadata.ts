import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';
import { resolveNotificationWebhookLocally } from '@goodvibes/engine/platform/platform/integrations';

export interface AgentHarnessNotificationArgs {
  readonly notificationTargetId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

/**
 * `unreadable`: the stored URL could not be read from the secret store (the
 * secret is missing, the store is locked or there is none here), so nothing is
 * known about it; `invalid`: it was read and is not a URL.
 */
type NotificationTargetState = 'valid' | 'invalid' | 'unreadable';

interface NotificationTargetDescriptor {
  readonly id: string;
  readonly index: number;
  readonly state: NotificationTargetState;
  readonly protocol?: string;
  readonly host?: string;
  readonly pathDepth?: number;
  readonly hasQuery?: boolean;
}

type NotificationTargetLookupSource = 'notificationTargetId' | 'target' | 'query';

type NotificationTargetResolution =
  | { readonly status: 'found'; readonly target: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

/** Each configured target's stored URL, or null when it could not be read from the secret store. */
function readConfiguredWebhookUrls(context: CommandContext): readonly (string | null)[] {
  const notifications = context.platform.configManager.getCategory('notifications') as { readonly webhookUrls?: unknown } | null;
  const urls = Array.isArray(notifications?.webhookUrls) ? notifications.webhookUrls : [];
  // Each member is a reference to a stored URL; only its scheme, host and shape are described below.
  return urls
    .filter((url): url is string => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((entry) => resolveNotificationWebhookLocally(entry, context.platform.secretsManager ?? undefined));
}

const UNREADABLE_TARGET_SENTENCE = 'stored webhook URL could not be read from the secret store';

function pathDepth(pathname: string): number {
  return pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
}

function describeWebhookUrl(url: string | null, index: number): NotificationTargetDescriptor {
  const id = `notification-target-${index + 1}`;
  if (url === null) return { id, index: index + 1, state: 'unreadable' };
  try {
    const parsed = new URL(url);
    return {
      id,
      index: index + 1,
      state: 'valid',
      protocol: parsed.protocol.replace(/:$/, ''),
      host: parsed.host,
      pathDepth: pathDepth(parsed.pathname),
      hasQuery: parsed.search.length > 0,
    };
  } catch {
    return {
      id,
      index: index + 1,
      state: 'invalid',
    };
  }
}

function notificationTargets(context: CommandContext): readonly NotificationTargetDescriptor[] {
  return readConfiguredWebhookUrls(context).map(describeWebhookUrl);
}

function lookupFromArgs(args: AgentHarnessNotificationArgs): { readonly source: NotificationTargetLookupSource; readonly input: string } | null {
  const notificationTargetId = readString(args.notificationTargetId);
  if (notificationTargetId) return { source: 'notificationTargetId', input: notificationTargetId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

// These words describe a target and are matched whole: "valid" must not select an
// "invalid" target, nor "query" a "no-query" one.
const TARGET_STATE_WORDS = new Set(['valid', 'invalid', 'unreadable', 'query', 'no-query']);

function targetMatchesQuery(target: NotificationTargetDescriptor, query: string): boolean {
  if (TARGET_STATE_WORDS.has(query)) {
    return query === target.state || (target.hasQuery !== undefined && query === (target.hasQuery ? 'query' : 'no-query'));
  }
  return [target.id, String(target.index), target.protocol ?? '', target.host ?? ''].join('\n').toLowerCase().includes(query);
}

function describeTargetCandidate(target: NotificationTargetDescriptor): Record<string, unknown> {
  return {
    notificationTargetId: target.id,
    index: target.index,
    state: target.state,
    ...(target.state === 'unreadable' ? { note: UNREADABLE_TARGET_SENTENCE } : {}),
    ...(target.host ? { host: target.host } : {}),
    modelRoute: notificationTargetModelRoute(),
  };
}

function notificationTargetModelRoute(): string {
  return 'agent_notify or agent_harness mode:"notification_target"';
}

function describeTarget(
  target: NotificationTargetDescriptor,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: target.id,
    index: target.index,
    state: target.state,
    ...(target.protocol ? { protocol: target.protocol } : {}),
    ...(target.host ? { host: target.host } : {}),
    ...(target.pathDepth !== undefined ? { pathDepth: target.pathDepth } : {}),
    ...(target.hasQuery !== undefined ? { hasQuery: target.hasQuery } : {}),
    value: '<redacted>',
    modelRoute: notificationTargetModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        policy: {
          effect: 'read-only',
          values: 'Full webhook URLs are not returned because they can contain bearer tokens or secret path/query values.',
          delivery: 'Use agent_notify only for one explicit, confirmed notification requested by the user.',
          management: 'Run the notify capabilities (capability_run) only when the user explicitly asks to add, remove, clear, test, or send notification targets.',
          ...(target.state === 'unreadable'
            ? { repair: `This target's ${UNREADABLE_TARGET_SENTENCE}, so nothing is known about it until it reads. Repair the secret store first (unlock it, or restore the stored secret); only if the secret is gone for good does the owner remove this entry by its number and add the URL again.` }
            : {}),
        },
        modelAccess: {
          sendTool: 'agent_notify',
          listCapability: 'notify.list',
          addCapability: 'notify.add',
          removeCapability: 'notify.remove',
          clearCapability: 'notify.clear',
          testCapability: 'notify.test',
          settingsCategory: 'notifications.webhookUrls',
          targetValueRequiredForRemove: false,
          targetValuePolicy: 'notify.remove takes the target\'s number as notify.list shows it, which is this target\'s index; confirm with the user which target before removing it.',
        },
      }
      : {
        summary: previewHarnessText(target.state === 'unreadable'
          ? `notification webhook target ${target.index}: ${UNREADABLE_TARGET_SENTENCE}`
          : `${target.state} notification webhook target ${target.index}`),
      }),
  };
}

function targetStateCounts(targets: readonly NotificationTargetDescriptor[]): Record<string, number> {
  return {
    validTargets: targets.filter((target) => target.state === 'valid').length,
    invalidTargets: targets.filter((target) => target.state === 'invalid').length,
    unreadableTargets: targets.filter((target) => target.state === 'unreadable').length,
  };
}

export function notificationTargetCatalogStatus(context: CommandContext): Record<string, unknown> {
  const targets = notificationTargets(context);
  return {
    modes: ['notifications', 'notification_target'],
    targets: targets.length,
    ...targetStateCounts(targets),
    readOnly: true,
    deliveryTool: 'agent_notify',
    values: 'redacted',
  };
}

export function listHarnessNotificationTargets(context: CommandContext, args: AgentHarnessNotificationArgs): Record<string, unknown> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const targets = notificationTargets(context);
  const filtered = targets
    .filter((target) => !query || targetMatchesQuery(target, query))
    .slice(0, readLimit(args.limit, 100));
  return {
    targets: filtered.map((target) => describeTarget(target, { includeParameters })),
    returned: filtered.length,
    total: targets.length,
    ...targetStateCounts(targets),
    policy: 'Read-only notification target catalog. Full webhook values are redacted; sends and target management require explicit confirmation through the owning tool or slash-command mirror.',
  };
}

export function describeHarnessNotificationTarget(
  context: CommandContext,
  args: AgentHarnessNotificationArgs,
): NotificationTargetResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'notification_target requires notificationTargetId, target, or query. Use mode:"notifications" to inspect configured redacted target refs.',
    };
  }
  const targets = notificationTargets(context);
  const normalized = lookup.input.toLowerCase();
  const exact = targets.find((target) => target.id === lookup.input || String(target.index) === lookup.input);
  if (exact) return { status: 'found', target: describeTarget(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id-or-index' } }) };
  const searched = targets.filter((target) => targetMatchesQuery(target, normalized));
  if (searched.length === 1) {
    return { status: 'found', target: describeTarget(searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeTargetCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown notification target ${lookup.input}. Use mode:"notifications" to inspect configured redacted target refs.`,
  };
}
