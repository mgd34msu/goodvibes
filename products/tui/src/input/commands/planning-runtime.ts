import { directOwnerPlanningInput, type CommandRegistry } from '../command-registry.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { captureNativeConversationInput } from '@goodvibes-jev/engine/terminal-shell/native';
import { openModalCommand, requirePlanManager } from './runtime-services.ts';
import { isPlanMode, togglePlanMode, permissionModeLabel, type PermissionModeValue } from '../../core/permission-mode.ts';
import { parsePlanningActionTarget } from './planning-action-target.ts';

/**
 * The closed set of /project-plan subcommands and how many words each takes
 * after its name. Anything else is a goal; `--` makes the rest a goal even when
 * it starts with one of these words.
 */
const PLANNING_SUBCOMMANDS: ReadonlyMap<string, { readonly min: number; readonly max: number; readonly usage: string }> = new Map([
  ['panel', { min: 0, max: 0, usage: 'panel' }],
  ['history', { min: 0, max: 0, usage: 'history' }],
  ['approve', { min: 0, max: 0, usage: 'approve' }],
  ['answer', { min: 2, max: Number.POSITIVE_INFINITY, usage: 'answer <n> <text>' }],
  ['list', { min: 0, max: 0, usage: 'list' }],
  ['show', { min: 1, max: 1, usage: 'show <plan-id>' }],
  ['dismiss', { min: 0, max: 0, usage: 'dismiss' }],
  ['mode', { min: 0, max: 1, usage: 'mode [strategy]' }],
  ['explain', { min: 0, max: 0, usage: 'explain' }],
  ['override', { min: 1, max: 1, usage: 'override <strategy>' }],
  ['status', { min: 0, max: 0, usage: 'status' }],
  ['clear', { min: 0, max: 0, usage: 'clear' }],
]);
const PLANNER_RUNTIME_SUBCOMMANDS = new Set(['mode', 'explain', 'override', 'status', 'clear']);

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'project-plan',
    aliases: ['planning'],
    description: 'Submit a native work request, inspect recovery, or review historical planning',
    usage: '[panel | history | approve | dismiss | answer <n> <text> | list | show <id> | mode | explain | override <strategy> | status | clear | <planning goal> | -- <goal that starts with one of these words>]',
    argsHint: '[panel|history|<goal>|-- <goal>]',
    async handler(rawArgs, ctx) {
      const first = rawArgs[0]?.toLowerCase();
      const explicitGoal = first === '--';
      const subcommand = !explicitGoal && first !== undefined ? PLANNING_SUBCOMMANDS.get(first) : undefined;
      if (subcommand) {
        // A selected-revision target (the flag and its three values) comes from the history view, not typed text.
        const extra = rawArgs.length - 1 - (rawArgs[1] === '--selected-revision' ? 4 : 0);
        if (extra < subcommand.min || extra > subcommand.max) {
          const words = rawArgs.join(' ');
          ctx.print([
            `"/project-plan ${first}" takes ${subcommand.max === 0 ? 'no further words' : `the form /project-plan ${subcommand.usage}`}, so nothing was run.`,
            `  To run the subcommand: /project-plan ${subcommand.usage}`,
            `  To submit this text as a goal: /project-plan -- ${words}`,
          ].join('\n'));
          return;
        }
      }
      const args = subcommand ? [first!, ...rawArgs.slice(1)] : rawArgs;
      if (subcommand && PLANNER_RUNTIME_SUBCOMMANDS.has(first!)) {
        const result = ctx.ops.planRuntime
          ? ctx.ops.planRuntime(first!, args.slice(1))
          : { ok: false, output: 'Plan runtime bridge is not available in this runtime.' };
        ctx.print(result.output);
        return;
      }

      const projectPlanningService = ctx.workspace.projectPlanningService;
      const projectId = ctx.workspace.projectPlanningProjectId;
      const openProjectPlanningModal = () => openModalCommand(ctx, 'planning-modal');

      if (args.length === 0 || (subcommand && args[0] === 'panel')) {
        openModalCommand(ctx, 'native-work-ledger-modal');
        ctx.print('Opened native work and recovery. Saved historical planning is available with /project-plan history.');
        return;
      }

      if (subcommand && args[0] === 'history') {
        openProjectPlanningModal();
        ctx.print('Opened saved historical project planning. The planning interview is retired; saved answers and approvals do not authorize native work.');
        return;
      }

      if (subcommand && args[0] === 'approve') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const target = parsePlanningActionTarget(args.slice(1));
        if (!target.valid || target.args.length) {
          ctx.print('Invalid planning selection. Reload saved history before retrying the explicit historical approval command.');
          return;
        }
        const result = await projectPlanningService.applyStateAction({
          projectId, expected: target.expected, ...(target.planningId ? { planningId: target.planningId } : {}), action: { kind: 'approve' },
        });
        if (!result.applied) {
          ctx.print(result.reason === 'no-state' ? 'No historical project planning state exists to approve.' : 'Planning changed. Reload saved history before retrying the explicit historical approval command.');
          return;
        }
        openProjectPlanningModal();
        ctx.print(`Historical planning approval recorded; no native work authorized. State: ${result.state.id}.`);
        return;
      }

      if (subcommand && args[0] === 'list') {
        const planManager = requirePlanManager(ctx);
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('No plans found.');
          return;
        }
        ctx.print(`Plans (${plans.length}):\n${plans.map((plan) => {
          const marker = plan.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title}`;
        }).join('\n')}`);
        return;
      }

      if (subcommand && args[0] === 'show') {
        const planManager = requirePlanManager(ctx);
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /project-plan show <plan-id>');
          return;
        }
        const plans = planManager.list();
        const plan = plans.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!plan) {
          ctx.print(`Plan not found: ${id}`);
          return;
        }
        ctx.print(planManager.toMarkdown(plan));
        return;
      }

      // Explicit historical archival only. The current native request and its
      // retained recovery source are untouched; mid-execution is refused.
      if (subcommand && args[0] === 'dismiss') {
        const planManager = requirePlanManager(ctx);
        const dismissal = planManager.dismiss(ctx.session.runtime.sessionId);
        if (dismissal.outcome === 'requires-cancel') {
          ctx.print(
            `Plan "${dismissal.blockedBy?.title ?? 'active plan'}" is mid-execution and was not dismissed. ` +
            `Run /workstream cancel to stop it first, then /project-plan dismiss.`,
          );
          return;
        }
        let planningNote = '';
        if (projectPlanningService && projectId) {
          const current = await projectPlanningService.getState({ projectId });
          if (current.state && current.state.metadata?.['active'] === true) {
            if (!current.revision) {
              planningNote = ' Historical project planning record was not changed because its revision is unavailable. Refresh and retry.';
            } else {
              const result = await projectPlanningService.applyStateAction({ projectId,
                planningId: current.state.id, expected: { kind: 'revision', revision: current.revision },
                action: { kind: 'dismiss' },
              });
              planningNote = result.applied
                ? ' Historical project planning record marked inactive.'
                : ` Historical project planning record was not changed (${result.reason}); refresh and retry.`;
            }
          }
        }
        if (dismissal.outcome === 'dismissed') {
          ctx.print(
            `Dismissed plan "${dismissal.plan?.title ?? 'active plan'}" ` +
            `(archived as dismissed; retained in /project-plan list).${planningNote}`,
          );
        } else if (planningNote) {
          ctx.print(`No active execution plan to dismiss.${planningNote}`);
        } else {
          ctx.print('No active plan or planning state to dismiss.');
        }
        return;
      }

      // Explicit historical record editing only. The platform guards the selected
      // source revision; its evaluation hints never reopen an interview here.
      if (subcommand && args[0] === 'answer') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const target = parsePlanningActionTarget(args.slice(1));
        if (!target.valid) {
          ctx.print('Invalid planning selection. Reload saved history before retrying the explicit historical answer command.');
          return;
        }
        const ref = target.args[0];
        const answerText = target.args.slice(1).join(' ').trim();
        if (!ref || !answerText) {
          ctx.print('Usage: /project-plan answer <question-number|question-id> <your answer>');
          return;
        }
        const asNum = Number(ref);
        const selector = !target.selected && Number.isInteger(asNum) && asNum >= 1
          ? { questionIndex: asNum - 1 }
          : { questionId: ref };
        const answerResult = await projectPlanningService.applyStateAction({
          projectId, expected: target.expected, ...(target.planningId ? { planningId: target.planningId } : {}),
          action: { kind: 'answer', ...selector, answer: answerText },
        });
        if (!answerResult.applied) {
          if (answerResult.reason === 'no-state') {
            ctx.print('No historical project planning state exists to answer. New goals use native intake with /project-plan <goal>.');
          } else if (answerResult.reason === 'state-changed') {
            ctx.print('Planning changed. Reload saved history before retrying the explicit historical answer command.');
          } else if (answerResult.reason === 'question-not-found') {
            const open = answerResult.state?.openQuestions ?? [];
            const listing = open.length > 0
              ? open.map((question, index) => `  ${index + 1}. ${question.prompt} (${question.id})`).join('\n')
              : '  (no open questions)';
            ctx.print(`No open question matched "${ref}". Open questions:\n${listing}`);
          } else {
            ctx.print('Usage: /project-plan answer <question-number|question-id> <your answer>');
          }
          return;
        }
        openProjectPlanningModal();
        ctx.print(
          `Recorded historical answer to: ${answerResult.question?.prompt ?? 'question'}\n` +
          'The planning interview is retired; no native work authorized.',
        );
        return;
      }

      // Everything that is not a subcommand is the goal, taken as typed. The owner
      // typing the command is the fact that it is a goal: no model is asked.
      const typed = directOwnerPlanningInput(ctx);
      if (!typed) {
        ctx.print('Submit a new request from the terminal with /project-plan <goal> or /planning <goal>. Original owner input is required.');
        return;
      }
      const source = explicitGoal ? captureNativeConversationInput(typed.text.replace(/^\s*--(?:\r\n|\s|$)/, '')) : typed;
      if (!source.text.trim()) { ctx.print('Usage: /project-plan <goal>  (or /project-plan -- <goal> for a goal that starts with a subcommand word)'); return; }
      if (!ctx.dispatchNativeIntakeTurn) {
        ctx.print('Native conversation intake is unavailable. No ordinary turn or historical planning state was started.');
        return;
      }
      try {
        // The durable native intake owns admission, cancellation, retries and recovery.
        const state = await routeNativeConversationInput({ intake: ctx.nativeConversationIntake, source,
          notify: line => ctx.print(line), dispatch: ctx.dispatchNativeIntakeTurn });
        // Refused because another input is still being admitted: nothing was sent.
        if (state?.status === 'pending') ctx.restoreDraft?.(`/project-plan ${typed.text}`);
        ctx.renderRequest();
      } catch {
        ctx.print('Planning submission requires inspection. Use /work intake-status to inspect any durable native input.');
      }
    },
  });

  // /plan now enters/toggles the SESSION PERMISSION plan mode (read-only
  // planning posture), distinct from the project-planning manager above, which
  // moved to /project-plan (alias /planning). The change goes through the platform
  // config surface (permissions.mode), the same value the PermissionManager
  // reads and Shift+Tab cycles, so plan mode is one concept across surfaces.
  // The mode the session was in when /plan turned plan mode on, so leaving
  // plan mode puts the user's chosen permission posture back. Plan mode entered
  // elsewhere (Shift+Tab) has no remembered mode and exits to safe-owner.
  let modeBeforePlan: PermissionModeValue | undefined;
  let stopWatchingMode: (() => void) | undefined;
  const forgetModeBeforePlan = (): void => {
    modeBeforePlan = undefined;
    stopWatchingMode?.();
    stopWatchingMode = undefined;
  };
  registry.register({
    name: 'plan',
    description: 'Enter or exit plan mode, a read-only planning posture where writes, commands, and network calls are blocked',
    usage: '[on | off | toggle]',
    argsHint: '[on|off]',
    handler(args, ctx) {
      const configManager = ctx.platform.configManager;
      const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
      const sub = (args[0] ?? 'toggle').toLowerCase();
      const inPlan = isPlanMode(current);
      const wantsOn = sub === 'on' || sub === 'enter' || (sub !== 'off' && sub !== 'exit' && !inPlan);
      if (wantsOn) {
        if (inPlan) {
          ctx.print('[Permissions] Plan mode is already ON; nothing changed.');
          return;
        }
        stopWatchingMode?.();
        modeBeforePlan = current;
        configManager.set('permissions.mode', 'plan');
        // Leaving plan mode any other way (Shift+Tab) ends the remembered posture, so a later
        // re-entry by another route cannot restore a stale, possibly more permissive mode.
        stopWatchingMode = configManager.subscribe('permissions.mode', (next) => {
          if (!isPlanMode(next as PermissionModeValue)) forgetModeBeforePlan();
        });
        ctx.print('[Permissions] Plan mode ON; read-only: writes, commands, and network calls are blocked until you exit (/plan off or Shift+Tab).');
        return;
      }
      if (!inPlan) {
        ctx.print(`[Permissions] Plan mode is not on; mode stays ${permissionModeLabel(current ?? 'safe-owner')}. Use /plan on to enter it.`);
        return;
      }
      const restored = modeBeforePlan !== undefined && !isPlanMode(modeBeforePlan) ? modeBeforePlan : togglePlanMode(current);
      forgetModeBeforePlan();
      configManager.set('permissions.mode', restored);
      ctx.print(`[Permissions] Plan mode OFF; mode: ${permissionModeLabel(restored)}.`);
    },
  });
}
