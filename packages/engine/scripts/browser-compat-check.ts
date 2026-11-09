import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');

const runtimeNeutralEntries = [
  'contracts/dist/index.js',
  'errors/dist/index.js',
  'operator-client/dist/index.js',
  'peer-client/dist/index.js',
  'platform/dist/index.js',
  'platform/dist/browser.js',
  'platform/dist/browser-homeassistant.js',
  'platform/dist/browser-knowledge.js',
  'platform/dist/browser-decision-router.js',
  'platform/dist/platform/gate/presets.js',
  'platform/dist/platform/channels/telegram/cursor-migration-data.js',
  'platform/dist/react-native.js',
  'platform/dist/expo.js',
  // /auth subpath is used by RN consumers for token helpers, must be node:-free
  'platform/dist/auth.js',
  'transport-core/dist/index.js',
  'transport-http/dist/index.js',
  'transport-realtime/dist/index.js',
];

const disallowedPatterns = [
  /from ['"]node:/,
  /require\(['"]node:/,
  /from ['"]fs['"]/,
  /require\(['"]fs['"]\)/,
];

for (const relativePath of runtimeNeutralEntries) {
  const content = readFileSync(resolve(ENGINE_ROOT, relativePath), 'utf8');
  for (const pattern of disallowedPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Runtime-neutral entry leaked a Node-only import: ${relativePath}`);
    }
  }
}

console.log('browser/runtime-neutral runtime-neutral support check passed');
