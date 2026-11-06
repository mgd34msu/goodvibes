import type { SelectionItem, SelectionResult } from './selection-modal.js';
interface RecommendedAction {
  readonly description: string;
  readonly command?: { readonly name: string; readonly args: readonly string[] } | undefined;
}
interface RecommendedActionContext {
  print(message: string): void;
  readonly openSelection?:
    | ((
        title: string,
        items: SelectionItem[],
        options: { readonly allowSearch: boolean; readonly primaryVerbLabel: string },
        onResult: (result: SelectionResult | null) => void,
      ) => void)
    | undefined;
  readonly executeCommand?: ((name: string, args: string[]) => Promise<unknown>) | undefined;
}
export function presentRecommendedActions(ctx: RecommendedActionContext, providerId: string, actions: readonly RecommendedAction[]): void {
  if (actions.length === 0) {
    ctx.print('No active repair actions suggested.');
    return;
  }
  if (ctx.openSelection) {
    const items: SelectionItem[] = actions.map((action, index) => {
      if (action.command) {
        const argsPart = action.command.args.length > 0 ? ` ${action.command.args.join(' ')}` : '';
        return {
          id: String(index),
          label: action.description,
          detail: `runs /${action.command.name}${argsPart}`,
          primaryAction: 'select',
        };
      }
      return {
        id: String(index),
        label: action.description,
        detail: 'manual step (nothing to run)',
        primaryAction: 'select',
      };
    });
    ctx.openSelection(`Repair ${providerId}`, items, { allowSearch: false, primaryVerbLabel: 'Run' }, (result) => {
      if (!result) return;
      const action = actions[Number(result.item.id)];
      if (!action) return;
      if (action.command) {
        const args = [...action.command.args];
        void (
          ctx.executeCommand?.(action.command.name, args) ??
          Promise.resolve(ctx.print(`Cannot run /${action.command.name}: command execution is unavailable here.`))
        );
        return;
      }
      ctx.print(action.description);
    });
    return;
  }
  // No selection surface (headless/command-only): list actions honestly.
  ctx.print(
    [
      'Recommended actions:',
      ...actions.map((action) =>
        action.command
          ? `  • ${action.description}: /${action.command.name}${action.command.args.length > 0 ? ` ${action.command.args.join(' ')}` : ''}`
          : `  • ${action.description} (manual step)`,
      ),
    ].join('\n'),
  );
}
