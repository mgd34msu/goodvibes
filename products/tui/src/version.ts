import { readProductVersion } from '@goodvibes-jev/engine/sdk/platform/utils/product-identity';
// Kept as a literal for prebuild and monorepo version synchronization.
let _version = '3.1.2';
export const VERSION = readProductVersion(import.meta.dir, '@goodvibes-jev/tui', _version);
