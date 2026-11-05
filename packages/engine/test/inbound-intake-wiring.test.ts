/**
 * inbound-intake-wiring.test.ts
 *
 * Proves the inbound-intake enrichment is actually WIRED at the transport intake
 * chokepoint (SharedSessionBroker.submitMessage), not just that the substrate
 * exists: an inbound message from a mapped identity originates a session
 * attributed to the right principal with the channel profile applied, and an
 * unmapped sender gets the honest unknown principal (known:false), never a guess.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../sdk/src/platform/channels/index.ts';
import {
  ChannelProfileRegistry,
  ChannelProfileStore,
  installInboundIntakeEnrichment,
  enrichInboundSubmitMetadata,
  ATTRIBUTED_PRINCIPAL_ID_KEY,
  ATTRIBUTED_PRINCIPAL_NAME_KEY,
  ATTRIBUTED_PRINCIPAL_KNOWN_KEY,
  CHANNEL_PROFILE_MODEL_KEY,
  CHANNEL_PROFILE_PROVIDER_KEY,
  CHANNEL_PROFILE_PERMISSION_MODE_KEY,
} from '../sdk/src/platform/channel-profiles/index.ts';
import { PrincipalRegistry, PrincipalStore, UNKNOWN_PRINCIPAL_ID } from '../sdk/src/platform/principals/index.ts';
import { trackDisposables } from './_helpers/disposables.ts';
import { channelExecutionModeOwner, withChannelExecutionMode } from '../sdk/src/platform/channel-profiles/install-inbound-intake.ts';
import { currentExecutionModeOwner } from '../sdk/src/platform/gate/execution-context.ts';
import { createSessionPermissionModeGetHandler, createSessionPermissionModeSetHandler, createSessionRuntimeControls, SessionLiveTurnControlsHolder } from '../sdk/src/platform/control-plane/routes/session-runtime.ts';

const disposables = trackDisposables();

function makeBroker(store = new PersistentStore<never>(':memory:' as string)): SharedSessionBroker {
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    getBinding: () => null,
    resolve: () => null,
    upsertBinding: async (b: Record<string, unknown>) => ({ id: 'rb-1', ...b }),
  } as unknown as RouteBindingManager;
  return disposables.add(new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
}

async function makeRegistries() {
  const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
  const avery = await principals.create({
    name: 'Avery',
    kind: 'user',
    identities: [{ channel: 'slack', value: 'U123' }],
  });
  const channelProfiles = new ChannelProfileRegistry(new ChannelProfileStore(':memory:'));
  await channelProfiles.set({
    surfaceKind: 'slack',
    model: 'claude-profile-model',
    provider: 'anthropic',
    permissionMode: 'safe-jev',
  });
  return { principals, channelProfiles, averyId: avery.id };
}

describe('inbound-intake enrichment: pure metadata mapping', () => {
  test('a mapped identity produces principal attribution + the applied channel profile', async () => {
    const { principals, channelProfiles, averyId } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U123', body: 'hi' },
    );
    expect(metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(averyId);
    expect(metadata[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('Avery');
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(metadata[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
    expect(metadata[CHANNEL_PROFILE_PROVIDER_KEY]).toBe('anthropic');
    expect(metadata[CHANNEL_PROFILE_PERMISSION_MODE_KEY]).toBe('safe-jev');
  });

  test('an unmapped sender is attributed to the honest unknown principal (known:false)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U999-not-mapped', body: 'hi' },
    );
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
    // The profile still applies, it binds to the channel, not the sender.
    expect(metadata[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
  });

  test('caller-set metadata is preserved (enrichment augments, never rewrites)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U123', body: 'hi', metadata: { threadTs: '42.0' } },
    );
    expect(metadata.threadTs).toBe('42.0');
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
  });
});

describe('inbound-intake enrichment: wired at the broker submitMessage seam', () => {
  test('the canonical session endpoint changes only the real channel owner and advances its revision', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' });
    const sessionId = submission.session.id;
    const owner = channelExecutionModeOwner(broker, sessionId)!;
    const before = owner.getRevision();
    const events: string[] = [];
    const liveTurnHolder = new SessionLiveTurnControlsHolder();
    liveTurnHolder.bind({ cancelToolCall: () => true, listQueuedMessages: () => [],
      editQueuedMessage: () => false, deleteQueuedMessage: () => false });
    const controls = createSessionRuntimeControls({
      config: { get: () => 'safe-owner', set: () => { throw new Error('Channel mode must not write daemon configuration'); } },
      store: { getState: () => ({ session: { id: 'daemon' }, conversation: { estimatedContextTokens: 0 } }) },
      liveTurnHolder, channelSessions: broker, channelModeChanged: (_id, mode) => { events.push(mode); },
    });
    const get = createSessionPermissionModeGetHandler(controls);
    const set = createSessionPermissionModeSetHandler(controls);
    expect(get({ context: {}, body: { sessionId } })).toEqual({ sessionId, mode: 'safe-jev' });
    await expect(set({ context: {}, body: { sessionId, mode: 'yolo' } })).resolves.toEqual({ sessionId, mode: 'yolo', previousMode: 'safe-jev' });
    expect(owner.getMode()).toBe('yolo');
    expect(owner.getRevision()).toBeGreaterThan(before);
    await set({ context: {}, body: { sessionId, mode: 'safe-jev' } });
    expect(owner.getMode()).toBe('safe-jev');
    expect(owner.getRevision()).toBeGreaterThan(before + 1);
    expect(events).toEqual(['yolo', 'safe-jev']);
    expect(controls.getLiveTurnControls(sessionId)).toBeNull();
    expect(controls.getLiveTurnControls('daemon')).not.toBeNull();
  });

  test('failed mode persistence restores the prior mode without reviving the prior revision', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const store = new PersistentStore<never>(':memory:');
    const broker = makeBroker(store);
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' });
    const owner = channelExecutionModeOwner(broker, submission.session.id)!;
    const revision = owner.getRevision();
    const failed = spyOn(store, 'persist').mockRejectedValueOnce(new Error('mode disk failure'));
    await expect(broker.setChannelExecutionMode(submission.session.id, 'yolo')).rejects.toThrow('mode disk failure');
    failed.mockRestore();
    expect(owner.getMode()).toBe('safe-jev');
    expect(owner.getRevision()).toBeGreaterThan(revision);
  });

  test('the broker continuation executes under the same trusted channel owner', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' });
    await broker.bindAgent(submission.session.id, 'first-agent');
    await broker.followUpMessage({ sessionId: submission.session.id, surfaceKind: 'slack', surfaceId: 'T1', body: 'next' });
    let continuationMode: string | undefined;
    broker.setContinuationRunner(() => {
      continuationMode = currentExecutionModeOwner()?.getMode();
      return { agentId: 'next-agent' };
    });
    await broker.completeAgent(submission.session.id, 'first-agent', 'done');
    expect(continuationMode).toBe('safe-jev');
  });

  test('trusted mode survives broker restoration while metadata never becomes authority', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const store = new PersistentStore<never>(':memory:');
    const broker = makeBroker(store);
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' });
    const spoofed = await broker.createSession({ metadata: { channelPermissionMode: 'yolo', [CHANNEL_PROFILE_PERMISSION_MODE_KEY]: 'yolo' } });
    await broker.stop();
    const restored = makeBroker(store);
    await restored.start();
    expect(withChannelExecutionMode(restored, submission.session.id, () => currentExecutionModeOwner()?.getMode())).toBe('safe-jev');
    expect(channelExecutionModeOwner(restored, spoofed.id)).toBeUndefined();
  });

  test('configured mode owns actual channel dispatch and caller metadata cannot replace it', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'inspect',
      metadata: { [CHANNEL_PROFILE_PERMISSION_MODE_KEY]: 'yolo', channelPermissionMode: 'yolo' } });
    expect(broker.getSession(submission.session.id)?.channelPermissionMode).toBe('safe-jev');
    expect(withChannelExecutionMode(broker, submission.session.id, () => currentExecutionModeOwner()?.getMode())).toBe('safe-jev');
    expect(currentExecutionModeOwner()).toBeUndefined();
    const owner = channelExecutionModeOwner(broker, submission.session.id)!;
    const priorRevision = owner.getRevision();
    await broker.closeSession(submission.session.id);
    expect(() => owner.getMode()).toThrow('no longer active');
    await broker.reopenSession(submission.session.id);
    expect(owner.getRevision()).toBeGreaterThan(priorRevision);
  });

  test('a mode value in request metadata grants no owner when no profile selected it', async () => {
    const { principals } = await makeRegistries();
    const channelProfiles = new ChannelProfileRegistry(new ChannelProfileStore(':memory:'));
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const submission = await broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'inspect',
      metadata: { [CHANNEL_PROFILE_PERMISSION_MODE_KEY]: 'yolo', channelPermissionMode: 'yolo' } });
    expect(broker.getSession(submission.session.id)?.channelPermissionMode).toBeUndefined();
    expect(submission.session.metadata[CHANNEL_PROFILE_PERMISSION_MODE_KEY]).toBeUndefined();
    expect(channelExecutionModeOwner(broker, submission.session.id)).toBeUndefined();
  });

  test('installInboundIntakeEnrichment attributes an originated session and applies the profile', async () => {
    const { principals, channelProfiles, averyId } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });

    const submission = await broker.submitMessage({
      surfaceKind: 'slack',
      surfaceId: 'T1',
      externalId: 'C-general',
      userId: 'U123',
      displayName: 'avery',
      body: 'ship it',
    });

    const meta = submission.session.metadata ?? {};
    expect(meta[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(averyId);
    expect(meta[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('Avery');
    expect(meta[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(meta[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
    expect(meta[CHANNEL_PROFILE_PROVIDER_KEY]).toBe('anthropic');
    expect(meta[CHANNEL_PROFILE_PERMISSION_MODE_KEY]).toBe('safe-jev');
  });

  test('an unmapped sender originates a session with the honest unknown principal', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });

    const submission = await broker.submitMessage({
      surfaceKind: 'slack',
      surfaceId: 'T1',
      externalId: 'C-general',
      userId: 'U999-not-mapped',
      body: 'who am i',
    });

    const meta = submission.session.metadata ?? {};
    expect(meta[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(meta[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
  });

  test('installing twice does not double-wrap (idempotent guard)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const wrappedOnce = broker.submitMessage;
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    expect(broker.submitMessage).toBe(wrappedOnce);
  });
});
