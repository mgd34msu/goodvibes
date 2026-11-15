import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DAEMON_RELEASES_LATEST_URL } from '../packages/engine/platform/src/platform/config/schema-domain-update.ts';

// The shell scripts run before any TypeScript is installed, so they name the
// release repository themselves; they must name the one the updater uses.
const repository = new URL(DAEMON_RELEASES_LATEST_URL).pathname.split('/').slice(1, 3).join('/');
const script = (name: string) => readFileSync(resolve(import.meta.dir, name), 'utf8');

test('install.sh downloads from the repository the updater uses', () => {
  expect(script('install.sh').match(/^REPO="([^"]+)"$/m)?.[1]).toBe(repository);
});

test('uninstall.sh fetches the installer from the repository the updater uses', () => {
  expect(script('uninstall.sh').match(/^repo=(\S+)$/m)?.[1]).toBe(repository);
});
