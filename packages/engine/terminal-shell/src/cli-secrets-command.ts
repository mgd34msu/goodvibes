import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type LiteralSecretsManager,
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

interface CliSecretRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
}
export function createCliSecretsCommand<Runtime extends CliSecretRuntime>(policy: {
  readonly createSecrets: (runtime: Runtime) => Pick<LiteralSecretsManager, 'get' | 'set' | 'delete' | 'inspect' | 'listDetailed'>;
  readonly binary: (runtime: Runtime) => string;
  readonly inline: boolean;
  readonly writeScope: (key: string, requested: SecretScope) => SecretScope;
  readonly deleteScope: (key: string, requested: SecretScope | undefined) => SecretScope | undefined;
  readonly relocation: (key: string, requested: SecretScope) => readonly string[];
  /** Test seam and non-process input for `--stdin`; defaults to the process's standard input. */
  readonly readStdin?: (() => Promise<string>) | undefined;
}) {
  async function handleSecrets(runtime: Runtime): Promise<string> {
    const secrets = policy.createSecrets(runtime);
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    if (sub === 'providers') {
      const value = { providers: BUILTIN_SECRET_PROVIDER_SOURCES };
      return formatJsonOrText(runtime.cli)(
        value,
        [
          'GoodVibes secret providers',
          ...BUILTIN_SECRET_PROVIDER_SOURCES.map((provider) => `  ${provider}`),
          '',
          'Secret refs use goodvibes://secrets/<source>/... and never embed secret values.',
        ].join('\n'),
      );
    }
    if (sub === 'test') {
      const ref = rest.join(' ').trim();
      if (!ref || !ref.startsWith('goodvibes://secrets/') || !isSecretRefInput(ref)) {
        return `Usage: ${policy.binary(runtime)} secrets test goodvibes://secrets/<source>/...`;
      }
      const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key) });
      const value = { ref: describeSecretRef(ref), resolved: Boolean(resolved.value) };
      return formatJsonOrText(runtime.cli)(
        value,
        policy.inline
          ? `[secrets] ${value.ref}: ${value.resolved ? 'resolved <redacted>' : 'missing'}`
          : ['GoodVibes secret test', '  ref ' + value.ref, '  result ' + (value.resolved ? 'resolved <redacted>' : 'missing')].join('\n'),
      );
    }
    if (sub === 'set' || sub === 'link') {
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      const usage = `Usage: ${policy.binary(runtime)} secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext] (or <KEY> --stdin to read the value from standard input)`;
      const unknownFlags = [...flags].filter((flag) => !SECRET_WRITE_FLAGS.has(flag));
      if (unknownFlags.length > 0) {
        return `Not stored: unknown option ${unknownFlags.join(', ')}. A value that starts with -- or contains spaces must be quoted as one argument, or read with --stdin. ${usage}`;
      }
      const positionals = rest.filter((arg) => !arg.startsWith('--'));
      const [key, ...valueParts] = positionals;
      // The value is exactly one argument: joining several would store a different secret than the one typed.
      if (valueParts.length > 1) {
        return `Not stored: ${valueParts.length} values were given for ${key}. Quote the value as one argument, or read it with --stdin. ${usage}`;
      }
      const value = flags.has('--stdin') ? (valueParts.length === 0 ? await (policy.readStdin ?? readProcessStdin)() : '') : (valueParts[0] ?? '');
      if (!key || !value) return usage;
      if (sub === 'link' && (!value.startsWith('goodvibes://secrets/') || !isSecretRefInput(value))) {
        return 'Invalid secret reference. Use goodvibes://secrets/<source>/...';
      }
      const requestedScope = flags.has('--user') ? 'user' : 'project';
      const scope = policy.writeScope(key, requestedScope);
      await secrets.set(key, value, {
        scope,
        medium: flags.has('--plaintext') ? 'plaintext' : 'secure',
      });
      return policy.inline
        ? `[secrets] ${sub === 'link' ? 'Linked' : 'Stored'}: ${key}`
        : [
            `Secret ${sub === 'link' ? 'linked' : 'stored'}`,
            '  key ' + key,
            '  scope ' + scope,
            ...policy.relocation(key, requestedScope),
          ].join('\n');
    }
    if (sub === 'delete') {
      const key = rest.find((arg) => !arg.startsWith('--'));
      if (!key) return `Usage: ${policy.binary(runtime)} secrets delete <KEY> [--user|--project] [--secure|--plaintext]`;
      const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
      await secrets.delete(key, {
        scope: policy.deleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
        medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
      });
      return policy.inline ? `[secrets] Deleted: ${key}` : 'Secret deleted\n  key ' + key;
    }
    const [records, review] = await Promise.all([secrets.listDetailed(), secrets.inspect()]);
    const stored = records.filter((record) => record.source !== 'env');
    const value = { policy: review.policy, records: stored, warnings: review.warnings };
    return formatJsonOrText(runtime.cli)(
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
    );
  }
  return { handleSecrets };
}
