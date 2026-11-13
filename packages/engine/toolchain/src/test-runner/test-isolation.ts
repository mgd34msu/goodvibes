import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Inherit execution/display/test controls, never the user's provider keys,
// subscriptions, proxies, preload hooks or application configuration paths.
const INHERITED = new Set([
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'CI', 'GITHUB_ACTIONS', 'NO_COLOR', 'FORCE_COLOR', 'TMPDIR', 'TMP', 'TEMP',
  // Set by scripts/test.ts; fixture children refuse to run outside it.
  'GOODVIBES_ENGINE_TEST_RUNNER',
  'GOODVIBES_ENGINE_DEV_ROUNDTRIP_TEST', 'GOODVIBES_UPDATE_GOLDENS',
  // Existing compiled E2E artifact selector; not application config or auth.
  'GOODVIBES_E2E_BINARY',
]);

/** Isolate persisted user state while allowing tests to declare fixture env explicitly. */
export function isolatedTestEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  root: string,
  fixtureEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    INHERITED.has(name) || /^GOODVIBES_(?:TEST|LEAK)_/.test(name) || /^BUN_TEST_/.test(name)));
  const homes = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  };
  for (const directory of new Set(Object.values(homes))) mkdirSync(directory, { recursive: true });
  return { ...env, NODE_ENV: 'test', ...fixtureEnv, ...homes };
}
