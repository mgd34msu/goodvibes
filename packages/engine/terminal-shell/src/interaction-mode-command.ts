/**
 * `/verbosity`, described once (command-actions/) for both terminal apps: how
 * much the app prints (quiet, balanced or operator), and one kind of
 * notification's own level. Saved as the `behavior.hitlMode` setting.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ShellModeManagerService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { readAction, textInput } from './described-command-kit.js';

export interface InteractionModeContext extends CommandActionContext {
  readonly ops: { readonly modeManager?: ShellModeManagerService | null | undefined };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'setDynamic'> };
  readonly renderRequest: () => void;
}

function managerOf(ctx: InteractionModeContext): ShellModeManagerService {
  const manager = ctx.ops.modeManager;
  if (!manager) throw commandRefusal('The print level is not available in this runtime.');
  return manager;
}

/** Register `/verbosity` (one description for both apps). */
export function registerInteractionModeCommand<Context extends InteractionModeContext>(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
  registry.register(defineCommand<Context>({
    name: 'verbosity',
    title: 'How much the app prints',
    summary: 'Set how much the app prints: quiet, balanced or operator',
    group: 'Display',
    report: 'show',
    actions: [
      readAction<Context>({
        id: 'show', label: 'See how much the app prints', readsOnlyThisMachine: true, word: 'show',
        sentence: 'Shows the print level, what it does, and any kind of notification set on its own.',
        async run(_values, ctx) {
          const mgr = managerOf(ctx);
          const current = mgr.getHITLMode();
          const preset = mgr.getHITLPreset();
          const overrides = Object.entries(mgr.getDomainOverrides());
          return [
            `Print level: ${current}`,
            `  ${preset.description}`,
            `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
            `  Quiet-while-typing: ${preset.quietWhileTyping}`,
            `  Batch window: ${preset.batchWindowMs}ms`,
            ...(overrides.length > 0 ? ['  Per-domain overrides:', ...overrides.map(([domain, verbosity]) => `    ${domain}: ${verbosity}`)] : ['  No per-domain overrides.']),
            '',
            'Available presets:',
            ...mgr.listHITLPresets().map((p) => `  ${p.name === current ? '▶' : ' '} ${p.name.padEnd(10)} ${p.description}`),
          ].join('\n');
        },
      }),
      {
        id: 'set', label: 'Set how much the app prints', word: 'set',
        inputs: [{
          id: 'level', label: 'Print level', help: 'How much reaches you as it happens', kind: 'choice', required: true, typed: { position: 1 },
          choices: [
            { value: 'quiet', label: 'Quiet', help: 'Only warnings and errors pop up; the rest waits in /notifications.' },
            { value: 'balanced', label: 'Balanced', help: 'Notices pop up; routine notifications wait in /notifications (the usual).' },
            { value: 'operator', label: 'Operator', help: 'Every notice and notification pops up.' },
          ],
        }],
        sentence: 'The app prints at the {level} level until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: 'It is how this terminal app prints.' }, example: { level: 'quiet' },
        async run(values, ctx) {
          const mgr = managerOf(ctx);
          const level = values.level as 'quiet' | 'balanced' | 'operator';
          // Setting the level clears the per-domain levels; the reply names the ones that went.
          const clearedDomains = Object.keys(mgr.getDomainOverrides());
          mgr.setHITLMode(level);
          let saveFailure: string | null = null;
          try {
            ctx.platform.configManager.setDynamic('behavior.hitlMode' as ConfigKey, level);
          } catch (e) {
            logger.warn('[/verbosity] Failed to persist mode', { error: summarizeError(e) });
            saveFailure = summarizeError(e);
          }
          const preset = mgr.getHITLPreset();
          ctx.renderRequest();
          const cleared = clearedDomains.length > 0
            ? `\nCleared the per-domain levels for: ${clearedDomains.join(', ')} (set them again with /verbosity set-domain).`
            : '';
          return saveFailure === null
            ? `Print level set to: ${preset.name}\n${preset.description}${cleared}`
            : `Print level set to: ${preset.name} for this session only. It could not be saved (${saveFailure}), so it reverts on restart.\n${preset.description}${cleared}`;
        },
      },
      {
        id: 'set-domain', label: 'Set one kind of notification\'s level', word: 'set-domain',
        inputs: [
          textInput({ id: 'domain', label: 'Kind of notification', help: 'A notification domain, as /notifications shows it', why: 'a domain name from /notifications', typed: { position: 1 } }),
          { id: 'verbosity', label: 'How much of it', help: 'How much of this kind reaches you', kind: 'choice', required: true, typed: { position: 2 },
            choices: [{ value: 'minimal', label: 'Minimal' }, { value: 'normal', label: 'Normal' }, { value: 'verbose', label: 'Verbose' }] },
        ],
        sentence: 'Notifications of {domain} are shown at {verbosity} for this session only.', done: '',
        touches: 'this-machine', lasts: 'session', risk: 'none',
        operator: { terminalOnly: 'It is how this terminal app prints.' }, example: { domain: 'agents', verbosity: 'minimal' },
        async run(values, ctx) {
          managerOf(ctx).setDomainVerbosity(values.domain!, values.verbosity as 'minimal' | 'normal' | 'verbose');
          return `Domain "${values.domain}" verbosity set to: ${values.verbosity}; it applies to notifications of that domain as they arrive.`;
        },
      },
    ],
  }));
}
