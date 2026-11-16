import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { containsSecretLikeText } from '../agent/memory-safety.ts';

const NOT_PLAIN_DATA = 'The arguments must be plain JSON data: objects, arrays, strings, finite numbers, booleans and null, at most 64 levels deep.';
const SECRET_LIKE_WRITE = 'Nothing was saved: the arguments contain text that looks like a password, token or private key, and local records do not store secrets. Remove that text, or store the secret in the secret store and record only its key name.';

/**
 * Check that the original arguments are plain data before repair, without
 * invoking caller accessors. A write is also screened for secret-looking text
 * here, once, before admission, so the text never reaches the gate's decision
 * model; the refusal names the rule. A read or search is never screened.
 */
export function assertAgentMemoryInput(args: unknown, options: { readonly screenSecrets?: boolean } = {}): void {
  const screenSecrets = options.screenSecrets ?? true;
  const ancestors = new Set<object>();
  let nodes = 0;
  const invalid = () => new ToolInputProjectionError('invalid', NOT_PLAIN_DATA);
  const secret = (text: string) => { if (screenSecrets && containsSecretLikeText(text)) throw new ToolInputProjectionError('invalid', SECRET_LIKE_WRITE); };
  function inspect(value: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) throw invalid();
    if (typeof value === 'string') { secret(value); return; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || nodeTypes.isProxy(value) || ancestors.has(value)) throw invalid();
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length: unknown = array ? descriptors.length?.value : undefined;
    if (array && (typeof length !== 'number' || length > 20_000 || Reflect.ownKeys(descriptors).length !== length + 1)) throw invalid();
    ancestors.add(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw invalid();
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || (array && (typeof length !== 'number' || !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length))) throw invalid();
      secret(key);
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  inspect(args, 0);
}
