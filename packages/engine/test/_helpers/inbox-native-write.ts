import { spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';

/** Observe the genuine next exclusive SQLite image descriptor, preserving all
 * other handle methods and the store's actual staged-write/publication path. */
export function observeNextInboxImageWrite(dbPath: string, effect: (write: () => Promise<void>) => Promise<void>) {
  const open = fs.open.bind(fs); let selected = false;
  return spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (selected || flags !== 'wx' || !String(path).startsWith(`${dbPath}.`) || !String(path).endsWith('.tmp')) return handle;
    selected = true;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'writeFile') {
          const write = target.writeFile.bind(target);
          return (...args: Parameters<typeof write>) => effect(() => write(...args));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}
