import { directOwnerPlanningInput, isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { captureNativeConversationInput } from '@goodvibes/engine/terminal-shell/native';
import type { WorkHost } from '@goodvibes/engine/terminal-shell/native/work-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand, sessionCapabilityAction } from '@goodvibes/engine/terminal-shell/command-actions';
import { PLAN_OFF, PLAN_ON, PLAN_STATUS, type PlanModeSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import { isPlanMode, togglePlanMode, permissionModeLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import type { PermissionModeValue } from '../../core/permission-mode.ts';

/**
 * Work requests in your own words: the terminal app's part of `/work`
 * (terminal-shell/native/work-command.ts).
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
        throw commandRefusal('The request needs a look before anything else happens.', 'Work, in the menu, shows the input waiting to be admitted.');
      }
    },
  };
}

// Plan mode is this session's read-only posture, set through the platform config surface
// (permissions.mode), the same value the permission manager reads and Shift+Tab cycles. The mode the
// session was in when plan mode was turned on here is put back when it is turned off; plan mode entered
// elsewhere (Shift+Tab) has no remembered mode and leaves to ask-me.
let modeBeforePlan: PermissionModeValue | undefined;
let stopWatchingMode: (() => void) | undefined;
function forgetModeBeforePlan(): void {
  modeBeforePlan = undefined;
  stopWatchingMode?.();
  stopWatchingMode = undefined;
}

/** This session's plan mode, as the plan capabilities take it (capabilities/builtin/plan.ts): the person's and the model's. */
export function planModeServices(ctx: CommandContext): PlanModeSessionServices {
  const configManager = ctx.platform.configManager;
  const currentMode = () => configManager.get('permissions.mode') as PermissionModeValue | undefined;
  return {
    planMode: {
      isOn: () => isPlanMode(currentMode()),
      modeLabel: () => permissionModeLabel(currentMode() ?? 'ask-me'),
      turnOn() {
        stopWatchingMode?.();
        modeBeforePlan = currentMode();
        configManager.setRuntimeOverride('permissions.mode', 'plan');
        // Leaving plan mode any other way (Shift+Tab) ends the remembered mode, so a later
        // re-entry by another route cannot put back a stale, possibly looser mode.
        stopWatchingMode = configManager.subscribe('permissions.mode', (next) => {
          if (!isPlanMode(next as PermissionModeValue)) forgetModeBeforePlan();
        });
        ctx.renderRequest();
      },
      turnOff() {
        const current = currentMode();
        const restored = modeBeforePlan !== undefined && !isPlanMode(modeBeforePlan) ? modeBeforePlan : togglePlanMode(current);
        forgetModeBeforePlan();
        configManager.setRuntimeOverride('permissions.mode', restored);
        ctx.renderRequest();
        return permissionModeLabel(restored);
      },
    },
  };
}

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  const options = { terminalOnly: 'Plan mode belongs to the terminal app\'s session.' };
  registry.register(defineCommand<CommandContext>({
    name: 'plan',
    title: 'Plan mode (nothing is changed)',
    summary: 'Plan without changing anything: writes, commands and network calls are blocked for this session',
    group: 'Permissions',
    report: 'status',
    actions: [PLAN_STATUS, PLAN_ON, PLAN_OFF].map((definition) => sessionCapabilityAction<CommandContext, PlanModeSessionServices>(definition, planModeServices, options)),
  }));
}
