import { directOwnerPlanningInput, isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { captureNativeConversationInput } from '@goodvibes/engine/terminal-shell/native';
import type { WorkHost } from '@goodvibes/engine/terminal-shell/native/work-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { openModalCommand, requirePlanManager } from './runtime-services.ts';
import { isPlanMode, togglePlanMode, permissionModeLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import type { PermissionModeValue } from '../../core/permission-mode.ts';

/**
 * Work requests in your own words, the planner and past planning records:
 * the terminal app's part of `/work` (terminal-shell/native/work-command.ts).
 */
export function workRequestsHost(): Exclude<WorkHost<CommandContext>['requests'], { readonly unavailable: string }> {
  return {
    async submit(ctx, goal) {
      // The owner typing the line is the fact that it is a request: no model is asked.
      const source = directOwnerPlanningInput(ctx)
        ?? (isDirectOwnerCommandContext(ctx, 'work') ? captureNativeConversationInput(goal) : undefined);
      if (!source) throw commandRefusal('A work request is your own words typed in the terminal; nothing was sent.', 'Type /work request <what you want done>.');
      if (!source.text.trim()) throw commandRefusal('Say what you want done; nothing was sent.');
      if (!ctx.dispatchNativeIntakeTurn) throw commandRefusal('Admitting input is not available here; nothing was started.');
      try {
        // The durable native intake owns admission, cancellation, retries and recovery.
        const state = await routeNativeConversationInput({ intake: ctx.nativeConversationIntake, source,
          notify: (line) => ctx.print(line), dispatch: ctx.dispatchNativeIntakeTurn });
        // Refused because another input is still being admitted: nothing was sent.
        if (state?.status === 'pending') ctx.restoreDraft?.(`/work request ${goal}`);
        ctx.renderRequest();
      } catch {
        throw commandRefusal('The request needs a look before anything else happens.', '/work intake shows where the input stands.');
      }
    },
    openHistory(ctx) {
      openModalCommand(ctx, 'planning-modal');
    },
    plans(ctx) {
      const plans = requirePlanManager(ctx).list();
      if (plans.length === 0) return 'No past plans. The live plan is the to-do list: /todo.';
      return [
        `Past plans (${plans.length}; the live plan is the to-do list, /todo):`,
        ...plans.map((plan) => `  ${plan.status === 'active' ? '▶' : ' '} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title} (${plan.items.length} item${plan.items.length === 1 ? '' : 's'})`),
      ].join('\n');
    },
    plan(ctx, id) {
      const manager = requirePlanManager(ctx);
      const plan = manager.list().find((entry) => entry.id === id || entry.id.startsWith(id));
      if (!plan) throw commandRefusal(`No past plan ${id}.`, '/work plans lists them.');
      return manager.toMarkdown(plan);
    },
    planner(ctx, act, value) {
      if (!ctx.ops.planRuntime) throw commandRefusal('The planner is not available in this session.');
      const result = ctx.ops.planRuntime(act, value ? [value] : []);
      if (!result.ok) throw commandRefusal(result.output);
      return result.output;
    },
  };
}

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  // /plan enters and leaves the session's plan mode (a read-only posture),
  // through the platform config surface (permissions.mode), the same value the
  // permission manager reads and Shift+Tab cycles. The mode the session was in
  // when /plan turned plan mode on is put back when it is turned off; plan mode
  // entered elsewhere (Shift+Tab) has no remembered mode and leaves to ask-me.
  let modeBeforePlan: PermissionModeValue | undefined;
  let stopWatchingMode: (() => void) | undefined;
  const forgetModeBeforePlan = (): void => {
    modeBeforePlan = undefined;
    stopWatchingMode?.();
    stopWatchingMode = undefined;
  };
  const currentMode = (ctx: CommandContext) => ctx.platform.configManager.get('permissions.mode') as PermissionModeValue | undefined;
  registry.register(defineCommand<CommandContext>({
    name: 'plan',
    title: 'Plan mode (nothing is changed)',
    summary: 'Plan without changing anything: writes, commands and network calls are blocked for this session',
    group: 'Permissions',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See whether plan mode is on', word: 'status',
        sentence: 'Says whether plan mode is on, and the mode in force.',
        operator: { terminalOnly: 'Plan mode belongs to the terminal app\'s session.' },
        async rowValue(ctx) { return isPlanMode(currentMode(ctx)) ? 'on' : 'off'; },
        async run(_values, ctx) {
          const current = currentMode(ctx);
          return isPlanMode(current)
            ? 'Plan mode is on: writes, commands and network calls are blocked. /plan off leaves it.'
            : `Plan mode is off; the mode is ${permissionModeLabel(current ?? 'ask-me')}. /plan on enters it.`;
        },
      }),
      {
        id: 'on', label: 'Turn plan mode on', word: 'on', inputs: [],
        sentence: 'Writes, commands and network calls are blocked for this session only; your saved mode is not changed.', done: '',
        touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'off',
        operator: { terminalOnly: 'Plan mode belongs to the terminal app\'s session.' }, example: {},
        async run(_values, ctx) {
          const configManager = ctx.platform.configManager;
          const current = currentMode(ctx);
          if (isPlanMode(current)) return 'Plan mode is already on; nothing changed.';
          stopWatchingMode?.();
          modeBeforePlan = current;
          configManager.setRuntimeOverride('permissions.mode', 'plan');
          // Leaving plan mode any other way (Shift+Tab) ends the remembered mode, so a later
          // re-entry by another route cannot put back a stale, possibly looser mode.
          stopWatchingMode = configManager.subscribe('permissions.mode', (next) => {
            if (!isPlanMode(next as PermissionModeValue)) forgetModeBeforePlan();
          });
          return 'Plan mode is on: writes, commands and network calls are blocked until /plan off or Shift+Tab.';
        },
      },
      {
        id: 'off', label: 'Turn plan mode off', word: 'off', inputs: [],
        sentence: 'Writes, commands and network calls are allowed again under the mode you had before, for this session only.', done: '',
        touches: 'this-machine', lasts: 'session', risk: 'loosens-a-protection', undoneBy: 'on',
        ownerOnly: { reason: 'leaving plan mode lets the session change things again', instead: 'Ask the owner to turn plan mode off with /plan off or Shift+Tab.' },
        operator: { terminalOnly: 'Plan mode belongs to the terminal app\'s session.' }, example: {},
        async run(_values, ctx) {
          const current = currentMode(ctx);
          if (!isPlanMode(current)) return `Plan mode is not on; the mode stays ${permissionModeLabel(current ?? 'ask-me')}.`;
          const restored = modeBeforePlan !== undefined && !isPlanMode(modeBeforePlan) ? modeBeforePlan : togglePlanMode(current);
          forgetModeBeforePlan();
          ctx.platform.configManager.setRuntimeOverride('permissions.mode', restored);
          return `Plan mode is off; the mode is ${permissionModeLabel(restored)}.`;
        },
      },
    ],
  }));
}
