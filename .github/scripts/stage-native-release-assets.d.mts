import type { Buffer } from 'node:buffer';
import type { TarEntry } from '../../packages/engine/platform/src/platform/browser/browser-driver-archive.js';
import type { DaemonCiArtifact } from '../../packages/engine/platform/src/platform/runtime/daemon-native-cohort.js';

export function admitNativeReleaseArchive(bytes: Uint8Array, members: readonly { readonly path: string; readonly mode: number }[]): TarEntry[];
export function daemonReleaseArtifactDescriptors(artifact: DaemonCiArtifact, capabilityBytes: Uint8Array): { compatible: Buffer; capable: Buffer };
