/**
 * The task intervention plane both terminal programs build: pause, go on, cancel and run again on the tasks of this
 * session (Tasks here in the Work place), decided by the operator control plane over the program's own task
 * registry. One construction for the terminal app and the Agent, so the same control does the same thing in both.
 *
 * It rides the control-plane gateway capability (`controlPlane.gateway`, on by default); with it turned off no plane
 * is built and the four acts answer that the control plane is not available.
 */
import {
  CONTROL_PLANE_FEATURE_FLAG,
  OpsControlPlane,
} from '@goodvibes/engine/platform/platform/runtime/operations';

type PlaneArgs = ConstructorParameters<typeof OpsControlPlane>;

export interface TaskInterventionsInput {
  /** The program's task registry (its `createTaskManager`). */
  readonly taskManager: PlaneArgs[0];
  readonly runtimeBus: PlaneArgs[1];
  readonly store: PlaneArgs[2];
  /** The session the program started with: the plane's events name it. */
  readonly sessionId: PlaneArgs[3];
  /** Stops an agent a task row names (the program's agent manager). */
  readonly agentCanceller?: PlaneArgs[4];
  readonly featureFlags: { isEnabled(flag: typeof CONTROL_PLANE_FEATURE_FLAG): boolean };
}

/** The program's task intervention plane, or undefined when the control-plane gateway capability is turned off. */
export function createTaskInterventions(input: TaskInterventionsInput): OpsControlPlane | undefined {
  if (!input.featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)) return undefined;
  return new OpsControlPlane(input.taskManager, input.runtimeBus, input.store, input.sessionId, input.agentCanceller);
}
