// Deliberately per-repo test scaffolding: it binds to this repo's own working tree, source layout and Bun test lifecycle, and has no counterpart in the sibling product.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

export function resetSettingsControlPlaneStore(configManager: ConfigManager): void {
  rmSync(join(configManager.getControlPlaneConfigDir(), 'settings-sync.json'), {
    force: true,
  });
}
