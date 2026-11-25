import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { daemonCapabilityAction, defineCommand, type FixedChoice } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { BUDGET_ALERT_USD_CONFIG_KEY } from '@goodvibes/engine/platform/platform/providers';
import { USAGE_BY_SOURCE } from '@goodvibes/engine/platform/platform/capabilities';
import { capabilityBinding } from './capability-binding.ts';

const USAGE_TABS: readonly FixedChoice[] = [
  { value: 'overview', label: 'Overview', help: 'Context pressure, tokens and cost' },
  { value: 'turns', label: 'Turn by turn' },
  { value: 'agents', label: 'Per agent' },
];

/**
 * `/usage`, described once (command-actions/): the Usage view, the spending
 * alert (`behavior.budgetAlertUsd`, the setting the Usage view's b key and the
 * budget notifier read) and cost by who spent it, from the daemon.
 */
const USAGE_COMMAND = defineCommand<CommandContext>({
  name: 'usage', title: 'Usage', summary: 'Tokens, cost and context pressure, the spending alert, and cost by who spent it', group: 'Models', report: 'open',
  actions: [
    doAction<CommandContext>({
      id: 'open', label: 'See usage and cost', word: 'open', touches: 'reads',
      inputs: [choiceInput({ id: 'tab', label: 'Show', help: 'Which part of the Usage view', choices: USAGE_TABS, typed: { position: 1 }, optional: { default: 'overview', means: 'the overview' } })],
      sentence: 'Opens the Usage view: context pressure, this session\'s tokens and cost, turn by turn and per agent.',
      operator: { terminalOnly: 'It is a terminal screen.' }, example: { tab: 'turns' },
      async run(values, ctx) {
        if (!ctx.openUsage) throw commandRefusal('The Usage view is not available in this session.');
        ctx.openUsage({ tab: values.tab === 'turns' || values.tab === 'agents' ? values.tab : undefined });
      },
    }),
    {
      id: 'alert', label: 'Set a spending alert', word: 'alert',
      inputs: [textInput({ id: 'usd', label: 'Dollars', help: 'Warn when this session\'s cost passes it; 0 turns the alert off', why: 'an amount in dollars', kind: 'money', typed: { position: 1 } })],
      sentence: 'You will be warned when this session\'s cost passes ${usd} (0 turns the warning off), until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { method: 'config.set', fields: { key: `="${BUDGET_ALERT_USD_CONFIG_KEY}"`, value: 'usd:number' } }, example: { usd: '5' },
      async run(values, ctx) {
        const usd = Number(values.usd);
        if (!Number.isFinite(usd) || usd < 0) throw commandRefusal(`"${values.usd}" is not an amount of dollars; nothing was set.`);
        const config = ctx.platform.configManager;
        config.set(BUDGET_ALERT_USD_CONFIG_KEY as Parameters<typeof config.set>[0], usd as never);
        ctx.renderRequest();
        return usd > 0 ? `Spending alert set to $${usd.toFixed(2)}.` : 'Spending alert turned off.';
      },
    },
    // Money (platform capabilities/builtin/money.ts): the daemon's cost records, every split, in the daemon.
    daemonCapabilityAction<CommandContext>(USAGE_BY_SOURCE, capabilityBinding),
  ],
});

export function registerCostRuntimeCommands(registry: CommandRegistry): void {
  registry.register(USAGE_COMMAND);
}
