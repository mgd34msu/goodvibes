import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireYesFlag } from './command-confirmation.js';
import { buildAuthInspectionSnapshot, inspectProviderAuth } from '../../sdk/src/platform/runtime/auth/inspection.js';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
interface AuthReviewContext {
  print(message: string): void;
}
export function createAuthReviewHandler<Context extends AuthReviewContext>(policy: {
  readonly review: (snapshot: Awaited<ReturnType<typeof buildAuthInspectionSnapshot>>, providers: string[]) => string[];
  readonly show: (provider: string, inspection: Awaited<ReturnType<typeof inspectProviderAuth>>) => string[];
  readonly repair: (provider: string, inspection: Awaited<ReturnType<typeof inspectProviderAuth>>) => string[];
  readonly reportFailure: boolean;
}) {
  return async (args: readonly string[], ctx: Context, query: Parameters<typeof inspectProviderAuth>[1]): Promise<boolean> => {
    const sub = args[0] ?? 'review';
    if (sub !== 'review' && sub !== 'show' && sub !== 'repair') return false;
    const provider = args[1];
    if (sub !== 'review' && !provider) {
      ctx.print(`Usage: /auth ${sub} <provider>`);
      return true;
    }
    try {
      if (sub === 'review') {
        const snapshot = await buildAuthInspectionSnapshot(query);
        const builtin = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
        ctx.print(policy.review(snapshot, builtin).join('\n'));
      } else if (provider) {
        const inspection = await inspectProviderAuth(provider, query);
        ctx.print(policy[sub](provider, inspection).join('\n'));
      }
    } catch (error) {
      if (!policy.reportFailure) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      ctx.print(
        sub === 'review'
          ? 'Could not build auth review: ' + detail
          : 'Could not inspect auth for ' + (sub === 'repair' ? 'repair of ' : '') + provider + ': ' + detail,
      );
    }
    return true;
  };
}

export interface AuthReviewBundleBase {
  readonly version: 1;
  readonly exportedAt: number;
  readonly secretKeys: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly pendingSubscriptions: readonly string[];
}
export function createAuthBundleHandler<Context extends AuthReviewContext, Bundle extends AuthReviewBundleBase>(policy: {
  readonly confirmExport: boolean;
  readonly reportReadFailure: boolean;
  readonly build: (base: AuthReviewBundleBase) => Bundle;
  readonly inspect: (value: unknown) => string;
}) {
  return async (
    args: readonly string[],
    context: Context,
    services: {
      readonly secretsManager: Parameters<typeof inspectProviderAuth>[1]['secretsManager'];
      readonly subscriptions: Parameters<typeof inspectProviderAuth>[1]['subscriptionManager'];
      readonly resolvePath: (path: string) => string;
      readonly confirmed: boolean;
    },
  ): Promise<boolean> => {
    if (args[0] !== 'bundle') return false;
    const mode = args[1],
      path = args[2];
    if (mode !== 'export' && mode !== 'inspect') return false;
    if (!path) {
      context.print(`Usage: /auth bundle ${mode} <path>${mode === 'export' && policy.confirmExport ? ' --yes' : ''}`);
      return true;
    }
    const target = services.resolvePath(path);
    if (mode === 'export') {
      if (policy.confirmExport && !services.confirmed) {
        requireYesFlag(context, `export auth review bundle to ${path}`, '/auth bundle export <path> --yes');
        return true;
      }
      const secretKeys = await services.secretsManager.list();
      const bundle = policy.build({
        version: 1,
        exportedAt: Date.now(),
        secretKeys,
        activeSubscriptions: services.subscriptions.list().map((entry) => entry.provider),
        pendingSubscriptions: services.subscriptions.listPending().map((entry) => entry.provider),
      });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
      context.print(`Auth review bundle exported to ${target}`);
    } else {
      try {
        const value: unknown = JSON.parse(readFileSync(target, 'utf-8'));
        context.print(policy.inspect(value));
      } catch (error) {
        if (!policy.reportReadFailure) throw error;
        context.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  };
}
