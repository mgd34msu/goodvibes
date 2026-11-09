/** Fixed paths only: safe before selecting Darwin's custom SQLite library. */
import { dirname, basename, join } from 'node:path';
import type { UpdateTarget } from './self-update.js';
export function resolveDarwinDaemonTargets(execPath: string, arch: string): readonly UpdateTarget[] | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  const asset = `goodvibes-daemon-macos-${arch}`, root = dirname(execPath), target = `darwin-${arch}`;
  if (basename(execPath) !== 'goodvibes-daemon' && basename(execPath) !== asset) throw new Error('Darwin executable has the wrong daemon identity');
  return Object.freeze([
    { label: 'Darwin daemon', path: execPath, assetName: asset, executable: true },
    { label: 'Darwin daemon readers', path: execPath + '.readers.json', assetName: asset + '.reader-ci-artifact.json', executable: false },
    { label: 'SQLite vector extension', path: join(root, 'lib', `sqlite-vec-${target}`, 'vec0.dylib'), assetName: `sqlite-vec-${target}.dylib`, executable: false },
    { label: 'Darwin SQLite', path: join(root, 'lib', `sqlite-${target}`, 'libsqlite3.dylib'), assetName: `sqlite-${target}.dylib`, executable: false },
    { label: 'Darwin SQLite producer', path: join(root, 'lib', `sqlite-${target}`, 'libsqlite3.dylib.json'), assetName: `sqlite-${target}.dylib.json`, executable: false },
  ].map(value => Object.freeze(value)));
}
