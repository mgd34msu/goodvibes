import {
  BUILTIN_SECRET_PROVIDER_SOURCES,
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type LiteralSecretsManager,
  type SecretScope,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { formatJsonOrText, yesNo } from './cli-output.js';
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
      const values = rest.filter((arg) => !arg.startsWith('--'));
      const [key, ...rawValueParts] = values;
      const value = rawValueParts.join(' ');
      if (!key || !value) return `Usage: ${policy.binary(runtime)} secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext]`;
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
