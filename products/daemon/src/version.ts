import { readProductVersion } from '@goodvibes-jev/engine/platform/platform/utils/product-identity';
// Kept as a literal for prebuild and monorepo version synchronization.
let _version = '3.1.5';
export const COMPILED_VERSION = _version;
export const VERSION = readProductVersion(import.meta.dir, '@goodvibes-jev/daemon', _version);
