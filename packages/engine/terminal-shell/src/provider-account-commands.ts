import type { TerminalCommandRegistry } from './command-registry.js';
interface AccountContext {
  print(message: string): void;
}
interface AccountRecord {
  readonly providerId: string;
}
interface AccountSnapshot<Record extends AccountRecord> {
  readonly providers: readonly Record[];
}
/** Snapshot acquisition and repair execution remain tied to the calling product's authority. */
export function createProviderAccountCommands<
  Context extends AccountContext,
  Record extends AccountRecord,
  Snapshot extends AccountSnapshot<Record>,
>(policy: {
  readonly hidden?: boolean | undefined;
  readonly usage: string;
  readonly load: (context: Context) => Promise<Snapshot>;
  readonly open: (context: Context) => void;
  readonly unknown: (providerId: string) => string;
  readonly routes: (record: Record) => string[];
  readonly repair: (record: Record) => string[];
  readonly show: (record: Record) => string[];
  readonly review: (snapshot: Snapshot) => string[];
  readonly afterRepair?: ((context: Context, record: Record) => void) | undefined;
  readonly afterShow?: ((context: Context, record: Record) => void) | undefined;
}) {
  function registerProviderAccountsRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'accounts',
      aliases: ['account'],
      description: 'Review provider auth routes, subscription windows, and billing-path safety',
      hidden: policy.hidden,
      usage: policy.usage,
      async handler(args, ctx) {
        const sub = (args[0] ?? 'review').toLowerCase();
        if (sub === 'panel' || sub === 'open') {
          policy.open(ctx);
          return;
        }
        const snapshot = await policy.load(ctx);
        if (sub === 'routes' || sub === 'repair' || sub === 'show') {
          const providerId = args[1];
          const record = providerId ? snapshot.providers.find((entry) => entry.providerId === providerId) : undefined;
          if (!record) {
            ctx.print(providerId ? policy.unknown(providerId) : `Usage: /accounts ${sub} <provider>`);
            return;
          }
          ctx.print(policy[sub](record).join('\n'));
          if (sub === 'repair') policy.afterRepair?.(ctx, record);
          else if (sub === 'show') policy.afterShow?.(ctx, record);
          return;
        }
        ctx.print(policy.review(snapshot).join('\n'));
      },
    });
  }
  return { registerProviderAccountsRuntimeCommands };
}
