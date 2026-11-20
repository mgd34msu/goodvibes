import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, type FixedChoice } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, doAction, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { BUDGET_ALERT_USD_CONFIG_KEY } from '@goodvibes-jev/engine/platform/platform/providers';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import {
  COST_ATTRIBUTION_OPTIONAL_DIMENSIONS,
  COST_ATTRIBUTION_PRIMARY_DIMENSIONS,
  formatCostAttributionSection,
  type CostAttributionResult,
  type CostWindow,
} from './cost-attribution-format.ts';

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
      operator: { method: 'config.set', fields: { value: 'usd' } }, example: { usd: '5' },
      async run(values, ctx) {
        const usd = Number(values.usd);
        if (!Number.isFinite(usd) || usd < 0) throw commandRefusal(`"${values.usd}" is not an amount of dollars; nothing was set.`);
        const config = ctx.platform.configManager;
        config.set(BUDGET_ALERT_USD_CONFIG_KEY as Parameters<typeof config.set>[0], usd as never);
        ctx.renderRequest();
        return usd > 0 ? `Spending alert set to $${usd.toFixed(2)}.` : 'Spending alert turned off.';
      },
    },
    readAction<CommandContext>({
      id: 'attribution', label: 'See cost by who spent it', word: 'by-source',
      inputs: [
        choiceInput({ id: 'window', label: 'Over', help: 'How far back', choices: [{ value: '24h', label: 'The last 24 hours' }, { value: '7d', label: 'The last 7 days' }], typed: { position: 1 }, optional: { default: '24h', means: 'the last 24 hours' } }),
        choiceInput({ id: 'as', label: 'As', help: 'Text, or JSON for programs', choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], typed: { flag: '--as' }, optional: { default: 'text', means: 'text' } }),
      ],
      sentence: 'Shows what the daemon spent, split by agent, model, provider and the other ways it records cost.',
      operator: { method: 'cost.attribution.get', fields: { window: 'window' } }, example: { window: '7d' },
      async run(values, ctx) {
      const window = (values.window || '24h') as CostWindow;
      const asJson = values.as === 'json';
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) throw commandRefusal(`Cost attribution needs the daemon: ${rpc.reason}`);
      const dimensions = [...COST_ATTRIBUTION_PRIMARY_DIMENSIONS, ...COST_ATTRIBUTION_OPTIONAL_DIMENSIONS];
      const results: CostAttributionResult[] = [];
      try {
        for (const dimension of dimensions) {
          results.push(await rpc.platformClient.operator.invoke('cost.attribution.get', { window, dimension }));
        }
      } catch (error) {
        throw commandRefusal(`The daemon did not answer: ${describeOperatorRpcError(error)}`);
      }
      if (asJson) return JSON.stringify(results, null, 2);
      const lines: string[] = [`Cost by who spent it, last ${window === '7d' ? '7 days' : '24 hours'}`];
      for (const result of results) {
        const isOptional = (COST_ATTRIBUTION_OPTIONAL_DIMENSIONS as readonly string[]).includes(result.dimension);
        const section = formatCostAttributionSection(result, isOptional);
        if (section) lines.push('', ...section);
      }
        return lines.join('\n');
      },
    }),
  ],
});

export function registerCostRuntimeCommands(registry: CommandRegistry): void {
  registry.register(USAGE_COMMAND);
}
