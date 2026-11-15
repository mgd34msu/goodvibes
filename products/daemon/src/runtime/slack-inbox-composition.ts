import { attachDaemonInboxTagging, type DaemonTriageTaggingActivation } from './tagged-inbox-composition.js';
import { createMultiOwnerDaemonInboxFactory } from './multiowner-inbox-composition.js';
import { createInboxRouteResolver } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import { ownAccountInboxStore } from './account-inbox-store.js';
import { realpath } from 'node:fs/promises';
import {
  createSlackInboxOwner, acquireAccountInboxIdentity, resolveAccountInboxElectionScope, registerInboxSurface, createOwnedInboxSource, createOwnedTriagedInboxSource,
  type SlackInboxAccount, type SlackInboxOwner, type InboxSurfaceRegistration, type InboxTriageAuthority,
} from '@goodvibes-jev/engine/platform/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/platform/platform/security';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface SlackDaemonInboxOptions {
  /** Separately established semantic destination/account grant, never inferred from screening. */
  readonly triageAuthority?: InboxTriageAuthority;
  readonly triageTagging?: DaemonTriageTaggingActivation;
  /** Explicit expected Slack workspace AND user/bot identity; not token-derived. */
  readonly account: SlackInboxAccount;
  /** Trusted established local-service authority, including live revocation. */
  readonly screening: ProtectedSourceOwnerOptions;
  /**
   * The selected account's lifetime: aborted by the selector's setting and
   * credential subscriptions. With it, that is the only currentness check.
   */
  readonly operation?: { readonly signal: AbortSignal; assertCurrent(): void } | undefined;
  readonly timeoutMs?: number;
}

/** In-process constructor capabilities; never sourced from CLI/config/message data. */
export interface SlackDaemonInboxFactories {
  readonly createOwner?: (...args: Parameters<typeof createSlackInboxOwner>) => Promise<SlackInboxOwner>;
  readonly registerSurface?: typeof registerInboxSurface;
  /** Constructor-only deterministic clock, never decoded from configuration. */
  readonly eligibilityClock?: ClusterClock;
}

/** Independently owned Slack account, with no canonical method binding. */
export interface SlackDaemonInboxSourceFactories extends Omit<SlackDaemonInboxFactories, 'registerSurface'> {
  readonly createSource?: typeof createOwnedInboxSource;
}

export function createSlackDaemonInboxSourceFactory(
  options: SlackDaemonInboxOptions,
  factories: SlackDaemonInboxSourceFactories = {},
): DaemonInboxSourceFactory {
  const authority = options.triageAuthority;
  return createSlackAccountFactory(options, factories, factories.createSource ?? ((context, source, owner, beforeIdentityWrite, beforeReceiptWrite) =>
    createOwnedTriagedInboxSource(context, { ...source, providerId: 'slack', accountScopeId: owner.scopeId,
      ...(owner.triageStoreFileName ? { triageStoreFileName: owner.triageStoreFileName } : {}),
      beforeIdentityWrite, beforeReceiptWrite,
      acquireReadLease: () => {
        if (!owner.acquireReadLease) throw new Error('Slack triage requires the native account read lease');
        return owner.acquireReadLease();
      }, ...(authority ? { authority } : {}),
    })), true);
}

/** Compatible single-source composition, including the injected registrar seam. */
export function createSlackDaemonInboxFactory(
  options: SlackDaemonInboxOptions,
  factories: SlackDaemonInboxFactories = {},
): DaemonInboxFactory {
  if (!factories.registerSurface || options.triageTagging || options.triageAuthority) {
    if (factories.registerSurface) throw new Error('Triage requires an owned source, not a legacy registrar');
    return createMultiOwnerDaemonInboxFactory([createSlackDaemonInboxSourceFactory(options, factories)]);
  }
  return createSlackAccountFactory(options, factories, factories.registerSurface ?? registerInboxSurface, false);
}

