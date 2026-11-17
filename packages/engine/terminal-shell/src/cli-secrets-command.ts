import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type SecretsManager,
  type SecretScope,
} from '@goodvibes-jev/engine/platform/platform/config';
import { formatJsonOrText, yesNo } from './cli-output.js';
const SECRET_WRITE_FLAGS: ReadonlySet<string> = new Set(['--user', '--project', '--secure', '--plaintext', '--stdin']);

/** The value without the one trailing newline a piped `echo` adds. */
async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

/** What the command printed and the exit code its outcome decided. */
export interface CliSecretsResult {
  readonly output: string;
  readonly exitCode: number;
}

const ok = (output: string): CliSecretsResult => ({ output, exitCode: 0 });
const refused = (output: string): CliSecretsResult => ({ output, exitCode: 1 });
const usageError = (output: string): CliSecretsResult => ({ output, exitCode: 2 });

interface CliSecretRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
}
export function createCliSecretsCommand<Runtime extends CliSecretRuntime>(policy: {
  readonly createSecrets: (runtime: Runtime) => Pick<SecretsManager, 'get' | 'set' | 'delete' | 'inspect' | 'listDetailed'>;
  readonly binary: (runtime: Runtime) => string;
  readonly inline: boolean;
  readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
  readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
  readonly relocation: (key: string, requested: SecretScope) => readonly string[];
  /** Test seam and non-process input for `--stdin`; defaults to the process's standard input. */
  readonly readStdin?: (() => Promise<string>) | undefined;
}) {
  const usage = (runtime: Runtime): string =>
    `Usage: ${policy.binary(runtime)} secrets [list|providers|test <ref>|set <KEY> <value>|link <KEY> <ref>|delete <KEY>]`;

  async function runSecrets(runtime: Runtime): Promise<CliSecretsResult> {
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
      if (!ref || !ref.startsWith('goodvibes://secrets/') || !isSecretRefInput(ref)) {
        return usageError(`Usage: ${policy.binary(runtime)} secrets test goodvibes://secrets/<source>/...`);
      }
      const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key) });
      const value = { ref: describeSecretRef(ref), resolved: Boolean(resolved.value) };
      // A ref that does not resolve is a failed test, in text and in JSON alike.
      const report = value.resolved ? ok : refused;
      return report(formatJsonOrText(runtime.cli)(
        value,
        policy.inline
          ? `[secrets] ${value.ref}: ${value.resolved ? 'resolved <redacted>' : 'missing'}`
          : ['GoodVibes secret test', '  ref ' + value.ref, '  result ' + (value.resolved ? 'resolved <redacted>' : 'missing')].join('\n'),
      ));
    }
    if (sub === 'set' || sub === 'link') {
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      const setUsage = `Usage: ${policy.binary(runtime)} secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext] (or <KEY> --stdin to read the value from standard input)`;
      const unknownFlags = [...flags].filter((flag) => !SECRET_WRITE_FLAGS.has(flag));
      if (unknownFlags.length > 0) {
        return refused(`Not stored: unknown option ${unknownFlags.join(', ')}. A value that starts with -- or contains spaces must be quoted as one argument, or read with --stdin. ${setUsage}`);
      }
      const positionals = rest.filter((arg) => !arg.startsWith('--'));
      const [key, ...valueParts] = positionals;
      // The value is exactly one argument: joining several would store a different secret than the one typed.
      if (valueParts.length > 1) {
        return refused(`Not stored: ${valueParts.length} values were given for ${key}. Quote the value as one argument, or read it with --stdin. ${setUsage}`);
      }
      const value = flags.has('--stdin') ? (valueParts.length === 0 ? await (policy.readStdin ?? readProcessStdin)() : '') : (valueParts[0] ?? '');
      if (!key || !value) return usageError(setUsage);
      if (sub === 'link' && (!value.startsWith('goodvibes://secrets/') || !isSecretRefInput(value))) {
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
      const key = rest.find((arg) => !arg.startsWith('--'));
      if (!key) return usageError(`Usage: ${policy.binary(runtime)} secrets delete <KEY> [--user|--project] [--secure|--plaintext]`);
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      await secrets.delete(key, {
        scope: policy.deleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
        medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
      });
      return ok(policy.inline ? `[secrets] Deleted: ${key}` : 'Secret deleted\n  key ' + key);
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
  /** The printed text alone, for a caller that has not moved to `runSecrets` yet. */
  async function handleSecrets(runtime: Runtime): Promise<string> {
    return (await runSecrets(runtime)).output;
  }
  return { runSecrets, handleSecrets };
}
