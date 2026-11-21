/** One definition of a usable web UI bundle. */
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';

/** True when the configured bundle directory (the router's precedence) holds a readable `index.html`. */
export function hasReadableWebuiBundle(config: Pick<ConfigManager, 'get'>): boolean {
  const bundle = String(config.get('controlPlane.webui.bundleDir') ?? '').trim()
    || String(config.get('web.staticAssetsDir') ?? '').trim();
  try {
    if (!bundle || !statSync(resolve(bundle, 'index.html')).isFile()) return false;
    accessSync(resolve(bundle, 'index.html'), constants.R_OK);
    return true;
  } catch { return false; }
}
