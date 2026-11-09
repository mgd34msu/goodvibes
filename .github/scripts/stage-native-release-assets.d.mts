import type { Buffer } from 'node:buffer';
import type { TarEntry } from '../../packages/engine/platform/src/platform/browser/browser-driver-archive.js';
import type { DaemonCiArtifact } from '../../packages/engine/platform/src/platform/runtime/daemon-native-cohort.js';
import type { createReleaseStage, PublishedReleaseFile } from '@goodvibes-jev/engine/toolchain/release-publication';

export function admitNativeReleaseArchive(bytes: Uint8Array, members: readonly { readonly path: string; readonly mode: number }[]): TarEntry[];
export function daemonReleaseArtifactDescriptors(artifact: DaemonCiArtifact, capabilityBytes: Uint8Array): { compatible: Buffer; capable: Buffer };
export function createNativeReleaseInput(): ReturnType<typeof createReleaseStage>;
export function createNativeReleaseOutput(destination: string, assertSource?: () => void): {
  readonly directory: string;
  put(name: string, bytes: Buffer, mode: number): PublishedReleaseFile;
  archive(name: string, members: readonly string[], cwd: string, signal?: AbortSignal): Promise<PublishedReleaseFile>;
  assertCurrent(): void;
  cleanup(): void;
};
export function cleanupNativeReleaseStages(stages: readonly ({ cleanup(): void } | undefined)[], failure?: unknown, failed?: boolean): unknown;
