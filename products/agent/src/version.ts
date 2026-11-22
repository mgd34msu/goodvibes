import { readProductVersion } from '@goodvibes/engine/platform/platform/utils/product-identity';
// Kept as a literal for prebuild and monorepo version synchronization.
let _version = '3.4.5';
export const COMPILED_VERSION = _version;
export const VERSION = readProductVersion(import.meta.dir, '@goodvibes/agent', _version);
