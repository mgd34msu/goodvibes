import type { CommandContext } from '../input/command-registry.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { dirname } from 'node:path';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';
import { captureAgentExportPath } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { harnessCatalogInvocationAuthority, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { resolveChannelDraftNativeReference } from './agent-channel-draft-reference.ts';
import { captureOperatorConnection } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { agentCallConnection, forgetDelegatedCredential } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger, labelUntrustedContent } from '../trust/untrusted-content.ts';
import { screenOutboundForCardMaterial, CardMaterialRefusedError } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import {
  aggregateUnifiedInbox,
  fetchInboundChannelFeed,
  formatUnifiedInbox,
  unifiedInboxThirdPartyText,
} from '../agent/unified-inbox.ts';
import {
  listDrafts,
  getDraft,
  saveDraft,
  queueDraftToSend,
  markDraftSent,
  markDraftFailed,
  fetchDaemonDraft,
  fetchDaemonDrafts,
  mergeDraftViews,
  type ChannelDraft,
  formatChannelDraftList,
  formatChannelDraft,
  channelDraftFilePath,
  syncChannelDrafts,
  CHANNEL_DRAFTS_SAVE_METHOD,
  type ChannelDraftWebhookSecrets,
} from '../agent/channel-draft.ts';
import {
  listChannelProfileRoutes,
  getProfileForChannel,
  assignChannelToProfile,
  removeChannelProfileRouteEverywhere,
  formatChannelProfileRoutes,
  CHANNEL_ROUTING_ASSIGN_METHOD,
  CHANNEL_ROUTING_DELETE_METHOD,
  channelProfileRouteFilePath,
} from '../agent/channel-profile-routing.ts';
import { buildAgentWorkspaceChannelTriage } from '../input/agent-workspace-channel-triage.ts';
import { deliverAgentChannelMessage } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { requireConfirmedAction, type EffectResult } from './agent-harness-tool-utils.ts';
import { harnessDisplayPath } from './agent-harness-display-path.ts';
import {
  createDaemonOperatorInvoke,
  resolveDaemonOperatorConnection,
  type DaemonOperatorInvoke,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/**
 * The connected-host caller for the comms modes, or null when this shell has
 * no platform to resolve one from.
 *
 * Null is not a failure state, it is a shell (a test harness, an early boot)
 * with no daemon address to call. The stores treat it as "not offered" rather
 * than as a daemon that refused, because those are different facts.
 */
function commsDaemonInvoke(context: CommandContext): DaemonOperatorInvoke | null {
  const configManager = context.platform?.configManager;
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory;
  if (!configManager || !homeDirectory) return null;
  return createDaemonOperatorInvoke(() =>
    resolveDaemonOperatorConnection(configManager, homeDirectory));
}

/**
 * Where a draft's webhook URL is kept: the shell's secret store, or none.
 * A shell with none refuses to save a webhook rather than write it to the draft file.
 */
function commsWebhookSecrets(context: CommandContext): ChannelDraftWebhookSecrets | undefined {
  const secrets = context.platform?.secretsManager;
  if (!secrets || typeof secrets.get !== 'function' || typeof secrets.set !== 'function') return undefined;
  return {
    get: (key) => secrets.get(key),
    set: (key, value) => secrets.set(key, value),
    ...(typeof secrets.delete === 'function' ? { delete: (key: string) => secrets.delete(key) } : {}),
  };
}

function captureCommsEffect(context: CommandContext, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  target: typeof channelDraftFilePath, outward = false) {
  const workspace = context.workspace;
  const paths = workspace.shellPaths;
  if (!paths) throw new ToolInputProjectionError('held');
  const local = captureHarnessLocalEffect(context, args, options, source => [target(source)]);
  const home = paths.homeDirectory, directory = paths.workingDirectory;
  const resolveUserPath = paths.resolveUserPath, resolveProjectPath = paths.resolveProjectPath, destination = target(paths);
  const parent = captureAgentExportPath(home, dirname(destination));
  const ledger = getSessionUntrustedContentLedger();
  const ledgerRevision = ledger.getPublicationRevision();
  const signature = () => JSON.stringify(captureCatalogData([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]));
  const source = signature();
  const assertSourceCurrent = () => {
    options?.signal?.throwIfAborted();
    if (context.workspace !== workspace || workspace.shellPaths !== paths || paths.homeDirectory !== home || paths.workingDirectory !== directory
      || paths.resolveUserPath !== resolveUserPath || paths.resolveProjectPath !== resolveProjectPath || target(paths) !== destination
      || getSessionUntrustedContentLedger() !== ledger || ledger.getPublicationRevision() !== ledgerRevision
      || signature() !== source) throw new ToolInputProjectionError('stale');
    parent.assertCurrent(destination);
  };
  const assertCurrent = () => {
    local();
    if (outward && !harnessCatalogInvocationAuthority(args, options, 'send')) throw new ToolInputProjectionError('held');
    assertSourceCurrent();
  };
  assertCurrent();
  retainHarnessCatalogCurrent(args)(assertSourceCurrent, 'agent.comms.effect-owner');
  return { assertCurrent, assertSourceCurrent, ledger, paths };
}

function guardedCommsInvoke(context: CommandContext, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  owner: ReturnType<typeof captureCommsEffect>, nativeReference?: ReturnType<typeof resolveChannelDraftNativeReference>): DaemonOperatorInvoke | null {
  owner.assertCurrent();
  const platform = context.platform, config = platform?.configManager, paths = context.workspace.shellPaths;
  if (!config || !paths) return null;
  const assertCurrent = () => {
    owner.assertCurrent();
    if (context.platform !== platform || platform.configManager !== config || context.workspace.shellPaths !== paths
      || !harnessCatalogInvocationAuthority(args, options, 'send')) throw new ToolInputProjectionError('held');
  };
  const connection = captureOperatorConnection(paths, config, assertCurrent);
  return async (method, input = {}, supplied = {}) => {
    assertCurrent();
    if (method !== CHANNEL_DRAFTS_SAVE_METHOD && method !== CHANNEL_ROUTING_ASSIGN_METHOD && method !== CHANNEL_ROUTING_DELETE_METHOD) throw new ToolInputProjectionError('held');
    const { confirm: _confirm, explicitUserRequest: _request, admission: _admission, ...request } = input;
    // A pre-field draft is captured under its one-time historical label; the first save adopts the daemon's
    // canonical label, and every later save in this call (the delivery outcome) must use that label.
    const adopted = nativeReference ? getDraft(paths, nativeReference.draftId)?.wireReference : undefined;
    if (nativeReference && (method !== CHANNEL_DRAFTS_SAVE_METHOD
      || (request.id !== nativeReference.draftId && request.id !== nativeReference.reference && request.id !== adopted))) {
      throw new ToolInputProjectionError('held');
    }
    const nativeInput = { ...request, ...(nativeReference ? { id: adopted ?? nativeReference.reference } : {}) };
    assertCurrent();
    const payload = JSON.stringify(nativeInput);
    const refusal = await screenOutboundForCardMaterial({ surface: 'connected-host', message: payload }, { signal: options?.signal, assertCurrent });
    assertCurrent();
    if (refusal) throw new CardMaterialRefusedError(refusal);
    const decision = await evaluateOutwardEffect({ request: { toolName: 'agent_harness', action: method, description: 'synchronizing a channel draft or routing assignment' },
      ledger: owner.ledger, content: { payload }, taintOptions: { signal: options?.signal } });
    assertCurrent();
    if (!decision.allowed) throw new Error([decision.reason ?? 'Outward channel synchronization held.', decision.fix].filter(Boolean).join(' '));
    const { explicitUserRequest: _userRequest, ...restrictions } = supplied;
    // A draft or routing write the Agent makes for the owner: the one rule (agent-call-credential.ts)
    // sends it with this Agent's delegated credential, and the host judges it as the Agent acting for the owner.
    const { connection: sending, delegated } = await agentCallConnection(connection, method, 'agent', paths.homeDirectory, options?.signal);
    const result = await createDaemonOperatorInvoke(() => sending)(method, nativeInput, { ...restrictions, signal: options?.signal,
      assertCurrent: () => { supplied.assertCurrent?.(); assertCurrent(); } });
    // A delegated credential the host no longer accepts is forgotten; the next call makes a new one.
    if (!result.ok && result.refusal?.code === 'auth_rejected' && delegated) await forgetDelegatedCredential(delegated).catch(() => {});
    return result;
  };
}

/**
 * A draft id the local file does not hold: one only the daemon holds, composed
 * on another surface. The daemon serves its text to the owner's credential, so
 * it can be read here and `channel_draft_send` brings it into this outbox.
 */
async function daemonOnlyDraft(context: CommandContext, draftId: string): Promise<ChannelDraft | null> {
  const invoke = commsDaemonInvoke(context);
  if (!invoke) return null;
  // A direct lookup: the list is capped, so a draft past its first page would read as missing.
  const result = await fetchDaemonDraft(invoke, draftId);
  return 'draft' in result && result.draft ? redactDraftWebhook(result.draft) : null;
}

const DAEMON_DRAFT_TEXT_WITHHELD = 'the daemon serves a draft\'s text only to the owner\'s credential, and this Agent is not connected with it, so its text cannot be read or sent from here. Connect this Agent with the owner\'s pairing, or send it from the surface that composed it.';

/** Redact a draft's webhook (which can embed a token) in any structured display payload. */
function redactDraftWebhook<T extends { readonly webhook?: string; readonly webhookSecretKey?: string }>(draft: T): T {
  if (!draft.webhook && !draft.webhookSecretKey) return draft;
  const { webhookSecretKey: _key, ...rest } = draft;
  return { ...rest, webhook: '[redacted]' } as T;
}

export interface AgentHarnessCommsArgs {
  readonly draftId?: unknown;
  readonly draftStatus?: unknown;
  readonly draftTitle?: unknown;
  readonly draftMessage?: unknown;
  readonly draftChannel?: unknown;
  readonly draftRoute?: unknown;
  readonly assignmentId?: unknown;
  readonly draftWebhook?: unknown;
  readonly draftLink?: unknown;
  readonly draftTags?: unknown;
  readonly surfaceKind?: unknown;
  readonly profileId?: unknown;
  readonly routeLabel?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v) => typeof v === 'string').map((v) => (v as string).trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

// ---------------------------------------------------------------------------
// INBOX, unified_inbox
// ---------------------------------------------------------------------------

export async function unifiedInboxSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown>> {
  const triage = await buildAgentWorkspaceChannelTriage(context, {});
  const limit = readLimit(args.limit, 50);
  const invoke = commsDaemonInvoke(context);
  const inboundChannelFeed = invoke
    ? await fetchInboundChannelFeed(invoke, { limit })
    : undefined;
  const inbox = aggregateUnifiedInbox(triage, {
    limit,
    ...(inboundChannelFeed ? { inboundChannelFeed } : {}),
  });
  // Message bodies, subjects, senders and delivery errors were written by others.
  // They are returned only inside the untrusted envelope and recorded as read, so
  // the outward-effect guard sees this turn ingested third-party text.
  const thirdPartyText = unifiedInboxThirdPartyText(inbox);
  if (thirdPartyText) {
    getSessionUntrustedContentLedger().record({
      surface: 'channel-message',
      origin: 'unified inbox',
      at: new Date().toISOString(),
      content: thirdPartyText,
    });
  }
  return {
    mode: 'unified_inbox',
    status: inbox.status,
    summary: inbox.summary,
    // Daemon-supplied text (error detail, message items) is withheld from the bare
    // structured fields; it is carried only in `untrusted` and `formatted`.
    sources: inbox.sources.map(({ error: _error, ...source }) => source),
    routeBindingItems: inbox.routeBindingItems,
    inboundChannelFeed: inbox.inboundChannelFeed.available
      ? { available: true, methodId: inbox.inboundChannelFeed.methodId, total: inbox.inboundChannelFeed.total, truncated: inbox.inboundChannelFeed.truncated }
      : { available: false, methodId: inbox.inboundChannelFeed.methodId, reason: inbox.inboundChannelFeed.reason },
    // The third-party text goes to the model once, in `untrusted`; `formatted` names where it is.
    formatted: formatUnifiedInbox(inbox, { thirdParty: 'elsewhere' }),
    untrusted: labelUntrustedContent({ surface: 'channel-message', origin: 'unified inbox', text: thirdPartyText }),
    policy: inbox.policy,
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_drafts (read)
// ---------------------------------------------------------------------------

export async function channelDraftsSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Promise<Record<string, unknown>> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      mode: 'channel_drafts',
      status: 'unavailable',
      drafts: [],
      policy: 'Draft management requires an active Agent workspace with shell path context.',
    };
  }
  const draftId = readOptString(args.draftId || args.target || args.query);
  if (draftId) {
    const draft = getDraft(shellPaths, draftId);
    if (!draft) {
      const held = await daemonOnlyDraft(context, draftId);
      if (held?.bodyUnavailable) {
        return {
          mode: 'channel_drafts',
          status: 'daemon_only',
          draftId,
          draft: held,
          policy: `Draft ${draftId} is held by the daemon only; ${DAEMON_DRAFT_TEXT_WITHHELD}`,
        };
      }
      if (held) {
        return {
          mode: 'channel_drafts',
          status: 'found',
          origin: 'daemon',
          draft: held,
          formatted: formatChannelDraft(held),
          next: { send: `agent_harness mode:"channel_draft_send" draftId:"${draftId}"` },
          policy: `Draft ${draftId} was composed on another surface and is held by the daemon; channel_draft_send brings it into this outbox and sends it.`,
        };
      }
      return {
        mode: 'channel_drafts',
        status: 'not_found',
        draftId,
        policy: 'Draft not found in the local mirror or the daemon store. Use channel_drafts without draftId to list all drafts.',
      };
    }
    return {
      mode: 'channel_drafts',
      status: 'found',
      draft: redactDraftWebhook(draft),
      formatted: formatChannelDraft(draft),
      routes: {
        send: 'agent_harness mode:"channel_draft_send" draftId:"' + draft.id + '"',
      },
      policy: 'Read-only draft inspection. Use channel_draft_send to queue and deliver.',
    };
  }
  const statusFilter = readOptString(args.draftStatus) as 'draft' | 'queued' | 'sent' | 'failed' | undefined;
  const limit = readLimit(args.limit, 50);
  // No limit here: the merged list is cut once, after both stores are joined, so `total` counts what exists.
  const snapshot = listDrafts(shellPaths, { status: statusFilter });

  // The daemon's store is what the other surfaces are looking at, so the list
  // an operator sees here is both stores merged. A daemon that will not serve
  // them is reported rather than silently reducing this to the local view.
  const invoke = commsDaemonInvoke(context);
  const daemonResult = invoke
    ? await fetchDaemonDrafts(invoke, { ...(statusFilter ? { status: statusFilter } : {}), limit })
    : null;
  const daemonDrafts = daemonResult && 'drafts' in daemonResult ? daemonResult.drafts : [];
  const all = mergeDraftViews(daemonDrafts, snapshot.drafts);
  // The daemon can hold more than it was asked for; add the ones not fetched so a long list never reads as complete.
  const daemonUnfetched = daemonResult && 'drafts' in daemonResult ? Math.max(0, daemonResult.total - daemonResult.drafts.length) : 0;
  const shownPath = harnessDisplayPath(snapshot.path, shellPaths.homeDirectory);
  const merged = all.slice(0, limit);
  const pendingDrafts = snapshot.drafts.filter((draft) => draft.daemonSyncState === 'pending');

  return {
    mode: 'channel_drafts',
    status: merged.length > 0 ? 'ready' : 'empty',
    path: shownPath,
    total: all.length + daemonUnfetched,
    returned: merged.length,
    drafts: merged.map(redactDraftWebhook),
    formatted: formatChannelDraftList({ ...snapshot, path: shownPath, drafts: merged }),
    daemon: daemonResult === null
      ? { available: false, reason: 'not_attempted' }
      : 'drafts' in daemonResult
        ? { available: true, count: daemonResult.drafts.length, total: daemonResult.total }
        : { available: false, reason: daemonResult.kind, detail: daemonResult.error },
    routes: {
      save: 'agent_harness mode:"channel_draft_save"',
      send: 'agent_harness mode:"channel_draft_send" draftId:"<id>"',
    },
    ...(pendingDrafts.length > 0 ? {
      pendingSync: {
        count: pendingDrafts.length,
        ids: pendingDrafts.map((draft) => draft.id),
        // A list is a read and never sends draft text out; the Agent offers these when it next attaches to the daemon.
        next: 'Nothing to do: these drafts are offered to the daemon automatically the next time this Agent attaches to it, then every surface shows them.',
      },
    } : {}),
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    policy: daemonResult !== null && 'drafts' in daemonResult
      ? 'Read-only draft list, merged from the daemon store and the local mirror. Use channel_draft_save to create or update. Use channel_draft_send to deliver.'
      : 'Read-only draft list from the local mirror; the daemon store could not be read, so drafts composed on other surfaces are not shown. Use channel_draft_save to create or update. Use channel_draft_send to deliver.',
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_draft_save (effect)
// ---------------------------------------------------------------------------

export async function channelDraftSaveHandoff(
  context: CommandContext,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<EffectResult | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel draft save');
  if (confirmationError) return confirmationError;

  const message = readString(args.draftMessage);
  if (!message) return 'channel_draft_save requires draftMessage.';

  const owner = captureCommsEffect(context, args, options, channelDraftFilePath);
  const shellPaths = owner.paths;
  const invoke = guardedCommsInvoke(context, args, options, owner);
  const result = await saveDraft(
    shellPaths,
    {
      id: readOptString(args.draftId),
      message,
      title: readOptString(args.draftTitle),
      channel: readOptString(args.draftChannel),
      route: readOptString(args.draftRoute),
      webhook: readOptString(args.draftWebhook),
      link: readOptString(args.draftLink),
      tags: readStringArray(args.draftTags),
    },
    { ...(invoke ? { invoke } : {}), webhookSecrets: commsWebhookSecrets(context), signal: options?.signal, assertCurrent: owner.assertCurrent, explicitUserRequest: false },
  );
  owner.assertCurrent();

  return {
    mode: 'channel_draft_save',
    status: 'saved',
    done: true,
    draft: redactDraftWebhook(result.draft),
    path: harnessDisplayPath(result.path, shellPaths.homeDirectory),
    daemon: result.daemon,
    routes: {
      send: 'agent_harness mode:"channel_draft_send" draftId:"' + result.draft.id + '"',
      list: 'agent_harness mode:"channel_drafts"',
    },
    policy: result.daemon.synced
      ? 'Draft held by the daemon and mirrored locally. Use channel_draft_send under current recorded admission to deliver.'
      : `Draft saved locally; the daemon does not hold it yet (${result.daemon.error}). It is offered to the daemon automatically when this Agent next attaches to it. Use channel_draft_send under current recorded admission to deliver.`,
  };
}

// ---------------------------------------------------------------------------
// DRAFTS, channel_draft_send (effect)
// ---------------------------------------------------------------------------

export async function channelDraftSendHandoff(
  context: CommandContext,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<EffectResult | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel draft send');
  if (confirmationError) return confirmationError;
  const nativeReference = resolveChannelDraftNativeReference(args, options);

  const draftId = nativeReference?.draftId ?? readString(args.draftId || args.target);
  if (!draftId) return 'channel_draft_send requires draftId.';
  const publicReference = nativeReference?.reference ?? draftId;
  const publicText = (text: string) => nativeReference?.publicText(text) ?? text;
  const publicDraft = (draft: NonNullable<ReturnType<typeof getDraft>>) => ({
    ...redactDraftWebhook(draft), id: publicReference,
    ...(draft.syncError ? { syncError: publicText(draft.syncError) } : {}),
    ...(draft.sendError ? { sendError: publicText(draft.sendError) } : {}),
    ...(draft.sentResponseId ? { sentResponseId: publicText(draft.sentResponseId) } : {}),
  });

  const owner = captureCommsEffect(context, args, options, channelDraftFilePath, true);
  const shellPaths = owner.paths;
  // A draft only the daemon holds is brought into this outbox by the send itself (queueDraftToSend).
  if (!getDraft(shellPaths, draftId) && !commsDaemonInvoke(context)) {
    return publicText(`Draft not found: ${draftId}. Use channel_drafts without draftId to list all drafts.`);
  }
  const router = context.platform.channelDeliveryRouter;
  if (!router) {
    return 'Channel delivery router is not available. Ensure the Agent is connected to a channel delivery service.';
  }

  const deliver = router.deliver, listStrategies = router.listStrategies;
  const listed = listStrategies.call(router);
  const strategies = listed.map(strategy => ({ strategy, deliver: strategy.deliver, canHandle: strategy.canHandle }));
  // The draft itself is not re-read here: every store write merges under the store lock.
  const assertSelectedSourceCurrent = () => {
    owner.assertSourceCurrent();
    if (context.platform.channelDeliveryRouter !== router || router.deliver !== deliver || router.listStrategies !== listStrategies) throw new ToolInputProjectionError('stale');
    const current = listStrategies.call(router);
    if (current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
      || source.strategy.deliver !== source.deliver || source.strategy.canHandle !== source.canHandle)) throw new ToolInputProjectionError('stale');
  };
  const assertCurrent = () => { owner.assertCurrent(); assertSelectedSourceCurrent(); };
  assertCurrent();
  retainHarnessCatalogCurrent(args)(assertSelectedSourceCurrent, `agent.comms.draft:${publicReference}`);
  const invoke = guardedCommsInvoke(context, args, options, { ...owner, assertCurrent }, nativeReference);
  const preparePublication = (path: string, contents: string) => {
    if (path !== channelDraftFilePath(shellPaths)) throw new ToolInputProjectionError('stale');
    const planned: unknown = JSON.parse(contents);
    if (!planned || typeof planned !== 'object' || !('drafts' in planned) || !Array.isArray(planned.drafts)
      || !planned.drafts.some((draft: unknown) => draft && typeof draft === 'object' && 'id' in draft && draft.id === draftId)) {
      throw new ToolInputProjectionError('held');
    }
    const adoptReference = nativeReference?.preparePublication(path, contents);
    return () => { adoptReference?.(); };
  };
  const storeOptions = { ...(invoke ? { invoke } : {}), webhookSecrets: commsWebhookSecrets(context), signal: options?.signal, assertCurrent, preparePublication, explicitUserRequest: false };
  // The daemon's copy of a draft learns the delivery outcome here; a daemon that
  // does not answer leaves the draft pending, never changes what was delivered.
  const offerOutcome = async (draft: ChannelDraft): Promise<ChannelDraft> => {
    if (!invoke) return draft;
    try {
      await syncChannelDrafts(shellPaths, invoke, { ...storeOptions, draftId });
      return getDraft(shellPaths, draftId) ?? draft;
    } catch {
      return draft;
    }
  };
  // The outward-effect decision is taken on exactly what would be sent, before
  // the draft is marked queued: a send it holds leaves the draft as it was.
  const hold: { decision?: { readonly reason: string; readonly fix?: string } } = {};
  const admit = async (deliveryInput: Parameters<NonNullable<Parameters<typeof queueDraftToSend>[3]>>[0]): Promise<void> => {
    const decision = await evaluateOutwardEffect({ request: { toolName: 'agent_harness', action: 'channel_draft_send', description: 'delivering the captured channel draft' },
      ledger: owner.ledger, content: { ...deliveryInput },
      taintOptions: { signal: options?.signal, exactMatchFields: ['channel', 'route', 'webhook', 'link'] } });
    assertCurrent();
    if (!decision.allowed) {
      hold.decision = { reason: decision.reason ?? 'Channel draft delivery held.', ...(decision.fix ? { fix: decision.fix } : {}) };
      throw new Error(hold.decision.reason);
    }
  };
  let queueResult: Awaited<ReturnType<typeof queueDraftToSend>>;
  try {
    queueResult = await queueDraftToSend(shellPaths, draftId, storeOptions, admit);
    assertCurrent();
  } catch (err) {
    const held = hold.decision;
    if (held) {
      return {
        mode: 'channel_draft_send',
        status: 'held',
        done: false,
        draftId: publicReference,
        reason: publicText(held.reason),
        ...(held.fix ? { next: publicText(held.fix) } : {}),
        policy: 'Nothing was sent and the draft is unchanged (not queued, not failed). Ask the owner to approve this delivery, or edit the draft so it no longer repeats content read this turn.',
      };
    }
    return publicText(err instanceof Error ? err.message : String(err));
  }

  let delivered: Awaited<ReturnType<typeof deliverAgentChannelMessage>> | undefined;
  try {
    const result = await deliverAgentChannelMessage(router, queueResult.deliveryInput, { signal: options?.signal, assertCurrent });
    delivered = result;
    assertCurrent();
    const sentDraft = await offerOutcome(markDraftSent(shellPaths, draftId, result.responseId, storeOptions));
    return {
      mode: 'channel_draft_send',
      status: 'sent',
      done: true,
      draftId: publicReference,
      responseId: result.responseId ? publicText(result.responseId) : null,
      draft: sentDraft ? publicDraft(sentDraft) : sentDraft,
      delivery: {
        message: publicText(result.message),
        title: publicText(result.title),
        target: { ...result.target,
          ...(result.target.address ? { address: publicText(result.target.address) } : {}),
          ...(result.target.routeId ? { routeId: publicText(result.target.routeId) } : {}),
          ...(result.target.label ? { label: publicText(result.target.label) } : {}),
        },
        strategyCount: result.strategyCount,
      },
      policy: 'Draft delivered and marked sent. Receipt recorded via delivery path.',
    };
  } catch (err) {
    const errorMessage = publicText(err instanceof Error ? err.message : String(err));
    if (delivered) {
      // The message already left. Whatever threw afterwards is bookkeeping, and
      // marking the draft failed would invite a second send. Record the fact
      // without the authority checks (it describes something that happened).
      let recorded: ReturnType<typeof markDraftSent> | undefined;
      try { recorded = markDraftSent(shellPaths, draftId, delivered.responseId, {}); } catch { recorded = undefined; }
      if (recorded) recorded = await offerOutcome(recorded);
      return {
        mode: 'channel_draft_send',
        status: recorded ? 'sent' : 'sent_unrecorded',
        // The message went out; only its receipt is missing.
        done: true,
        draftId: publicReference,
        responseId: delivered.responseId ? publicText(delivered.responseId) : null,
        ...(recorded ? { draft: publicDraft(recorded) } : {}),
        error: errorMessage,
        policy: recorded
          ? 'The message was delivered and the draft is marked sent; a step after delivery reported an error. Do not send it again.'
          : 'The message was delivered, but recording it on the draft failed, so the draft still reads queued. A queued draft is never sent again; the delivery receipt is the responseId.',
      };
    }
    let markedFailed = false;
    try {
      assertCurrent();
      const failedDraft = markDraftFailed(shellPaths, draftId, errorMessage, storeOptions); markedFailed = true;
      await offerOutcome(failedDraft);
    } catch {
      // best-effort
    }
    return {
      mode: 'channel_draft_send',
      status: markedFailed ? 'failed' : 'held',
      done: false,
      draftId: publicReference,
      error: errorMessage,
      policy: markedFailed
        ? 'Delivery failed and the current draft was marked failed.'
        : 'Delivery or its receipt was held after authority or source changed. The draft status was preserved; check the delivery before retrying.',
    };
  }
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing (read)
// ---------------------------------------------------------------------------

export function channelRoutingSummary(
  context: CommandContext,
  args: AgentHarnessCommsArgs,
): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      mode: 'channel_routing',
      status: 'unavailable',
      routes: [],
      policy: 'Channel routing requires an active Agent workspace with shell path context.',
    };
  }
  const surfaceKind = readOptString(args.surfaceKind || args.target || args.query);
  if (surfaceKind) {
    const profileId = getProfileForChannel(shellPaths, surfaceKind, readOptString(args.draftRoute));
    const snapshot = listChannelProfileRoutes(shellPaths, { surfaceKind });
    return {
      mode: 'channel_routing',
      status: snapshot.exists ? 'ready' : 'empty',
      surfaceKind,
      resolvedProfileId: profileId,
      routes: snapshot.routes,
      formatted: formatChannelProfileRoutes({ ...snapshot, path: harnessDisplayPath(snapshot.path, shellPaths.homeDirectory) }),
      policy: 'Read-only routing inspection. Use channel_routing_assign to add or update a profile assignment.',
    };
  }
  const limit = readLimit(args.limit, 50);
  const snapshot = listChannelProfileRoutes(shellPaths);
  const limited = { ...snapshot, routes: snapshot.routes.slice(0, limit) };
  const pendingRoutes = snapshot.routes.filter((route) => route.daemonSyncState === 'pending');
  const shownPath = harnessDisplayPath(snapshot.path, shellPaths.homeDirectory);
  return {
    mode: 'channel_routing',
    status: snapshot.exists ? 'ready' : 'empty',
    path: shownPath,
    total: snapshot.routes.length,
    returned: limited.routes.length,
    routes: limited.routes,
    formatted: formatChannelProfileRoutes({ ...limited, path: shownPath }),
    assignRoute: 'agent_harness mode:"channel_routing_assign"',
    removeRoute: 'agent_harness mode:"channel_routing_remove"',
    ...(pendingRoutes.length > 0 ? {
      pendingSync: {
        count: pendingRoutes.length,
        ids: pendingRoutes.map((route) => route.id),
        // A list is a read and does not contact the daemon; the Agent offers these when it next attaches to it.
        next: 'Nothing to do: these assignments are offered to the daemon automatically the next time this Agent attaches to it.',
      },
    } : {}),
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
    policy: 'Read-only routing list. Each assignment is offered to the daemon when made; rows with daemonSyncState pending are held locally and offered again when the Agent next attaches to the daemon.',
  };
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing_assign (effect)
// ---------------------------------------------------------------------------

