/**
 * personal-capture/daemon-port.ts, the capture port of a program that does not keep the owner profile itself.
 *
 * The owner profile and the occasions are the daemon's (it is their one writer). The daemon's own turns fill the
 * holder with its store and service (control-plane/routes/owner-profile-composition.ts); a terminal program fills it
 * with this: each call is the daemon method of the same name and shape (`profile.set`, `profile.append`,
 * `occasions.confirm`, `occasions.plans.confirm`, `occasions.list`, `occasions.plans.list`, `occasions.acknowledge`),
 * whose handlers call that store and service with the same input and answer with what they answered. So the
 * `profile` tool is the same tool, with the same refusals, in every door.
 */
import type { PersonalCapturePort } from './port.js';

/** Calls one daemon method with the program's own credential; throws when it was refused or not reached. */
export type DaemonCaptureInvoke = (methodId: string, input?: unknown) => Promise<unknown>;

export function daemonPersonalCapturePort(invoke: DaemonCaptureInvoke): PersonalCapturePort {
  // The answer is the daemon's handler's return value for this method, which is the store's or service's own result.
  const call = <T>(methodId: string, input: unknown): Promise<T> => invoke(methodId, input) as Promise<T>;
  return {
    profile: {
      set: (input) => call('profile.set', input),
      append: (input) => call('profile.append', input),
    },
    occasions: {
      confirmOccasion: (input) => call('occasions.confirm', input),
      confirmPlan: (input) => call('occasions.plans.confirm', input),
      list: () => call('occasions.list', {}),
      listPlans: () => call('occasions.plans.list', {}),
      acknowledge: (input) => call('occasions.acknowledge', input),
    },
  };
}
