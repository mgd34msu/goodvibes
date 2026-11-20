/**
 * `/tools`, described once (command-actions/): the tools the model can call
 * here, each one's contract, and a check that a tool (or every tool) keeps
 * the contract it declares.
 */
import type { CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { ToolContractVerifier } from '@/runtime/index.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type InputDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { openCommandView } from './runtime-services.ts';

const TOOLS = defineList<CommandContext>({
  name: 'tools',
  async read(ctx) {
    return ctx.extensions.toolRegistry.list().map((tool): ListRow => ({ value: tool.definition.name, label: tool.definition.name, detail: typeof tool.definition.description === 'string' ? tool.definition.description.slice(0, 80) : '' }));
  },
  operator: { terminalOnly: 'The tools are this terminal\'s own.' },
});
const TOOL: InputDescription = listInput({ id: 'tool', label: 'Tool', help: 'The tools the model can call here', list: TOOLS });
const LOCAL_ONLY = { terminalOnly: 'The tools are this terminal\'s own.' } as const;

async function verified(ctx: CommandContext, name: string) {
  const result = await ctx.extensions.toolRegistry.verifyContract(name);
  if (!result) throw commandRefusal(`No tool ${name} is registered.`, '/tools list shows them.');
  return result;
}

export const toolsCommand = defineCommand<CommandContext>({
  name: 'tools',
  title: 'Tools',
  summary: 'The tools the model can call here: see them, read one\'s contract, check that tools keep their contracts',
  group: 'Tools',
  report: 'list',
  actions: [
    readAction<CommandContext>({
      id: 'list', label: 'See the tools available', word: 'list',
      sentence: 'Lists the tools the model can call in this session; picking one shows what it does.', operator: LOCAL_ONLY,
      async run(_values, ctx) {
        const tools = ctx.extensions.toolRegistry.list();
        if (ctx.openSelection && ctx.invokedByModel !== true) {
          const items: SelectionItem[] = tools.map((tool) => ({
            id: tool.definition.name,
            label: tool.definition.name,
            detail: typeof tool.definition.description === 'string' ? tool.definition.description.slice(0, 50) : '',
          }));
          ctx.openSelection('Available tools', items, { allowSearch: true }, (result) => {
            if (!result) return;
            const tool = tools.find((entry) => entry.definition.name === result.item.id);
            if (tool) ctx.print(`Tool: ${tool.definition.name}\n  ${tool.definition.description ?? ''}`);
          });
          return;
        }
        return ['Available tools:', ...tools.map((tool) => `  • ${tool.definition.name}`)].join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'contract', label: 'See one tool\'s contract', word: 'contract', inputs: [TOOL],
      sentence: 'Shows tool {tool}: its description, its parameters, and whether it keeps its contract.', example: { tool: 'read' }, operator: LOCAL_ONLY,
      async run(values, ctx) {
        const lines = [ToolContractVerifier.formatResult(await verified(ctx, values.tool!))];
        const tool = ctx.extensions.toolRegistry.list().find((entry) => entry.definition.name === values.tool);
        if (tool) {
          lines.push('', 'Tool definition:', `  Name:        ${tool.definition.name}`, `  Description: ${tool.definition.description}`,
            `  Parameters:  ${JSON.stringify(tool.definition.parameters, null, 2).replace(/\n/g, '\n               ')}`);
        }
        return lines.join('\n');
      },
    }),
    readAction<CommandContext>({
      id: 'verify', label: 'Check one tool keeps its contract', word: 'verify', inputs: [TOOL],
      sentence: 'Checks that tool {tool} keeps the contract it declares.', example: { tool: 'read' }, operator: LOCAL_ONLY,
      async run(values, ctx) { return ToolContractVerifier.formatResult(await verified(ctx, values.tool!)); },
    }),
    readAction<CommandContext>({
      id: 'verify-all', label: 'Check every tool keeps its contract', word: 'verify-all',
      sentence: 'Checks that every registered tool keeps the contract it declares.', operator: LOCAL_ONLY,
      async run(_values, ctx) { return ToolContractVerifier.formatAllResults(await ctx.extensions.toolRegistry.verifyAllContracts()); },
    }),
    doAction<CommandContext>({
      id: 'activity', label: 'Open tool activity', word: 'activity', touches: 'reads',
      sentence: 'Opens Your agents, where each agent\'s tool calls show live; in the conversation each call is one line.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) { openCommandView(ctx, 'agents'); },
    }),
  ],
});