export async function channelRoutingAssignHandoff(
  context: CommandContext,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<EffectResult | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel routing assignment');
  if (confirmationError) return confirmationError;

  const surfaceKind = readString(args.surfaceKind);
  if (!surfaceKind) return 'channel_routing_assign requires surfaceKind.';
  const profileId = readString(args.profileId);
  if (!profileId) return 'channel_routing_assign requires profileId.';

  const owner = captureCommsEffect(context, args, options, channelProfileRouteFilePath);
  const shellPaths = owner.paths;
  const invoke = guardedCommsInvoke(context, args, options, owner);
  const result = await assignChannelToProfile(
    shellPaths,
    {
      surfaceKind,
      routeId: readOptString(args.draftRoute),
      profileId,
      label: readOptString(args.routeLabel),
    },
    { ...(invoke ? { invoke } : {}), signal: options?.signal, assertCurrent: owner.assertCurrent, explicitUserRequest: false },
  );
  owner.assertCurrent();

  return {
    mode: 'channel_routing_assign',
    status: 'assigned',
    done: true,
    created: result.created,
    route: result.route,
    path: harnessDisplayPath(result.path, shellPaths.homeDirectory),
    daemon: result.daemon,
    routes: {
      list: 'agent_harness mode:"channel_routing"',
      remove: 'agent_harness mode:"channel_routing_remove" assignmentId:"' + result.route.id + '"',
    },
    policy: result.daemon.synced
      ? 'Assignment held by the daemon and mirrored locally, so every surface routes the same way.'
      : `Assignment saved locally and awaiting the daemon (${CHANNEL_ROUTING_ASSIGN_METHOD}: ${result.daemon.error}); it is offered again automatically when this Agent next attaches to the daemon.`,
  };
}

