import {
  isGoodVibesSecretReferenceValue as isGoodVibesSecretRefInput,
  isMalformedGoodVibesSecretReferenceValue as isMalformedGoodVibesSecretRefInput,
} from '@goodvibes-jev/engine/platform/platform/config';
export { isGoodVibesSecretRefInput, isMalformedGoodVibesSecretRefInput };
import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  resolveSecretRef,
  type SecretsManager,
  type SecretScope,
} from '@goodvibes-jev/engine/platform/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { ConcealedInputRequest } from './concealed-input.js';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal, stripYesFlag, type ConfirmableCommand } from './command-confirmation.js';
import type { CommandSubcommandHints } from './command-args-hint.js';

interface SecretsCommandContext {
  readonly print: (message: string) => void;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
}
const SET_OPTIONS: ReadonlySet<string> = new Set(['--user', '--project', '--secure', '--plaintext', '--yes']);
/** Values stay redacted; each product supplies its credential ownership and confirmation policy. */
export function createSecretsCommand<Context extends SecretsCommandContext>(
  manager: (context: Context) => Pick<SecretsManager, 'get' | 'set' | 'delete' | 'listDetailed'> & Partial<Pick<SecretsManager, 'confirmProjectSecret'>>,
  policy: {
    readonly hidden: boolean;
    readonly description: string;
    readonly concealedEntry: boolean;
    readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
    readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
    readonly relocationNote: (key: string, requested: SecretScope) => string;
    readonly resolved: (reference: string, status: string) => string;
    readonly failed: (reference: string, error: string) => string;
    readonly deleted: (key: string) => string;
  },
): TerminalSlashCommand<Context> & CommandSubcommandHints & Pick<ConfirmableCommand<Context>, 'confirm'> {
  const storageFlags = '[--user|--project] [--secure|--plaintext]';
  const mutationUsage = (operation: string) =>
    `/secrets ${operation} <KEY> <${operation === 'link' ? 'secret-ref' : 'value'}> ${storageFlags}`;
  const deletionUsage = `/secrets delete <KEY> ${storageFlags}`;
  const trustUsage = `/secrets trust <KEY>`;
  const usage = `set <KEY> <value> ${storageFlags} | link <KEY> <secret-ref> ${storageFlags} | get <KEY> | test <secret-ref> | providers | list | trust <KEY> | delete <KEY> ${storageFlags}`;
  const referenceExamples = [
    'OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
    'SLACK_BOT_TOKEN goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password',
    'SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test',
    'STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value',
    'OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key',
  ];
  return {
    name: 'secrets',
    effect: 'mixed',
    description: policy.description,
    hidden: policy.hidden,
    usage,
    argsHint: '<set|link|get|test|providers|list|trust|delete> [KEY]',
    secretArgs: { subcommands: { set: { from: 2 } } },
    subcommands: {
      set: `<KEY> <value> ${storageFlags}`,
      link: `<KEY> <secret-ref> ${storageFlags}`,
      get: '<KEY>',
      test: '<secret-ref>',
      providers: '',
      list: '',
      trust: `<KEY>`,
      delete: `<KEY> ${storageFlags}`,
    },
    // The registry asks once for a line that cannot be undone.
    confirm: (args) => {
      const key = args[0] === 'delete' || args[0] === 'trust' ? args.slice(1).find((value) => !value.startsWith('--')) : undefined;
      if (!key) return undefined;
      return args[0] === 'trust'
        ? { title: `Use ${key} from this project's secret store?`, detail: `A project's secret store is part of the checkout, so whoever wrote the repository may have put ${key} there. Once confirmed, ${key} from this project's store is used whenever you have not set it yourself.`, confirmLabel: 'Use it' }
        : { title: `Delete secret ${key}?`, detail: `The stored value of ${key} is removed and cannot be recovered; anything that reads it stops working until it is set again.`, confirmLabel: 'Delete' };
    },
    async handler(args, context) {
      const store = manager(context);
      const parsed = { rest: stripYesFlag(args).rest };
      const [subcommand, ...rest] = parsed.rest;
      const invalidReference = (): never => { throw commandRefusal('[secrets] Invalid secret reference.', 'Use /secrets providers for examples.'); };
      if (!subcommand || subcommand === 'list') {
        const records = (await store.listDetailed()).filter((record) => record.source !== 'env');
        context.print(
          !records.length
            ? `[secrets] No secrets stored. Use: /secrets set <KEY> <value>`
            : [
                '[secrets] Stored keys:',
                ...records.map(
                  (record) =>
                    `  ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''}${record.unconfirmed ? `, not used until confirmed: /secrets trust ${record.key}` : ''})`,
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
            ...referenceExamples.map((example) => `  /secrets link ${example}`),
          ].join('\n'),
        );
        return;
      }
      if (subcommand === 'test') {
        const reference = rest.join(' ').trim();
        if (!reference) {
          throw commandRefusal('[secrets] Usage: /secrets test <secret-ref>');
        }
        if (!isGoodVibesSecretRefInput(reference)) {
          invalidReference();
        }
        try {
          const result = await resolveSecretRef(reference, { resolveLocalSecret: (key) => store.get(key) });
          context.print(policy.resolved(describeSecretRef(reference), result.value ? 'resolved <redacted>' : 'missing'));
        } catch (error) {
          throw commandRefusal(policy.failed(describeSecretRef(reference), summarizeError(error)));
        }
        return;
      }
      if (subcommand === 'set' || subcommand === 'link') {
        // Options come first; a bare `--` ends them so a value may itself start
        // with `--`. The token is never echoed: it may be the secret.
        const flags = new Set<string>();
        const positional: string[] = [];
        let optionsEnded = false;
        for (const token of rest) {
          if (!optionsEnded && token === '--') optionsEnded = true;
          else if (!optionsEnded && token.startsWith('--')) flags.add(token);
          else positional.push(token);
        }
        const unknownFlags = [...flags].filter((flag) => !SET_OPTIONS.has(flag));
        if (unknownFlags.length) {
          throw commandRefusal(
            `[secrets] An argument starting with -- is not a known option (${[...SET_OPTIONS].join(', ')}). To store a value that starts with --, put it after a bare --.\nUsage: ${mutationUsage(subcommand)}`,
          );
        }
        const [key, ...parts] = positional;
        if (!key) {
          throw commandRefusal(`[secrets] Usage: ${mutationUsage(subcommand)}`);
        }
        const requestedScope = flags.has('--user') ? 'user' : 'project';
        const scope = policy.writeScope(key, requestedScope);
        const medium = flags.has('--plaintext') ? 'plaintext' : 'secure';
        if (policy.concealedEntry && subcommand === 'set' && parts.length === 0) {
          if (!context.beginConcealedInput) {
            throw commandRefusal(`[secrets] Usage: ${mutationUsage(subcommand)}`);
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
        // A value is one word, stored exactly as typed (a backslash outside
        // quotes is an ordinary character). Several words would have to be
        // re-joined with guessed spacing, so they are refused instead.
        if (parts.length > 1) {
          throw commandRefusal(`[secrets] Nothing was stored: the value for ${key} is more than one word. Put it in quotes ("…") to keep its spaces exactly; inside the quotes write \\\\ for a backslash and \\" for a quote, or run /secrets set ${key} with no value to type it masked where that is offered.\nUsage: ${mutationUsage(subcommand)}`);
        }
        const value = parts[0] ?? '';
        if (!value.length) {
          throw commandRefusal(`[secrets] Nothing was stored: no value given for ${key}.\nUsage: ${mutationUsage(subcommand)}`);
        }
        if (
          (subcommand === 'link' && !isGoodVibesSecretRefInput(value)) ||
          (subcommand === 'set' && isMalformedGoodVibesSecretRefInput(value))
        ) {
          invalidReference();
        }
        await store.set(key, value, { scope, medium });
        context.print(
          (subcommand === 'link'
            ? `[secrets] Linked: ${key} -> ${describeSecretRef(value)} (${scope}, ${medium})`
            : `[secrets] Stored: ${key} (${scope}, ${medium})`) + policy.relocationNote(key, requestedScope),
        );
        return;
      }
      if (subcommand === 'trust') {
        const key = rest.find((value) => !value.startsWith('--'));
        if (!key) {
          throw commandRefusal(`[secrets] Usage: ${trustUsage}`);
        }
        if (!store.confirmProjectSecret) {
          throw commandRefusal(`[secrets] Nothing was confirmed: this app does not read this project's secret store. Store ${key} with /secrets set ${key} <value> --user.`);
        }
        const confirmed = store.confirmProjectSecret(key);
        if (!confirmed.length) throw commandRefusal(`[secrets] Nothing was confirmed: ${key} is not in this project's secret store.`, '/secrets list shows what is stored.');
        context.print(`[secrets] ${key} from this project's secret store is used from now on (${confirmed.join(', ')}).`);
        return;
      }
      if (subcommand === 'get') {
        const key = rest[0];
        if (!key) {
          context.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await store.get(key);
        if (value === null) throw commandRefusal(`[secrets] Not found: ${key}`, 'Use /secrets list to see all keys.');
        context.print(`[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        return;
      }
      if (subcommand === 'delete') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const unknownFlags = [...flags].filter((flag) => !SET_OPTIONS.has(flag));
        if (unknownFlags.length) {
          // Deleting at a default scope the person did not ask for is not recoverable.
          throw commandRefusal(
            `[secrets] An argument starting with -- is not a known option (${[...SET_OPTIONS].join(', ')}). Nothing was deleted.\nUsage: ${deletionUsage}`,
          );
        }
        const key = rest.find((value) => !value.startsWith('--'));
        if (!key) {
          throw commandRefusal(`[secrets] Usage: ${deletionUsage}`);
        }
        await store.delete(key, {
          scope: policy.deleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
          medium: flags.has('--plaintext') ? 'plaintext' : flags.has('--secure') ? 'secure' : undefined,
        });
        context.print(policy.deleted(key));
        return;
      }
      throw commandRefusal(`[secrets] Usage: /secrets ${usage}`);
    },
  };
}
