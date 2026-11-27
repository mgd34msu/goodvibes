import type { Tool } from '../../types/tools.js';
import type { CrossSessionTaskRef, CrossSessionTaskRegistry, TaskHandoffRecord } from '../../sessions/orchestration/index.js';
import { LEGACY_TASK_NAMESPACE } from '../../sessions/orchestration/types.js';
import { TASK_TOOL_SCHEMA, type TaskToolInput } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import { taskLifecycle } from '../../runtime/tasks/lifecycle.js';
import { summarizeError } from '../../utils/error-display.js';

/** Options for {@link createTaskTool}. */
export interface TaskToolOptions {
  /**
   * Resolves the REAL runtime session identity, called fresh on every tool
   * invocation.
   *
   * A getter, not a value: `runtime.sessionId` is reassigned in place when a
   * crash-recovery snapshot is accepted, so an id captured at tool-registration
   * time would keep writing refs under the boot session the user just left
   * behind. Reading it per call is the only way the tool follows the session the
   * user is actually in.
   *
   * When absent, the tool falls back to the legacy namespace and every ref it
   * writes is unowned, see {@link LEGACY_TASK_NAMESPACE}. Hosts that care
   * about owner-existence reaping must pass this.
   */
  readonly resolveSessionId?: (() => string) | undefined;
  /**
   * A registry several conversations use at once (the daemon's, for every web chat and run): a conversation reads its
   * own refs, and the ones kept before refs had an owner (the legacy namespace) as before; never another's.
   */
  readonly ownSessionOnly?: boolean | undefined;
}

function summarizeRef(ref: CrossSessionTaskRef | null) {
  if (!ref) return null;
  return {
    sessionId: ref.sessionId,
    taskId: ref.taskId,
    title: ref.title,
    label: ref.label,
    status: ref.status,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
  };
}

function summarizeHandoff(handoff: TaskHandoffRecord) {
  return {
    handoffId: handoff.handoffId,
    fromSessionId: handoff.fromSessionId,
    toSessionId: handoff.toSessionId,
    taskRef: handoff.taskRef,
    acknowledged: handoff.acknowledged,
    initiatedAt: handoff.initiatedAt,
    ...(handoff.reason ? { reason: handoff.reason } : {}),
  };
}

/**
 * The `task` tool.
 *
 * OWNERSHIP IS NOT A TOOL INPUT. The owning `sessionId` on every ref this tool
 * writes comes from `options.resolveSessionId`, the host's real runtime session
 * identity, and the model's `input.sessionId` is IGNORED for all of them. It
 * used to be the authority, defaulting to the literal `'local'`, which meant an
 * ownership key the model could set to anything (or, overwhelmingly, forget to
 * set at all). A field the caller can spoof cannot be the key a store reaps by:
 * owner-existence housekeeping over a namespace the model chooses is not
 * housekeeping, and one shared `'local'` bucket is not per-session ownership.
 *
 * `input.sessionId` still means something in exactly one place: READ modes
 * (`list`, `show`), where it selects WHICH session's refs to display. Reading
 * another session's graph is the point of a cross-session registry and asserts
 * no ownership, so it stays available and simply defaults to the caller's own
 * session. Naming another session as a dependency target
 * (`dependsOnSessionId`) or a handoff destination (`toSessionId`) likewise
 * still works, those are references to a counterparty, not a claim about who
 * owns the record being written.
 *
 * Every successful result also lists the handoffs waiting for this session to
 * accept (`handoffsAwaitingThisSession`), so a session learns of work handed
 * to it whenever it uses the tool.
 */
