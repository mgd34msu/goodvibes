import { admitInstalledClientDataWriter } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.ts';
/** Captured synchronously in the real executable's initial import graph, before
 * its first await. Source imports return no installation publisher. */
export const installedDataWriter = admitInstalledClientDataWriter({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });
