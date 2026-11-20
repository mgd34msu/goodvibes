/**
 * `/auth`, described once (command-actions/): how you are signed in to model
 * providers, how to fix a sign-in, and a summary file of it for a support
 * thread. Both terminal apps register this one description; the wording of
 * each report is the app's policy, read by the actions' `run`. Signing in to
 * or out of a daemon or listener is an action of `/accounts`, and the local
 * users of this machine are `/local-auth`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { commandRefusal } from './command-confirmation.js';
import { buildAuthInspectionSnapshot, inspectProviderAuth } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';

type AuthQuery = Parameters<typeof inspectProviderAuth>[1];

export interface AuthCommandContext extends CommandActionContext {
  readonly platform: {
    readonly serviceRegistry?: AuthQuery['serviceRegistry'] | null | undefined;
    readonly subscriptionManager?: AuthQuery['subscriptionManager'] | null | undefined;
    readonly secretsManager?: AuthQuery['secretsManager'] | null | undefined;
  };
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
}

function queryOf(ctx: AuthCommandContext): AuthQuery {
  const { serviceRegistry, subscriptionManager, secretsManager } = ctx.platform;
  if (!serviceRegistry || !subscriptionManager || !secretsManager) throw commandRefusal('Provider sign-ins are not available in this session.', 'Restart the app; they load with it.');
  return { serviceRegistry, subscriptionManager, secretsManager };
}

function resolvePath(ctx: AuthCommandContext, path: string): string {
  const paths = ctx.workspace.shellPaths;
  if (!paths) throw commandRefusal('This session has no working directory, so no file path can be read.');
  return paths.resolveWorkspacePath(path);
}

const AUTH_PROVIDERS = defineList<AuthCommandContext>({
  name: 'auth.providers',
  async read(ctx) {
    const snapshot = await buildAuthInspectionSnapshot(queryOf(ctx));
    const builtin = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
    const named = new Set(snapshot.providers.map((entry) => entry.provider));
    return [
      ...snapshot.providers.map((entry): ListRow => ({ value: entry.provider, label: entry.provider, state: entry.freshness })),
      ...builtin.filter((provider) => !named.has(provider)).map((provider): ListRow => ({ value: provider, label: provider, state: 'not signed in' })),
    ];
  },
  operator: { terminalOnly: 'Provider sign-ins are read from the terminal app\'s own stores.' },
});

const PROVIDER: InputDescription = {
  id: 'provider', label: 'Provider', help: 'Providers you can sign in to with a subscription', kind: 'choice',
  choices: { list: AUTH_PROVIDERS, allowOther: { reason: 'a provider a services file adds' } }, required: true, typed: { position: 1 },
};
const FILE: InputDescription = {
  id: 'path', label: 'File', help: 'A path in this project, or an absolute path', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 },
};

export interface AuthReviewBundleBase {
  readonly version: 1;
  readonly exportedAt: number;
  readonly secretKeys: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly pendingSubscriptions: readonly string[];
}

/** How each app words its reports and what its summary file adds. */
export interface AuthCommandPolicy<Bundle extends AuthReviewBundleBase> {
  readonly review: (snapshot: Awaited<ReturnType<typeof buildAuthInspectionSnapshot>>, providers: string[]) => string[];
  readonly show: (provider: string, inspection: Awaited<ReturnType<typeof inspectProviderAuth>>) => string[];
  readonly repair: (provider: string, inspection: Awaited<ReturnType<typeof inspectProviderAuth>>) => string[];
  readonly build: (base: AuthReviewBundleBase) => Bundle;
  readonly inspect: (value: unknown) => string;
}

