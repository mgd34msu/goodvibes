/** Intentionally narrow pre-loader entry: no daemon/service/database graph. */
export { isCompiledBunModuleUrl } from '../utils/bun-module.js';
export { detectInstallKind } from './install-kind.js';
export { captureUpdateFileIo, realUpdateFileIo } from './update-file-io.js';
export { resolveDarwinDaemonTargets } from './darwin-daemon-paths.js';
export { retainNativeUpdateSources } from './native-file-sources.js';
