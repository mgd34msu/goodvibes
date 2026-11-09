/** Published reader evidence is bound to exact terminal payload bytes. It is
 * never inferred from a version, pathname, or an older binary's CLI behavior. */
import { createHash } from 'node:crypto';
import { parseSemanticVersion } from './semantic-version.js';
import { parseNativeReaderCapabilities, type NativeReaderCapabilities } from './native-reader-compatibility.js';

export type ClientReaderPackage = '@goodvibes-jev/tui' | '@goodvibes-jev/agent';
export type ClientReaderTarget = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export interface ClientReaderArtifact {
  readonly schema: 1;
  readonly packageName: ClientReaderPackage;
  readonly version: string;
  readonly target: ClientReaderTarget;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly headCommit: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly mode: number; readonly size: number }[];
  readonly readers: NativeReaderCapabilities;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function clientReaderAsset(packageName: ClientReaderPackage, target: ClientReaderTarget): string {
  return `${packageName === '@goodvibes-jev/tui' ? 'goodvibes' : 'goodvibes-agent'}-${target.replace(/^darwin-/, 'macos-')}`;
}
export function parseClientReaderArtifact(value: unknown): ClientReaderArtifact {
  if (!record(value) || !exact(value, ['schema', 'packageName', 'version', 'target', 'sourceCommit', 'sourceTree', 'headCommit', 'files', 'readers'])
    || value.schema !== 1 || (value.packageName !== '@goodvibes-jev/tui' && value.packageName !== '@goodvibes-jev/agent')
    || typeof value.version !== 'string' || !parseSemanticVersion(value.version)
    || (value.target !== 'linux-x64' && value.target !== 'linux-arm64' && value.target !== 'darwin-x64' && value.target !== 'darwin-arm64')
    || ![value.sourceCommit, value.sourceTree, value.headCommit].every(item => typeof item === 'string' && /^[a-f0-9]{40}$/.test(item))
    || !Array.isArray(value.files) || (value.files.length !== 1 && value.files.length !== 4)) throw new Error('Terminal reader artifact is invalid');
  const asset = clientReaderAsset(value.packageName, value.target);
  const expected = [asset, asset + '.bun', asset + '.bun.LICENSE.md', asset + '.bun.json'];
  if (value.files.length === 4 && !value.target.startsWith('linux-')) throw new Error('Terminal reader runtime target is invalid');
  const paths = new Set<string>(), inputFiles = value.files;
  const files = inputFiles.map((item: unknown) => {
    if (!record(item) || !exact(item, ['path', 'sha256', 'mode', 'size']) || typeof item.path !== 'string'
      || !expected.slice(0, inputFiles.length).includes(item.path) || paths.has(item.path)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || item.mode !== (item.path === asset || item.path === asset + '.bun' ? 0o755 : 0o644)
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0) throw new Error('Terminal reader payload is invalid');
    paths.add(item.path); return Object.freeze({ path: item.path, sha256: item.sha256, mode: Number(item.mode), size: item.size });
  });
  const readers = parseNativeReaderCapabilities(value.readers);
  if (readers.version !== value.version) throw new Error('Terminal reader version does not match its artifact');
  return Object.freeze({ schema: 1, packageName: value.packageName, version: value.version, target: value.target,
    sourceCommit: value.sourceCommit as string, sourceTree: value.sourceTree as string, headCommit: value.headCommit as string,
    files: Object.freeze(files), readers });
}
/** This digest verifies a published release integrity pin at maintenance time.
 * It is not an identity/revision cache and is never run by live data guards. */
export function assertClientReaderPayload(artifact: ClientReaderArtifact, path: string, bytes: Uint8Array): void {
  const file = artifact.files.find(item => item.path === path);
  if (!file || bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Terminal payload differs from its compiled reader evidence');
}
