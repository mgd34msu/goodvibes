import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type LiteralSecretsManager,
  type SecretScope,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConcealedInputRequest } from './concealed-input.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';

export function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}
export function isMalformedGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isGoodVibesSecretRefInput(normalized);
}
interface SecretsCommandContext {
  readonly print: (message: string) => void;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
}
/** Values stay redacted; each product supplies its credential ownership and confirmation policy. */
export function createSecretsCommand<Context extends SecretsCommandContext>(
  manager: (context: Context) => Pick<LiteralSecretsManager, 'get' | 'set' | 'delete' | 'listDetailed'>,
  policy: {
    readonly hidden: boolean;
    readonly description: string;
    readonly confirmMutations: boolean;
    readonly concealedEntry: boolean;
    readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
    readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
    readonly relocationNote: (key: string, requested: SecretScope) => string;
    readonly resolved: (reference: string, status: string) => string;
    readonly failed: (reference: string, error: string) => string;
    readonly deleted: (key: string) => string;
  },
): TerminalSlashCommand<Context> {
  const suffix = policy.confirmMutations ? ' --yes' : '';
  const storageFlags = '[--user|--project] [--secure|--plaintext]';
  const mutationUsage = (operation: string) =>
    `/secrets ${operation} <KEY> <${operation === 'link' ? 'secret-ref' : 'value'}> ${storageFlags}${suffix}`;
  const deletionUsage = `/secrets delete <KEY> ${storageFlags}${suffix}`;
  const usage = `set <KEY> <value> ${storageFlags}${suffix} | link <KEY> <secret-ref> ${storageFlags}${suffix} | get <KEY> | test <secret-ref> | providers | list | delete <KEY> ${storageFlags}${suffix}`;
  const referenceExamples = [
    'OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
    'SLACK_BOT_TOKEN goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password&sessionEnv=BW_SESSION',
    'SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test',
    'STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value&accessTokenEnv=BWS_ACCESS_TOKEN',
    'OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key',
  ];
  return {
    name: 'secrets',
    description: policy.description,
    hidden: policy.hidden,
    usage,
    argsHint: '<set|link|get|test|providers|list|delete> [KEY]',
    async handler(args, context) {
      const store = manager(context);
      const parsed = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
      const [subcommand, ...rest] = parsed.rest;
      const invalidReference = () => context.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
      if (!subcommand || subcommand === 'list') {
        const records = (await store.listDetailed()).filter((record) => record.source !== 'env');
        context.print(
          !records.length
            ? `[secrets] No secrets stored. Use: /secrets set <KEY> <value>${suffix}`
            : [
                '[secrets] Stored keys:',
                ...records.map(
                  (record) =>
                    `  ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`,
                ),
              ].join('\n'),
        );
        return;
      }
      if (subcommand === 'providers') {
        context.print(
          [
            '[secrets] Built-in secret providers:',
            ...BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `  ${source}`),
            '',
            'Examples:',
            ...referenceExamples.map((example) => `  /secrets link ${example}${suffix}`),
          ].join('\n'),
        );
        return;
      }
      if (subcommand === 'test') {
        const reference = rest.join(' ').trim();
        if (!reference) {
          context.print('[secrets] Usage: /secrets test <secret-ref>');
          return;
        }
        if (!isGoodVibesSecretRefInput(reference)) {
          invalidReference();
          return;
        }
        try {
          const result = await resolveSecretRef(reference, { resolveLocalSecret: (key) => store.get(key) });
          context.print(policy.resolved(describeSecretRef(reference), result.value ? 'resolved <redacted>' : 'missing'));
        } catch (error) {
          context.print(policy.failed(describeSecretRef(reference), summarizeError(error)));
        }
        return;
      }
      if (subcommand === 'set' || subcommand === 'link') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const [key, ...parts] = rest.filter((value) => !value.startsWith('--'));
        if (!key) {
          context.print(`[secrets] Usage: ${mutationUsage(subcommand)}`);
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(
            context,
            `${subcommand === 'link' ? 'link secret reference for' : 'store secret value for'} ${key}`,
            mutationUsage(subcommand),
          );
          return;
        }
        const requestedScope = flags.has('--user') ? 'user' : 'project';
        const scope = policy.writeScope(key, requestedScope);
        const medium = flags.has('--plaintext') ? 'plaintext' : 'secure';
        if (policy.concealedEntry && subcommand === 'set' && parts.length === 0) {
          if (!context.beginConcealedInput) {
            context.print(`[secrets] Usage: ${mutationUsage(subcommand)}`);
            return;
          }
          context.print(`[secrets] Enter value for ${key} (input is masked; press Enter to store, Esc to cancel).`);
          context.beginConcealedInput({
            label: key,
            onSubmit(value) {
              if (!value.length) {
                context.print(`[secrets] ${key} not set (empty value).`);
                return;
              }
              void store.set(key, value, { scope, medium }).then(
                () => context.print(`[secrets] Stored: ${key} (${scope}, ${medium})${policy.relocationNote(key, requestedScope)}`),
                (error) => context.print(`[secrets] Could not store ${key}: ${summarizeError(error)}`),
              );
            },
            onCancel: () => context.print(`[secrets] ${key} cancelled.`),
          });
          return;
        }
        const value = parts.join(' ');
        if (
          (subcommand === 'link' && !isGoodVibesSecretRefInput(value)) ||
          (subcommand === 'set' && isMalformedGoodVibesSecretRefInput(value))
        ) {
          invalidReference();
          return;
        }
        await store.set(key, value, { scope, medium });
        context.print(
          (subcommand === 'link'
            ? `[secrets] Linked: ${key} -> ${describeSecretRef(value)} (${scope}, ${medium})`
            : `[secrets] Stored: ${key} (${scope}, ${medium})`) + policy.relocationNote(key, requestedScope),
        );
        return;
      }
      if (subcommand === 'get') {
        const key = rest[0];
        if (!key) {
          context.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await store.get(key);
        context.print(value === null ? `[secrets] Not found: ${key}` : `[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        return;
      }
      if (subcommand === 'delete') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const key = rest.find((value) => !value.startsWith('--'));
        if (!key) {
          context.print(`[secrets] Usage: ${deletionUsage}`);
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(context, `delete secret ${key}`, deletionUsage);
          return;
        }
        await store.delete(key, {
          scope: policy.deleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
          medium: flags.has('--plaintext') ? 'plaintext' : flags.has('--secure') ? 'secure' : undefined,
        });
        context.print(policy.deleted(key));
        return;
      }
      context.print(`[secrets] Usage: /secrets ${usage}`);
    },
  };
}
