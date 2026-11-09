import { AsyncLocalStorage } from 'node:async_hooks';

const observers = new AsyncLocalStorage<(work: Promise<unknown>) => void>();

/** Observe retained runner work without changing its outward deadline/result. */
export function withHookWorkObserver<T>(observer: (work: Promise<unknown>) => void, run: () => Promise<T>): Promise<T> {
  return observers.run(observer, run);
}

export function retainHookWork<T>(work: Promise<T>): Promise<T> {
  observers.getStore()?.(work);
  return work;
}
