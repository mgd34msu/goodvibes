import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEBUI_MANIFEST = resolve(import.meta.dir, '../../../../products/webui/package.json');

/** The version the WebUI manifest pins for a tool the engine tests borrow from the install; a bump there moves the tests with it. */
export function declaredToolVersion(name: string): string {
  const manifest = JSON.parse(readFileSync(WEBUI_MANIFEST, 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  const version = manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];
  if (!version) throw new Error(`products/webui/package.json declares no ${name}`);
  return version.replace(/^[\^~]/, '');
}

/** The Bun store directory holding exactly the declared version of a package; entries differing only by peer resolution are ordered by name so the pick is stable. */
export function findInstalledToolEntry(store: string, name: string): string | undefined {
  const version = declaredToolVersion(name);
  return readdirSync(store)
    .filter((entry) => entry === `${name}@${version}` || entry.startsWith(`${name}@${version}+`))
    .filter((entry) => {
      const manifest = join(store, entry, 'node_modules', name, 'package.json');
      return existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version === version;
    })
    .sort()[0];
}
