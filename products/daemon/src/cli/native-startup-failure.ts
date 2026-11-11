/** Fixed first-failure diagnostics; never print borrowed exception text/values. */
export type NativeStartupStage = 'sqlite' | 'darwin-original';
const guards = new Map([
  ['Unsupported Darwin native SQLite architecture', 'SQLITE_ARCH_UNSUPPORTED'],
  ['Native SQLite library is not the declared Mach-O architecture', 'SQLITE_ARCH_MISMATCH'],
  ['Native SQLite parent is not a regular directory', 'SQLITE_PARENT_TYPE'],
  ['Native SQLite companion must be a regular file with mode 0644', 'SQLITE_FILE_MODE'],
  ['Native SQLite companion exceeds its compiled size bound', 'SQLITE_SIZE_BOUND'],
  ['Native SQLite companion changed during bounded read', 'SQLITE_READ_CHANGED'],
  ['Native SQLite lifetime must be synchronous', 'SQLITE_LIFETIME_ASYNC'],
  ['Native SQLite runtime is undeclared', 'SQLITE_RUNTIME_UNDECLARED'],
  ['Native SQLite compiled producer owner is absent or invalid', 'SQLITE_COMPILED_OWNER'],
  ['Native SQLite library differs from the compiled producer bytes', 'SQLITE_BYTES_MISMATCH'],
  ['Native SQLite companion owner or bytes differ from the declared runtime', 'SQLITE_PROVENANCE_MISMATCH'],
  ['Native SQLite companion changed before database construction', 'SQLITE_ADMISSION_CHANGED'],
  ['Bun refused the retained native SQLite runtime before database construction', 'SQLITE_LOADER_REFUSED'],
  ['Original native SQLite source changed', 'SQLITE_SOURCE_CHANGED'],
  ['Original compiled Darwin SQLite owner is unavailable', 'DARWIN_SQLITE_OWNER'],
  ['Darwin daemon target is unsupported', 'DARWIN_TARGET'],
  ['Native daemon I/O requires retained file observations and reads', 'DARWIN_IO_OBSERVATIONS'],
  ['Native daemon installation changed during preparation', 'DARWIN_SOURCE_CHANGED'],
]);
const ioCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EBADF', 'EIO', 'ELOOP', 'ERR_DLOPEN_FAILED']);

export function nativeStartupFailureCode(error: unknown): string {
  try {
    if (error === null || typeof error !== 'object') return 'UNKNOWN';
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    if (message && 'value' in message && typeof message.value === 'string') {
      const guard = guards.get(message.value); if (guard) return guard;
    }
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code && 'value' in code && typeof code.value === 'string' && ioCodes.has(code.value)) return code.value;
    if (error instanceof SyntaxError) return 'METADATA_JSON';
  } catch { /* A borrowed accessor/proxy never grants a diagnostic value. */ }
  return 'UNKNOWN';
}

export function nativeStartupFailureLine(stage: NativeStartupStage, error: unknown): string {
  return `[goodvibes-daemon:native-startup-failure] ${stage} ${nativeStartupFailureCode(error)}`;
}
