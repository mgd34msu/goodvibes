/** Fixed first-failure diagnostics; never print exception text or values. */
import { RefusalError } from '@goodvibes-jev/engine/errors';

export type NativeStartupStage = 'sqlite' | 'darwin-original';
const ioCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBADF', 'EIO', 'ELOOP', 'ERR_DLOPEN_FAILED']);

export function nativeStartupFailureCode(error: unknown): string {
  if (error instanceof RefusalError) return error.refusal.code;
  if (error instanceof SyntaxError) return 'METADATA_JSON';
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && ioCodes.has(code) ? code : 'UNKNOWN';
}

export function nativeStartupFailureLine(stage: NativeStartupStage, error: unknown): string {
  return `[goodvibes-daemon:native-startup-failure] ${stage} ${nativeStartupFailureCode(error)}`;
}