// ---------------------------------------------------------------------------
// ROUTING, channel_routing_remove (effect)
// ---------------------------------------------------------------------------
// ROUTING, channel_routing_remove (effect)
// ---------------------------------------------------------------------------

export async function channelRoutingRemoveHandoff(
  context: CommandContext,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<EffectResult | string> {
  const confirmationError = requireConfirmedAction(args, options, 'Channel routing removal');
  if (confirmationError) return confirmationError;

  const surfaceKind = readOptString(args.surfaceKind);
  // assignmentId names the assignment; draftRoute names a channel route (with surfaceKind).
  // A call without either id that passes draftRoute alone is the older spelling of assignmentId.
  const assignmentId = readString(args.assignmentId) || readString(args.target) || (surfaceKind ? '' : readString(args.draftRoute));
  const channelRoute = surfaceKind ? readOptString(args.draftRoute) : undefined;
  const given = assignmentId || channelRoute || '';
  if (!assignmentId && !surfaceKind) return 'channel_routing_remove requires assignmentId (the id channel_routing_assign returned), or surfaceKind (with draftRoute for one channel route) to remove that surface\'s assignment.';

  const owner = captureCommsEffect(context, args, options, channelProfileRouteFilePath);
  const shellPaths = owner.paths;
  // The assignment id is what the store removes by. A caller that only knows
  // the channel (surfaceKind, with an optional channel route id) is resolved to it.
  const stored = listChannelProfileRoutes(shellPaths).routes;
  const target = (assignmentId ? stored.find((route) => route.id === assignmentId) : undefined)
    ?? (surfaceKind ? stored.find((route) => route.surfaceKind === surfaceKind && route.routeId === channelRoute) : undefined);
  if (!target) {
    return {
      mode: 'channel_routing_remove',
      status: 'not_found',
      done: false,
      removed: false,
      routeId: given,
      routes: { list: 'agent_harness mode:"channel_routing"' },
      error: 'No assignment matches that assignmentId (or surfaceKind with draftRoute as the channel route). Nothing was changed; use channel_routing to list the assignment ids.',
    };
  }

  const invoke = guardedCommsInvoke(context, args, options, owner);
  const result = await removeChannelProfileRouteEverywhere(shellPaths, target.id,
    { ...(invoke ? { invoke } : {}), signal: options?.signal, assertCurrent: owner.assertCurrent, explicitUserRequest: false });
  owner.assertCurrent();
  const refused = result.daemon.status === 'refused';
  return {
    mode: 'channel_routing_remove',
    // A daemon refusal removed nothing, so it is a failed result; an assignment already gone is a real no-op.
    status: refused ? 'not_applied' : result.removed ? 'removed' : 'already_removed',
    done: !refused,
    removed: result.removed,
    routeId: target.id,
    daemon: result.daemon,
    routes: {
      list: 'agent_harness mode:"channel_routing"',
    },
    ...(result.daemon.status === 'refused'
      ? { error: `The daemon still holds this assignment and keeps routing on it (${result.daemon.error}); the local row was kept so the removal can be retried. Nothing was removed.` }
      : {}),
    policy: refused
      ? 'Nothing was removed; the local row was kept so channel_routing_remove can be repeated once the daemon takes it.'
      : result.removed
        ? result.daemon.status === 'deleted'
          ? 'Assignment removed from the daemon and the local mirror.'
          : 'Assignment removed locally; the daemon was never told about it, so it holds nothing to withdraw.'
        : 'The assignment was already gone; nothing was changed.',
  };
}