export function createTaskTool(registry: CrossSessionTaskRegistry, options: TaskToolOptions = {}): Tool {
  return {
    definition: {
      name: 'task',
      activity: {
        doing: 'Updating', did: 'updated', object: 'the task list',
        byAction: { read: { doing: 'Checking', did: 'checked', object: 'the task list' } },
      },
      // Sent in full on every model request (see ToolDefinition.core).
      core: true,
      description: 'Manage durable cross-session task refs, dependencies, cancellations, and handoffs shared by every session of this project.'
        + ' A handoff blocks the task until its destination session accepts it with mode=acknowledge handoffId=<id>;'
        + ' the source session can take it back with mode=withdraw handoffId=<id>.'
        + ' Results list handoffs waiting for this session under handoffsAwaitingThisSession.',
      parameters: toRecord(TASK_TOOL_SCHEMA),
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as TaskToolInput;
      // The one authoritative identity. Every WRITE below keys on this and
      // never on input.sessionId, see the createTaskTool doc comment.
      const sessionId = options.resolveSessionId?.().trim() || LEGACY_TASK_NAMESPACE;
      // Read-only selector: which session's refs to display. Defaults to ours.
      const readSessionId = input.sessionId?.trim() || sessionId;
      if (options.ownSessionOnly === true && readSessionId !== sessionId && readSessionId !== LEGACY_TASK_NAMESPACE) {
        return { success: false, error: 'Another conversation\'s tasks are not read from here: this conversation reads its own, and the ones kept before tasks had an owner.' };
      }
      const view = input.view ?? 'summary';

      const ok = (value: object) => {
        const awaiting = input.mode === 'handoffs' ? [] : registry.handoffsAwaiting(sessionId);
        return {
          success: true,
          output: JSON.stringify(awaiting.length > 0 ? { ...value, handoffsAwaitingThisSession: awaiting.map(summarizeHandoff) } : value),
        };
      };

      try {
        if (input.mode === 'create') {
          if (!input.taskId || !input.title) {
            return { success: false, error: 'create requires taskId and title.' };
          }
          const existing = registry.getRef(sessionId, input.taskId);
          if (existing) {
            return { success: false, error: `Task ref ${sessionId}:${input.taskId} already exists (status ${existing.status}); create cannot replace it. Nothing was changed. Use mode=status to move it, or create a new taskId.` };
          }
          const now = Date.now();
          const result = registry.linkTask({
            sessionId,
            taskId: input.taskId,
            title: input.title,
            status: input.status ?? 'queued',
            createdAt: now,
            updatedAt: now,
            ...(input.label ? { label: input.label } : {}),
          });
          if (!result.ok) return { success: false, error: result.error ?? 'task link failed' };
          return ok({ ...registry.getRef(sessionId, input.taskId) });
        }

        if (input.mode === 'list') {
          // A conversation's own list carries the refs kept before refs had an owner, as every conversation read them.
          const older = options.ownSessionOnly === true && !input.sessionId?.trim() && sessionId !== LEGACY_TASK_NAMESPACE
            ? registry.getRefsBySession(LEGACY_TASK_NAMESPACE) : [];
          const refs = [...registry.getRefsBySession(readSessionId), ...older];
          return ok({
            sessionId: readSessionId,
            view,
            count: refs.length,
            refs: view === 'full' ? refs : refs.map((ref) => summarizeRef(ref)),
          });
        }

        if (input.mode === 'show') {
          if (!input.taskId) return { success: false, error: 'show requires taskId.' };
          const ref = registry.getRef(readSessionId, input.taskId);
          if (!ref) return { success: false, error: `Unknown task ref: ${readSessionId}:${input.taskId}` };
          return ok({
            ref: view === 'full' ? ref : summarizeRef(ref),
            dependencies: registry.getDependencies(readSessionId, input.taskId),
            dependents: registry.getDependents(readSessionId, input.taskId),
          });
        }

        if (input.mode === 'status') {
          if (!input.taskId || !input.status) return { success: false, error: 'status requires taskId and status.' };
          const before = registry.getRef(sessionId, input.taskId);
          if (!before) {
            return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}. Create it with mode=create first.` };
          }
          if (before.status === input.status) {
            return ok({ ...registry.getRef(sessionId, input.taskId), unchanged: true });
          }
          const changed = registry.propagateStatus(sessionId, input.taskId, input.status);
          if (!changed) {
            const verdict = taskLifecycle.check(before.status, input.status);
            const reason = verdict.ok ? `task is ${before.status} and cannot become ${input.status}` : verdict.reason;
            return { success: false, error: `Task ref not updated: ${sessionId}:${input.taskId}: ${reason}. Nothing was changed.` };
          }
          return ok({ ...registry.getRef(sessionId, input.taskId) });
        }

        if (input.mode === 'depend') {
          if (!input.taskId || !input.dependsOnTaskId) {
            return { success: false, error: 'depend requires taskId and dependsOnTaskId.' };
          }
          const ref = registry.getRef(sessionId, input.taskId);
          if (!ref) return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}` };
          const result = registry.linkTask(
            ref,
            {
              sessionId: input.dependsOnSessionId?.trim() || sessionId,
              taskId: input.dependsOnTaskId,
            },
            input.reason,
          );
          if (!result.ok) return { success: false, error: result.error ?? 'dependency link failed' };
          return ok({
            ref,
            dependencies: registry.getDependencies(sessionId, input.taskId),
          });
        }

        if (input.mode === 'cancel') {
          const result = registry.cancel({
            sessionId,
            ...(input.taskId ? { taskId: input.taskId } : {}),
            scope: input.scope ?? 'task',
            requestedAt: Date.now(),
            ...(input.reason ? { reason: input.reason } : {}),
          });
          if (!result.ok) return { success: false, error: result.error ?? 'cancel failed' };
          return ok(result);
        }

        if (input.mode === 'handoff') {
          if (!input.taskId || !input.toSessionId) {
            return { success: false, error: 'handoff requires taskId and toSessionId.' };
          }
          if (!registry.getRef(sessionId, input.taskId)) {
            return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}. Create it with mode=create first.` };
          }
          const result = registry.initiateHandoff(
            { sessionId, taskId: input.taskId },
            sessionId,
            input.toSessionId,
            input.reason,
          );
          if (!result.ok) return { success: false, error: result.error ?? 'handoff failed' };
          return ok({ handoffId: result.handoffId, status: 'blocked', next: `Session ${input.toSessionId} accepts it with mode=acknowledge; you can take it back with mode=withdraw handoffId=${result.handoffId}.` });
        }

        if (input.mode === 'handoffs') {
          const handoffs = registry.getHandoffs();
          const awaiting = handoffs.filter((handoff) => handoff.toSessionId === sessionId && !handoff.acknowledged);
          return ok({
            view,
            count: handoffs.length,
            awaitingThisSession: awaiting.map((handoff) => handoff.handoffId),
            handoffs: view === 'full' ? handoffs : handoffs.map(summarizeHandoff),
          });
        }

        if (input.mode === 'acknowledge') {
          if (!input.handoffId) return { success: false, error: 'acknowledge requires handoffId (see mode=handoffs).' };
          const handoff = registry.getHandoffs().find((record) => record.handoffId === input.handoffId);
          if (!handoff) return { success: false, error: `Unknown handoff: ${input.handoffId}. Nothing was changed. List handoffs with mode=handoffs.` };
          if (handoff.toSessionId !== sessionId) {
            return { success: false, error: `Handoff ${input.handoffId} is addressed to session ${handoff.toSessionId}; only that session can acknowledge it. Nothing was changed.` };
          }
          if (handoff.acknowledged) {
            return ok({ handoffId: handoff.handoffId, acknowledged: true, unchanged: true });
          }
          if (!registry.acknowledgeHandoff(input.handoffId, sessionId)) {
            return { success: false, error: `Handoff ${input.handoffId} is no longer waiting (its source withdrew it, or it expired). Nothing was changed. List handoffs with mode=handoffs.` };
          }
          return ok({ handoffId: input.handoffId, acknowledged: true, taskRef: handoff.taskRef });
        }

        if (input.mode === 'withdraw') {
          if (!input.handoffId) return { success: false, error: 'withdraw requires handoffId (see mode=handoffs).' };
          const result = registry.withdrawHandoff(input.handoffId, sessionId);
          if (!result.ok) return { success: false, error: result.error ?? 'withdraw failed' };
          return ok({ handoffId: input.handoffId, withdrawn: true, taskRef: result.handoff?.taskRef, status: result.status });
        }

        return { success: false, error: `Unknown mode: ${input.mode}` };
      } catch (error) {
        return { success: false, error: summarizeError(error) };
      }
    },
  };
}
