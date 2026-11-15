/**
 * The one account-inbox store owner shared by the Slack, email and Discord
 * inboxes: the store lease, the registration, the cluster eligibility gate and
 * the close order. Each provider builds its own identity and owner and says how
 * its registration is made; everything after the owner exists is here, so a fix
 * to the account flow (lease timeout, close order, failure cleanup) reaches all
 * three providers.
 */
import { join } from 'node:path';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import type { ClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import type { InboxPollingControl, InboxSurfaceRegistration, RegisterInboxSurfaceOptions } from '@goodvibes-jev/engine/platform/platform/intake';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';
import { ownInboxEligibility } from './inbox-eligibility.js';

type Controls = Parameters<DaemonInboxFactory>[2];
export type AccountInboxProvider = 'slack' | 'email' | 'discord';

/**
 * Where an account inbox's store lease lives: beside its store file, in the
 * operator directory under the daemon's surface root.
 */
export function accountInboxLockPath(workingDirectory: string, storeFileName: string): string {
  return join(workingDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'operator', `${storeFileName}.owner.lock`);
}

/** How long a second process waits for an inbox store held by another before refusing. */
const STORE_LEASE_WAIT_MS = 100;

interface AccountInboxOwner {
  readonly scopeId: string;
  close(): void | Promise<void>;
  verifyEligibility?: (() => Promise<{ readonly signal: AbortSignal; assertCurrent(): void }>) | undefined;
}

/** What the provider passes to its registration: the store file, the polling gate, and the cluster seed rule. */
export interface AccountInboxStoreOptions {
  readonly storeFileName: string;
  readonly gatePolling: NonNullable<RegisterInboxSurfaceOptions['gatePolling']>;
  readonly awaitInitialPoll?: false;
}

export interface AccountInboxStoreInput<T extends InboxSurfaceRegistration, O extends AccountInboxOwner> {
  readonly provider: AccountInboxProvider;
  readonly controls: Controls;
  readonly workingDirectory: string;
  readonly clustered: boolean;
  readonly eligibilityClock?: ClusterClock | undefined;
  readonly owner: O;
  /** Checks and subscriptions made once the owner exists; a throw here closes the owner. */
  readonly prepare?: (() => void) | undefined;
  /** The poller election discriminator, read after `prepare`. */
  readonly electionScope: () => string;
  /** The account's own currentness, checked after each await. */
  readonly assertCurrent: () => void;
  readonly register: (store: AccountInboxStoreOptions) => T | Promise<T>;
  /** The provider's own extra resources (a subscription, a mail service), released after the owner. */
  readonly releaseExtras?: (() => void) | undefined;
}

/**
 * Lease the account's store, register it with its polling gate, and return the
 * registration with one close: the store and the owner together, then the
 * provider's extras, then the lease (kept when the store did not close, so a
 * second owner never opens a store that may still be in use).
 */
export async function ownAccountInboxStore<T extends InboxSurfaceRegistration, O extends AccountInboxOwner>(
  input: AccountInboxStoreInput<T, O>,
): Promise<T> {
  const { provider, controls, owner, clustered } = input;
  let eligibility: ReturnType<typeof ownInboxEligibility> | undefined;
  let release: (() => void) | undefined;
  let surface: T | undefined;
  const constructed = Promise.withResolvers<T>();
  // A registrar may yield before returning its actual storage owner.
  void constructed.promise.catch(() => {});
  try {
    input.prepare?.();
    if (clustered && typeof owner.verifyEligibility !== 'function') throw new Error(`Clustered ${provider} inbox requires an eligible owner`);
    const electionScope = input.electionScope();
    const storeFileName = `inbox-${provider}-${owner.scopeId}.sqlite`;
    release = await acquireCrossProcessLock(accountInboxLockPath(input.workingDirectory, storeFileName), {
      strictOwnership: true, totalTimeoutMs: STORE_LEASE_WAIT_MS,
    });
    input.assertCurrent();
    surface = await input.register({
      storeFileName,
      ...(clustered ? { awaitInitialPoll: false as const } : {}),
      // Keep the wire provider id; only the owner/election discriminator is scoped.
      gatePolling: (_providerId: string, control: InboxPollingControl) => {
        if (!clustered) return controls.gatePolling(`${provider}:${electionScope}`, control);
        if (!controls.gatePollingOwned) throw new Error('Clustered inbox requires owned gate retirement');
        const gatePollingOwned = controls.gatePollingOwned;
        eligibility = ownInboxEligibility({
          verify: async () => {
            const registration = await constructed.promise;
            await registration.ready;
            return owner.verifyEligibility!();
          },
          control,
          ...(input.eligibilityClock ? { clock: input.eligibilityClock } : {}),
          register: gated => gatePollingOwned(`${provider}:${electionScope}`, gated),
        });
        const owned = eligibility;
        return () => owned.close();
      },
    });
    constructed.resolve(surface);
  } catch (error) {
    constructed.reject(new Error(`${provider} inbox source construction failed`));
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => surface?.close()),
      Promise.resolve().then(() => owner.close()),
      Promise.resolve().then(() => eligibility?.close()),
    ]);
    try { input.releaseExtras?.(); } catch { /* The construction failure is the error reported. */ }
    if (cleanup[0]?.status === 'fulfilled') release?.();
    throw new Error(`The ${provider} inbox could not acquire its owned account and storage`, { cause: error });
  }
  const registration = surface;
  const unlock = release;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        const [store, ownerClosed] = await Promise.allSettled([registration.close(), Promise.resolve().then(() => owner.close())]);
        // Extras (a mail service the owner reads through) outlive the owner's drain.
        const [extras] = await Promise.allSettled([Promise.resolve().then(() => input.releaseExtras?.())]);
        // Never release a store lease on a failed storage retirement.
        if (store.status === 'fulfilled') unlock();
        const failures = [store, ownerClosed, extras!].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), `The ${provider} inbox did not close cleanly`);
      });
    }
    return closing;
  };
  const owned = eligibility;
  return {
    ...registration,
    close,
    unregister() { void close().catch(() => {}); },
    ready: Promise.all([registration.ready, owned?.ready]).then(() => {}),
  };
}
