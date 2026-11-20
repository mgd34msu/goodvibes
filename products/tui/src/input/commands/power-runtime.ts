import { KEEP_AWAKE_NOT_HELD } from '@goodvibes/engine/platform/platform/power';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand, type ActionDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { powerStatusLines, type PowerSurfaceState } from '../../core/power-status.ts';

/** The surface state carries the platform's refused note when keep-awake is on but the OS granted nothing. */
function keepAwakeRefused(state: PowerSurfaceState): boolean {
  return state.keepAwake && state.note === KEEP_AWAKE_NOT_HELD;
}

// ---------------------------------------------------------------------------
// /power, host sleep ownership, described once (command-actions/).
//
// Shows the honest account of sleep ownership, the "sleep disabled" chip
// meaning, each "held because X" work-inhibition reason, and the lid-split note
// rendered VERBATIM when the OS could block idle-sleep but not lid-close
// suspend, and turns the daemon-held keep-awake switch on or off. Owner ruling:
// the always-visible chip IS the safety mechanism, so there is no timer and no
// AC-only option.
// ---------------------------------------------------------------------------

function setKeepAwake(on: boolean): ActionDescription<CommandContext> {
  return {
    id: on ? 'on' : 'off', label: on ? 'Keep this computer awake' : 'Let this computer sleep again', word: on ? 'on' : 'off', inputs: [],
    sentence: on
      ? 'This computer will not sleep when idle, until you change it; the status bar shows it while it holds.'
      : 'This computer may sleep when idle again, until you change it; work that holds it awake still does.',
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: on ? 'off' : 'on',
    operator: { terminalOnly: 'The web UI turns keep-awake on and off from its own power switch.' }, example: {},
    async run(_values, ctx) {
      if (!ctx.setKeepAwake || !ctx.getPowerState) throw commandRefusal('Keep-awake cannot be changed in this session.');
      const state = await ctx.setKeepAwake(on);
      return [
        keepAwakeRefused(state)
          ? 'Keep-awake is on, but the OS refused the sleep inhibitor: this computer can still sleep.'
          : state.keepAwake ? 'Keep-awake is on: this computer will not idle-sleep.' : 'Keep-awake is off.',
        // The honest lid-split note, verbatim, when the platform served one.
        ...(state.note ? [`  ${state.note}`] : []),
      ].join('\n');
    },
  };
}

export function registerPowerRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'power',
    title: 'Sleep',
    summary: 'See whether this computer may sleep, and keep it awake',
    group: 'Shell',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See whether this computer may sleep', word: 'status',
        sentence: 'Shows who holds this computer awake and why, and whether keep-awake is on.',
        async run(_values, ctx) {
          const state = ctx.getPowerState?.();
          if (!state) throw commandRefusal('Power status is not available in this session.');
          return [
            'Sleep',
            ...powerStatusLines(state).map((line) => `  ${line}`),
            keepAwakeRefused(state)
              ? 'Keep-awake is on but not holding: the OS refused it, so this computer can still sleep. Try again: /power on'
              : state.keepAwake ? 'Keep-awake is on. Let it sleep: /power off' : 'Keep-awake is off. Keep it awake: /power on',
          ].join('\n');
        },
      }),
      setKeepAwake(true),
      setKeepAwake(false),
    ],
  }));
}
