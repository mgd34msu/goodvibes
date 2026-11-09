import type { inspectTerminalReaderArtifact, NativeArtifactMember, RetainedNativeArtifactFiles } from '@goodvibes-jev/engine/toolchain';
import type { PublishedReleaseFile } from '@goodvibes-jev/engine/toolchain/release-publication';

export const NATIVE_EXECUTION_TARGETS: readonly ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
export interface NativeExecutionSource {
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly headCommit: string;
  readonly target: typeof NATIVE_EXECUTION_TARGETS[number];
  readonly runId: string;
  readonly runAttempt: string;
}
export interface NativeExecutionMember { readonly path: string; readonly mode: number }
export interface NativeExecutionArtifact extends NativeExecutionSource {
  readonly schema: 1;
  readonly kind: 'daemon-native-execution';
  readonly packageName: '@goodvibes-jev/daemon';
  readonly version: string;
  readonly files: readonly (NativeExecutionMember & { readonly sha256: string; readonly size: number })[];
}
export function nativeExecutionPayloadMembers(product: string, target: NativeExecutionSource['target']): readonly NativeExecutionMember[];
export function nativeExecutionMembers(product: string, target: NativeExecutionSource['target']): readonly NativeExecutionMember[];
export function retainNativeExecutionFiles(root: string, members: readonly NativeArtifactMember[], options?: { readonly directoryRevisions?: boolean }): RetainedNativeArtifactFiles;
export function recordNativeExecutionArtifact(product: string, source: NativeExecutionSource, options?: { readonly inspectReader?: typeof inspectTerminalReaderArtifact }): NativeExecutionArtifact;
export function verifyNativeExecutionArtifact(product: string, source: NativeExecutionSource, options?: { readonly allowEarlierAttempt?: boolean }): {
  readonly artifact: NativeExecutionArtifact;
  readonly members: readonly NativeExecutionMember[];
  readonly retained: RetainedNativeArtifactFiles;
};
export function nativeExecutionSource(product: string, sourceCommit: string, headCommit: string, env?: Readonly<Record<string, string | undefined>>): NativeExecutionSource;
export function archiveNativeExecutionArtifact(product: string, source: NativeExecutionSource, archive: string, signal?: AbortSignal): Promise<PublishedReleaseFile>;
