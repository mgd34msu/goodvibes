import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isValidSecretReference,
  resolveSecretRef,
  type SecretsManager,
  type SecretScope,
} from '@goodvibes/engine/platform/platform/config';
import { cliCommandDone, cliCommandRefusal, formatJsonOrText, yesNo, type CliCommandOutput } from './cli-output.js';
import { askSecretOnStdin } from './cli-hidden-input.js';
const SECRET_WRITE_FLAGS: ReadonlySet<string> = new Set(['--user', '--project', '--secure', '--plaintext', '--stdin']);
const SECRET_DELETE_FLAGS: ReadonlySet<string> = new Set(['--user', '--project', '--secure', '--plaintext']);

/** The value without the one trailing newline a piped `echo` adds. */
async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

/** What the command printed and the exit code its outcome decided. */
export type CliSecretsResult = CliCommandOutput;

const ok = cliCommandDone;

interface CliSecretRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
}
export function createCliSecretsCommand<Runtime extends CliSecretRuntime>(policy: {
  readonly createSecrets: (runtime: Runtime) => Pick<SecretsManager, 'get' | 'set' | 'deleteWithReceipt' | 'inspect' | 'listDetailed'> & Partial<Pick<SecretsManager, 'getSecretProviderHostConfig'>>;
  readonly binary: (runtime: Runtime) => string;
  readonly inline: boolean;
  readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
  readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
  readonly relocation: (key: string, requested: SecretScope) => readonly string[];
  /** Test seam and non-process input for `--stdin`; defaults to the process's standard input. */
  readonly readStdin?: (() => Promise<string>) | undefined;
}) {
  const usage = (runtime: Runtime): string =>
    `Usage: ${policy.binary(runtime)} secrets [list|providers|test <ref>|set <KEY> [<value>]|link <KEY> <ref>|delete <KEY>]`;

  /**
   * The value of `set <KEY>` given without one: asked for at the terminal
   * without echo, or read from standard input when something is piped in.
   * Either way it never reaches the command line, the shell history or the
   * process list.
   */
  async function readValueOffCommandLine(key: string): Promise<string> {
    if (policy.readStdin) return policy.readStdin();
    if (process.stdin.isTTY === true) return askSecretOnStdin(`Value for ${key} (typing is not shown): `, true);
    return readProcessStdin();
  }

  async function runSecrets(runtime: Runtime): Promise<CliSecretsResult> {
    const refused = (kind: string, text: string): CliSecretsResult => cliCommandRefusal(runtime.cli, kind, text);
    const usageError = (text: string): CliSecretsResult => cliCommandRefusal(runtime.cli, 'usage', text);
    const secrets = policy.createSecrets(runtime);
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    if (sub === 'providers') {
      const value = { providers: BUILTIN_SECRET_PROVIDER_SOURCES };
      return ok(formatJsonOrText(runtime.cli)(
        value,
        [
          'GoodVibes secret providers',
          ...BUILTIN_SECRET_PROVIDER_SOURCES.map((provider) => `  ${provider}`),
          '',
          'Secret refs use goodvibes://secrets/<source>/... and never embed secret values.',
        ].join('\n'),
      ));
    }
    if (sub === 'test') {
      const ref = rest.join(' ').trim();
      if (!isValidSecretReference(ref)) {
        return usageError(`Usage: ${policy.binary(runtime)} secrets test goodvibes://secrets/<source>/...`);
      }
      const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key), providers: secrets.getSecretProviderHostConfig?.() });
      const value = { ref: describeSecretRef(ref), resolved: resolved.value !== null && !resolved.value.empty };
      // A ref that does not resolve is a failed test, in text and in JSON alike.
      return { ...ok(formatJsonOrText(runtime.cli)(
        value,
        policy.inline
          ? `[secrets] ${value.ref}: ${value.resolved ? 'resolved <redacted>' : 'missing'}`
          : ['GoodVibes secret test', '  ref ' + value.ref, '  result ' + (value.resolved ? 'resolved <redacted>' : 'missing')].join('\n'),
      )), exitCode: value.resolved ? 0 : 1 };
    }
    if (sub === 'set' || sub === 'link') {
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      const binary = policy.binary(runtime);
      const setUsage = sub === 'set'
        ? `Usage: ${binary} secrets set <KEY> [--user|--project] [--secure|--plaintext]: the value is asked for without being shown, or read from standard input when piped (${binary} secrets set <KEY> <value> also works, and leaves the value in your shell history)`
        : `Usage: ${binary} secrets link <KEY> <ref> [--user|--project] [--secure|--plaintext] (or <KEY> --stdin to read the ref from standard input)`;
      const offCommandLine = sub === 'set' ? 'leave it off to be asked for it' : 'read it with --stdin';
      const unknownFlags = [...flags].filter((flag) => !SECRET_WRITE_FLAGS.has(flag));
      if (unknownFlags.length > 0) {
        return refused('unknown_option', `Not stored: unknown option ${unknownFlags.join(', ')}. A value that starts with -- or contains spaces must be quoted as one argument, or ${offCommandLine}. ${setUsage}`);
      }
      const positionals = rest.filter((arg) => !arg.startsWith('--'));
      const [key, ...valueParts] = positionals;
      if (!key) return usageError(setUsage);
      // The value is exactly one argument: joining several would store a different secret than the one typed.
      if (valueParts.length > 1) {
        return refused('too_many_values', `Not stored: ${valueParts.length} values were given for ${key}. Quote the value as one argument, or ${offCommandLine}. ${setUsage}`);
      }
      const value = flags.has('--stdin')
        ? (valueParts.length === 0 ? await (policy.readStdin ?? readProcessStdin)() : '')
        : valueParts[0] ?? (sub === 'set' ? await readValueOffCommandLine(key) : '');
      if (!value) return usageError(sub === 'set' && valueParts.length === 0 ? `Not stored: no value was given for ${key}. ${setUsage}` : setUsage);
      if (sub === 'link' && !isValidSecretReference(value)) {
        return usageError('Invalid secret reference. Use goodvibes://secrets/<source>/...');
      }
      const requestedScope = flags.has('--user') ? 'user' : 'project';
      const scope = policy.writeScope(key, requestedScope);
      await secrets.set(key, value, {
        scope,
        medium: flags.has('--plaintext') ? 'plaintext' : 'secure',
      });
      return ok(policy.inline
        ? `[secrets] ${sub === 'link' ? 'Linked' : 'Stored'}: ${key}`
        : [
            `Secret ${sub === 'link' ? 'linked' : 'stored'}`,
            '  key ' + key,
            '  scope ' + scope,
            ...policy.relocation(key, requestedScope),
          ].join('\n'));
    }
    if (sub === 'delete') {
      const deleteUsage = `Usage: ${policy.binary(runtime)} secrets delete <KEY> [--user|--project] [--secure|--plaintext]`;
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      // A mistyped scope flag would otherwise widen the delete to every scope and medium.
      const unknownFlags = [...flags].filter((flag) => !SECRET_DELETE_FLAGS.has(flag));
      if (unknownFlags.length > 0) return refused('unknown_option', `Nothing deleted: unknown option ${unknownFlags.join(', ')}. ${deleteUsage}`);
      const positionals = rest.filter((arg) => !arg.startsWith('--'));
      const [key] = positionals;
      if (!key) return usageError(deleteUsage);
      if (positionals.length > 1) return refused('too_many_keys', `Nothing deleted: ${positionals.length} keys were given; delete one key at a time. ${deleteUsage}`);
      const removed = await secrets.deleteWithReceipt(key, {
        scope: policy.deleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
        medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
      });
      if (removed.length === 0) return refused('secret_not_stored', `No stored secret named ${key}${flags.size > 0 ? ` in the ${[...flags].map((flag) => flag.slice(2)).join(' ')} store` : ''}. Nothing was deleted; \`${policy.binary(runtime)} secrets list\` shows the stored keys.`);
      const stores = removed.map((entry) => `${entry.scope}/${entry.medium}`);
      return ok(policy.inline
        ? `[secrets] Deleted: ${key} (removed from ${stores.join(', ')})`
        : ['Secret deleted', '  key ' + key, '  removed from ' + stores.join(', ')].join('\n'));
    }
    // Only `list` lists: an unknown verb used to print the listing with exit 0,
    // which told a caller that guessed `get` or `show` it had succeeded.
    if (sub !== 'list') return usageError(usage(runtime));
    const [records, review] = await Promise.all([secrets.listDetailed(), secrets.inspect()]);
    const stored = records.filter((record) => record.source !== 'env');
    const value = { policy: review.policy, records: stored, warnings: review.warnings };
    return ok(formatJsonOrText(runtime.cli)(
      value,
      [
        'GoodVibes secrets',
        `  policy${policy.inline ? ': ' : ' '}${review.policy}`,
        `  secure available${policy.inline ? ': ' : ' '}${yesNo(review.secureAvailable)}`,
        `  stored keys${policy.inline ? ': ' : ' '}${stored.length}`,
        ...stored.map(
          (record) =>
            `    ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`,
        ),
        ...review.warnings.map((warning) => `  warning${policy.inline ? ': ' : ' '}${warning}`),
      ].join('\n'),
    ));
  }
  return { runSecrets };
}
