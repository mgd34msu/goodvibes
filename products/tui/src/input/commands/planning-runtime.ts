import { directOwnerPlanningInput, type CommandRegistry } from '../command-registry.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { captureNativeConversationInput } from '@goodvibes-jev/engine/terminal-shell/native';
import { openModalCommand, requirePlanManager } from './runtime-services.ts';
import { isPlanMode, togglePlanMode, permissionModeLabel } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import type { PermissionModeValue } from '../../core/permission-mode.ts';

/**
 * The closed set of /project-plan subcommands and how many words each takes
 * after its name. Anything else is a goal; `--` makes the rest a goal even when
 * it starts with one of these words.
 */
const PLANNING_SUBCOMMANDS: ReadonlyMap<string, { readonly min: number; readonly max: number; readonly usage: string }> = new Map([
  ['panel', { min: 0, max: 0, usage: 'panel' }],
  ['history', { min: 0, max: 0, usage: 'history' }],
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
/** Retired with the planning interview: saved planning records are read-only history. */
const RETIRED_SUBCOMMANDS = new Set(['approve', 'answer']);

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'project-plan',
    aliases: ['planning'],
    description: 'Submit a native work request, inspect recovery, or review historical planning',
    usage: '[panel | history | dismiss | list | show <id> | mode | explain | override <strategy> | status | clear | <planning goal> | -- <goal that starts with one of these words>]',
    argsHint: '[panel|history|<goal>|-- <goal>]',
    async handler(rawArgs, ctx) {
      const first = rawArgs[0]?.toLowerCase();
      const explicitGoal = first === '--';
      const subcommand = !explicitGoal && first !== undefined ? PLANNING_SUBCOMMANDS.get(first) : undefined;
      if (!explicitGoal && first !== undefined && RETIRED_SUBCOMMANDS.has(first)) {
        ctx.print([
          `"/project-plan ${first}" is retired: saved planning records are read-only and nothing was changed.`,
          '  Track work in the work plan (/work-plan) and run it with /workstream.',
          `  To submit this text as a goal: /project-plan -- ${rawArgs.join(' ')}`,
        ].join('\n'));
        return;
      }
      if (subcommand) {
        const extra = rawArgs.length - 1;
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

      const openProjectPlanningModal = () => openModalCommand(ctx, 'planning-modal');

      if (args.length === 0 || (subcommand && args[0] === 'panel')) {
        openModalCommand(ctx, 'native-work-ledger-modal');
        ctx.print('Opened native work and recovery. Saved historical planning is available with /project-plan history.');
        return;
      }

      if (subcommand && args[0] === 'history') {
        openProjectPlanningModal();
        ctx.print('Opened saved historical project planning (read-only). The work plan and /workstream are the live plan.');
        return;
      }

      if (subcommand && args[0] === 'list') {
        const planManager = requirePlanManager(ctx);
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('The work plan has no items. Add one with /work-plan add <title>.');
          return;
        }
        ctx.print(`Plans (${plans.length}; the project work plan is the plan, changed with /work-plan):\n${plans.map((plan) => {
          const marker = plan.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title} (${plan.items.length} item${plan.items.length === 1 ? '' : 's'})`;
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

      // The active plan is the project work plan; there is no separate record
      // to archive, so the command changes nothing and names what does.
      if (subcommand && args[0] === 'dismiss') {
        ctx.print([
          'Nothing was dismissed: the active plan is the project work plan, which has no separate record to archive.',
          '  Clear finished items: /work-plan clear-done',
          '  Drop one item: /work-plan cancel <id> or /work-plan remove <id>',
        ].join('\n'));
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
  // elsewhere (Shift+Tab) has no remembered mode and exits to ask-me.
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
        ctx.print(`[Permissions] Plan mode is not on; mode stays ${permissionModeLabel(current ?? 'ask-me')}. Use /plan on to enter it.`);
        return;
      }
      const restored = modeBeforePlan !== undefined && !isPlanMode(modeBeforePlan) ? modeBeforePlan : togglePlanMode(current);
      forgetModeBeforePlan();
      configManager.set('permissions.mode', restored);
      ctx.print(`[Permissions] Plan mode OFF; mode: ${permissionModeLabel(restored)}.`);
    },
  });
}
