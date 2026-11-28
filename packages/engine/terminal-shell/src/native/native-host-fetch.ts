import type { OperatorApiClientOptions } from '@goodvibes/engine/operator-client';
import { programCallHeadersFor } from '@goodvibes/engine/platform/platform/runtime/client';

type NativeHostFetch = NonNullable<OperatorApiClientOptions['fetchImpl']>;

/** The host, credential or project this request was bound to is no longer the selected one. */
export class NativeHostSelectionChangedError extends Error {
  constructor() {
    super('Native host selection changed.');
    this.name = 'NativeHostSelectionChangedError';
  }
}

/** Enforce the exact authority at the final network boundary, after asynchronous
 * platform middleware and on every transport retry. Redirects must never forward
 * original source/mutation bodies or substitute another authority's response.
 */
export function createNativeHostFetch(options: { readonly current: () => boolean; readonly fetchImpl?: NativeHostFetch }): NativeHostFetch {
  return async (input, init) => {
    if (!options.current()) throw new NativeHostSelectionChangedError();
    // This program's call context and, when the daemon issued one, the registration for this credential (call-context.ts).
    // A registration is optional and decides nothing: the daemon gives native authority by the kind of credential, so a
    // program that cannot register sends none and is served the same.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const target = input instanceof Request ? input.url : String(input);
    if (bearer) {
      for (const [name, value] of Object.entries(await programCallHeadersFor(target, bearer, (options.fetchImpl ?? fetch) as typeof fetch))) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    if (!options.current()) throw new NativeHostSelectionChangedError();
    const response = await (options.fetchImpl ?? fetch)(input, { ...init, headers, redirect: 'error' });
    if (!options.current()) {
      // A borrowed transport may ignore AbortSignal and return a streaming
      // response after retirement. Release its body before the request drains.
      try { await response.body?.cancel(); }
      catch { /* A failed cleanup cannot make the stale response usable. */ }
      throw new NativeHostSelectionChangedError();
    }
    return response;
  };
}
