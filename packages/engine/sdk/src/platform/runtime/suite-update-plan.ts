/** One release selection for every installed product beside the invoking binary.
 * Absent products stay absent. Browser and native companions follow the same
 * selection; a configured installer-owned WebUI keeps its actual served path.
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSemanticVersion } from './semantic-version.js';
import { resolveDaemonNativeTargets } from './daemon-native-cohort.js';
import { captureUpdateFileIo, realUpdateFileIo, retainNativeUpdateDirectory, type UpdateFileIo } from './update-file-io.js';
import type { UpdateTarget } from './self-update.js';
import type { ClientReaderPackage, ClientReaderTarget } from './client-reader-artifact.js';

export type SuiteProgram = 'goodvibes' | 'goodvibes-agent' | 'goodvibes-daemon';
export interface SuiteProgramSelection {
  readonly name: SuiteProgram;
  readonly path: string;
  readonly assetName: string;
  readonly packageName: ClientReaderPackage;
  readonly readerKind: 'client' | 'linux-daemon';
}
export interface SuiteDirectorySelection {
  readonly kind: 'browser-driver' | 'webui';
  readonly path: string;
  readonly assetName: string;
  readonly archiveRoot: string;
  readonly requiredFiles: readonly string[];
}
export interface SuiteUpdatePlan {
  readonly version: string;
  readonly root: string;
  readonly target: ClientReaderTarget;
  readonly programs: readonly SuiteProgramSelection[];
  /** Native daemon members, when selected, precede the other exact targets. */
  readonly files: readonly UpdateTarget[];
  readonly directories: readonly SuiteDirectorySelection[];
  /** Original selection, including absent peer slots, before any network await. */
  assertCurrent(): void;
}
const products: readonly { readonly name: SuiteProgram; readonly packageName: ClientReaderPackage }[] = [
  { name: 'goodvibes-daemon', packageName: '@goodvibes-jev/daemon' },
  { name: 'goodvibes', packageName: '@goodvibes-jev/tui' },
  { name: 'goodvibes-agent', packageName: '@goodvibes-jev/agent' },
];

export function resolveSuiteUpdatePlan(options: {
  readonly execPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
  /** Actual configured bundle directory, read by the calling product. An
   * unconfigured or separately managed WebUI is not guessed from old folders. */
  readonly webuiDirectory?: string | undefined;
  readonly io?: UpdateFileIo;
}): SuiteUpdatePlan {
  const { platform, arch } = options, version = options.version.replace(/^v/, '');
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64') || !parseSemanticVersion(version)) throw new Error('Unsupported suite release target');
  if (!isAbsolute(options.execPath) || resolve(options.execPath) !== options.execPath) throw new Error('Suite executable requires its original absolute path');
  const io = captureUpdateFileIo(options.io ?? realUpdateFileIo), observe = io.observe;
  if (!observe || !io.readFile) throw new Error('Suite updates require retained native file observations');
  const root = dirname(options.execPath), target: ClientReaderTarget = `${platform}-${arch}`;
  const retainedRoot = retainNativeUpdateDirectory(root);
  const suffix = `${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  const invoking = products.find(product => basename(options.execPath) === product.name || basename(options.execPath) === `${product.name}-${suffix}`);
  if (!invoking) throw new Error('The invoking executable is not a GoodVibes suite product');
  const observations = products.map(product => {
    const path = product === invoking ? options.execPath : join(root, product.name);
    return { product, path, original: observe(path) };
  });
  if (!observations.find(slot => slot.product === invoking)?.original) throw new Error('The invoking suite executable is unavailable');
  const programs = observations.flatMap<SuiteProgramSelection>(slot => slot.original ? [{ name: slot.product.name, path: slot.path,
    assetName: `${slot.product.name}-${suffix}`, packageName: slot.product.packageName,
    readerKind: platform === 'linux' && slot.product.name === 'goodvibes-daemon' ? 'linux-daemon' : 'client' }] : []);
  const files: UpdateTarget[] = [];
  for (const program of programs) {
    if (program.readerKind === 'linux-daemon') {
      const native = resolveDaemonNativeTargets(program.path, platform, arch);
      if (!native) throw new Error('The installed daemon has no complete suite payload contract');
      files.push(...native);
    } else {
      files.push({ label: program.name, path: program.path, assetName: program.assetName, executable: true });
      if (platform === 'linux') for (const ending of ['.bun', '.bun.LICENSE.md', '.bun.json']) files.push({
        label: `${program.name}${ending}`, path: program.path + ending, assetName: program.assetName + ending, executable: ending === '.bun',
      });
      files.push({ label: `${program.name} reader metadata`, path: program.path + '.readers.json', assetName: program.assetName + '.reader-ci-artifact.json', executable: false });
    }
  }
  const extension = platform === 'linux' ? 'so' : 'dylib';
  const vectorPath = join(root, 'lib', `sqlite-vec-${target}`, `vec0.${extension}`);
  if (!files.some(file => file.path === vectorPath)) files.push({ label: 'SQLite vector extension', path: vectorPath, assetName: `sqlite-vec-${target}.${extension}`, executable: false });
  if (platform === 'darwin' && programs.some(program => program.name === 'goodvibes-daemon')) {
    for (const ending of ['', '.json']) files.push({ label: `macOS SQLite${ending}`, path: join(root, 'lib', `sqlite-${target}`, 'libsqlite3.dylib' + ending),
      assetName: `sqlite-${target}.dylib${ending}`, executable: false });
  }
  const directories: SuiteDirectorySelection[] = [{ kind: 'browser-driver', path: join(root, 'playwright-core'), assetName: 'browser-driver.tar.gz',
    archiveRoot: 'playwright-core', requiredFiles: ['package.json', 'index.js', 'cli.js'] }];
  if (options.webuiDirectory?.trim()) {
    const path = resolve(options.webuiDirectory), webuiRoot = join(root, 'webui'), child = relative(webuiRoot, path);
    if (!isAbsolute(options.webuiDirectory) || !child || child.startsWith('..') || isAbsolute(child) || child.includes('/') || child.includes('\\')) {
      throw new Error('The configured WebUI is separately managed; update its deployment explicitly before updating this suite');
    }
    directories.push({ kind: 'webui', path, assetName: `goodvibes-webui-bundle-${version}.tar.gz`, archiveRoot: 'goodvibes-webui', requiredFiles: ['index.html'] });
  }
  const assertCurrent = () => {
    retainedRoot.assertCurrent();
    for (const slot of observations) {
      const current = observe(slot.path), previous = slot.original;
      if (current === null || previous === null ? current !== previous : current.identity !== previous.identity || current.ownerIdentity !== previous.ownerIdentity || current.mode !== previous.mode) {
        throw new Error('Installed suite selection changed while preparing its update');
      }
    }
    retainedRoot.assertCurrent();
  };
  assertCurrent();
  return Object.freeze({ version, root, target, programs: Object.freeze(programs.map(program => Object.freeze(program))),
    files: Object.freeze(files.map(file => Object.freeze({ ...file }))), directories: Object.freeze(directories.map(directory => Object.freeze({ ...directory, requiredFiles: Object.freeze([...directory.requiredFiles]) }))), assertCurrent });
}
