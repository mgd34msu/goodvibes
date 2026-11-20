import { configKeyFacts } from '@goodvibes-jev/engine/platform/platform/config';

/**
 * Where a `/settings set <key> <value>` line
 * holds a credential: every word of the value when the key is declared
 * secret-bearing (`configKeyFacts(key).secret`), else none. The input history
 * masks these positions and the handler reads them with `secretArg`.
 */
export function settingSetSecretPositions(args: readonly string[], skip: (token: string) => boolean = () => false): number[] {
  const words = args.map((token, index) => ({ token, index })).filter((entry) => !skip(entry.token));
  if (words[0]?.token !== 'set' || words[1] === undefined || !configKeyFacts(words[1].token).secret) return [];
  return words.slice(2).map((entry) => entry.index);
}