function describeAuth<Ctx extends AuthCommandContext, Bundle extends AuthReviewBundleBase>(policy: AuthCommandPolicy<Bundle>): CommandDescription<Ctx> {
  async function inspection(ctx: Ctx, provider: string) {
    try {
      return await inspectProviderAuth(provider, queryOf(ctx));
    } catch (error) {
      throw commandRefusal(`Could not read the sign-in for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    name: 'auth',
    title: 'Provider sign-ins',
    summary: 'See how you are signed in to model providers and how to fix a sign-in',
    group: 'Setup',
    report: 'see-sign-ins',
    actions: [
      {
        id: 'see-sign-ins', label: 'See your provider sign-ins', word: 'review', inputs: [],
        sentence: 'Shows each provider you can sign in to, whether you are signed in, and when it ends.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'accounts.snapshot', fields: {} }, example: {},
        async run(_values, ctx) {
          let snapshot;
          try {
            snapshot = await buildAuthInspectionSnapshot(queryOf(ctx));
          } catch (error) {
            throw commandRefusal(`Could not read your provider sign-ins: ${error instanceof Error ? error.message : String(error)}`);
          }
          return policy.review(snapshot, listBuiltinSubscriptionProviders().map((entry) => entry.provider)).join('\n');
        },
      },
      {
        id: 'see-sign-in', label: 'See one provider\'s sign-in', word: 'show', inputs: [PROVIDER],
        sentence: 'Shows how {provider} is signed in: where its settings come from, the token\'s type and end, and anything wrong; no token is shown.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'Provider sign-ins are read from the terminal app\'s own stores.' }, example: { provider: 'openai' },
        async run(values, ctx) {
          return policy.show(values.provider!, await inspection(ctx, values.provider!)).join('\n');
        },
      },
      {
        id: 'fix-sign-in', label: 'See how to fix a provider\'s sign-in', word: 'repair', inputs: [PROVIDER],
        sentence: 'Shows what is wrong with {provider}\'s sign-in and the steps that fix it.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'The steps name terminal commands.' }, example: { provider: 'openai' },
        async run(values, ctx) {
          return policy.repair(values.provider!, await inspection(ctx, values.provider!)).join('\n');
        },
      },
      {
        id: 'save-summary', label: 'Save a sign-in summary to a file', word: 'export',
        inputs: [FILE, {
          id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice',
          choices: [
            { value: 'no', label: 'Keep it and stop', help: 'Nothing is written when the file is there.' },
            { value: 'yes', label: 'Write over it', help: 'What the file holds now is lost.', risk: 'cannot-be-undone' },
          ],
          required: { default: 'no', defaultMeans: 'keep it and stop' }, typed: { flag: '--replace', switchOn: 'yes' },
        }],
        sentence: 'A summary of your sign-ins (names of stored secrets and providers, no secret or token) will be written to {path}, readable by you only, until you change it.',
        done: 'Saved the sign-in summary to {path}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: 'The file is written on the terminal app\'s machine.' }, example: { path: 'auth-summary.json' },
        async run(values, ctx) {
          const target = resolvePath(ctx, values.path!);
          if (existsSync(target) && values.replace !== 'yes') throw commandRefusal(`${target} already exists; nothing was written.`, `Write over it: /auth export ${values.path} --replace`);
          const query = queryOf(ctx);
          const bundle = policy.build({
            version: 1,
            exportedAt: Date.now(),
            secretKeys: await query.secretsManager.list(),
            activeSubscriptions: query.subscriptionManager.list().map((entry) => entry.provider),
            pendingSubscriptions: query.subscriptionManager.listPending().map((entry) => entry.provider),
          });
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
          // The mode above applies only when the file is created; one written over must still end owner-only.
          chmodSync(target, 0o600);
          return target === values.path ? undefined : `Written to ${target}.`;
        },
      },
      {
        id: 'read-summary', label: 'Read a saved sign-in summary', word: 'inspect', inputs: [FILE],
        sentence: 'Shows what the sign-in summary in {path} holds.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'The file is read on the terminal app\'s machine.' }, example: { path: 'auth-summary.json' },
        async run(values, ctx) {
          const target = resolvePath(ctx, values.path!);
          let value: unknown;
          try {
            value = JSON.parse(readFileSync(target, 'utf-8'));
          } catch (error) {
            throw commandRefusal(`Could not read ${target}: ${error instanceof Error ? error.message : String(error)}`);
          }
          return policy.inspect(value);
        },
      },
    ],
  };
}

/** `/auth` for one app: the one description, with the app's report wording. */
export function createAuthCommand<Ctx extends AuthCommandContext, Bundle extends AuthReviewBundleBase>(policy: AuthCommandPolicy<Bundle>): DescribedCommand<Ctx> {
  return defineCommand(describeAuth<Ctx, Bundle>(policy));
}