function createSlackAccountFactory<T extends InboxSurfaceRegistration>(
  options: SlackDaemonInboxOptions,
  factories: Pick<SlackDaemonInboxFactories, 'createOwner' | 'eligibilityClock'>,
  register: (context: Parameters<DaemonInboxFactory>[0], options: Parameters<typeof registerInboxSurface>[1], owner: SlackInboxOwner,
    beforeIdentityWrite: (() => void) | undefined, beforeReceiptWrite: ((receiptVersion?: 3 | 4) => void) | undefined) => T | Promise<T>,
  requireFinalProof: boolean,
): (...args: Parameters<DaemonInboxFactory>) => Promise<T> {
  const triageTagging = options.triageTagging ? Object.freeze({ onReady: options.triageTagging.onReady }) : undefined;
  if (triageTagging && typeof triageTagging.onReady !== 'function') throw new Error('Triage tagging requires an explicit owner callback');
  return async (context, routing, controls) => {
    if (triageTagging && (!controls.createTriageTagging || !controls.onAccountInvalidation)) throw new Error('Triage tagging requires the canonical daemon permission and credential owners');
    const resolveProfileId = routing.resolveProfileId.bind(routing);
    const resolveRouteId = createInboxRouteResolver({
      getProfileForChannel: resolveProfileId, resolveProfile: resolveProfileId,
    });
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered inbox requires owned gate retirement');
    if (clustered && !controls.onAccountInvalidation) throw new Error('Clustered Slack inbox requires owned account invalidation');
    if (context.configManager.get('surfaces.slack.enabled') !== true) throw new Error('Slack inbox composition requires Slack to be enabled');
    const expectedWorkspace = options.account.workspaceId;
    const account = Object.freeze({ workspaceId: expectedWorkspace, userId: options.account.userId });
    const selected = options.operation;
    const current = selected ? (): void => { selected.assertCurrent(); } : (): void => {
      if ((context.configManager.get('cluster.enabled') === true) !== clustered
        || context.configManager.get('surfaces.slack.enabled') !== true
        || context.configManager.get('surfaces.slack.workspaceId') !== expectedWorkspace) {
        throw new Error('Slack inbox configuration scope changed');
      }
    };
    current();
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    const identity = await acquireAccountInboxIdentity({ workingDirectory, assertCurrent: current,
      beforeWrite: controls.beforeAccountIdentityWrite }, { provider: 'slack', account });
    current();
    const owner = await (factories.createOwner ?? createSlackInboxOwner)({ ...context, resolveRouteId }, {
      identity, account, screening: options.screening, assertCurrent: current,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    let unsubscribe: (() => void) | undefined;
    const result = await ownAccountInboxStore({
      provider: 'slack', controls, workingDirectory, clustered, owner, assertCurrent: current,
      ...(factories.eligibilityClock ? { eligibilityClock: factories.eligibilityClock } : {}),
      prepare() {
        if (requireFinalProof && typeof owner.acquireReadLease !== 'function') {
          throw new Error('Slack inbox source requires a generation-fenced read lease');
        }
        if (clustered && typeof owner.invalidateCredential !== 'function') throw new Error('Clustered Slack inbox requires an eligible owner');
        unsubscribe = controls.onAccountInvalidation?.(() => owner.invalidateCredential?.());
        current();
      },
      electionScope: () => clustered ? resolveAccountInboxElectionScope(identity) : owner.scopeId,
      register: store => register({ ...context, workingDirectory }, {
        adapters: new Map([['slack', owner.adapter]]), beforeSourceRevisionWrite: controls.beforeSourceRevisionWrite, ...store,
        ...(requireFinalProof
          ? { acquireReadLease: () => owner.acquireReadLease!() }
          : { assertReadCurrent: owner.assertReadCurrent }),
      }, owner, controls.beforeInboxTriageIdentityWrite, controls.beforeInboxTriageReceiptWrite),
      releaseExtras: () => unsubscribe?.(),
    });
    return triageTagging ? attachDaemonInboxTagging(result, triageTagging, controls, {
      provider: 'slack', accountScopeId: owner.scopeId, assertCurrent: current,
    }) : result;
  };
}
