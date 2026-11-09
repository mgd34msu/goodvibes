/** One actual static checker/preparation pass; no filesystem or policy cache. */
import { AsyncLocalStorage } from 'node:async_hooks';
const scopes = new AsyncLocalStorage<{ token: object | undefined }>();
export const currentStaticSourcePolicyPass = (): object | undefined => scopes.getStore()?.token;
export function withStaticSourcePolicyPass<T>(operation: () => T): T {
  if (currentStaticSourcePolicyPass()) return operation();
  const scope = { token: Object.freeze({}) as object | undefined };
  const close = () => { scope.token = undefined; };
  return scopes.run(scope, () => {
    try {
      const result = operation();
      if (result instanceof Promise) return result.finally(close) as T;
      close(); return result;
    } catch (error) { close(); throw error; }
  });
}
