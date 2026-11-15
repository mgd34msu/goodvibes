/**
 * A platform that refuses SQLite extension loading (macOS system SQLite in a
 * compiled binary) is a capability limit, not a fault: the vector store must
 * degrade with platformLimitReason set and NO error field, while a genuine
 * packaging defect (missing extension file) must stay a loud error.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { forgetSqliteVecPlatformRefusal, loadSqliteVecExtension, SqliteVecPlatformUnsupportedError } from '../platform/src/platform/state/sqlite-vec-loader.ts';

describe('sqlite-vec platform-limit classification', () => {
  test('the typed platform error carries the honest literal-fallback wording', () => {
    const err = new SqliteVecPlatformUnsupportedError('not authorized');
    expect(err.platformLimit).toBe(true);
    expect(err.message).toContain('does not allow loading extensions');
    expect(err.message).toContain('literal matching');
    // The reason must never read as a fault: release smokes grep for these.
    expect(err.message.toLowerCase()).not.toContain('error');
    expect(err.message.toLowerCase()).not.toContain('fail');
  });
  test('the real darwin refusal message classifies as the platform limit', () => {
    // Verbatim from a macOS-compiled binary (Apple system SQLite):
    const darwin = 'This build of sqlite3 does not support dynamic extension loading';
    const err = new SqliteVecPlatformUnsupportedError(darwin);
    expect(err.platformLimit).toBe(true);
  });
});

/**
 * Whether a load failure is the platform's refusal is decided in code: the
 * library's compile options or the platform, never a model request.
 */
describe('a load failure is classified in code', () => {
  afterEach(() => forgetSqliteVecPlatformRefusal());

  const fakeDb = (msg: string, omitted = 0) => ({
    loadExtension: () => { throw new Error(msg); },
    query: () => ({ get: () => ({ omitted }) }),
  });

  test('a build compiled without extension loading is the platform limit', () => {
    const refusal = 'This build of sqlite3 does not support dynamic extension loading';
    let failure: unknown;
    try { loadSqliteVecExtension(fakeDb(refusal, 1) as never, { platform: 'linux' }); } catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(SqliteVecPlatformUnsupportedError);
    expect((failure as Error).message).toContain(refusal);
  });

  test('on macOS a refused load is the platform limit, and the second index does not try again', () => {
    let attempts = 0;
    const db = { loadExtension: () => { attempts++; throw new Error('not authorized'); }, query: () => ({ get: () => ({ omitted: 0 }) }) };
    expect(() => loadSqliteVecExtension(db as never, { platform: 'darwin' })).toThrow(SqliteVecPlatformUnsupportedError);
    expect(() => loadSqliteVecExtension(db as never, { platform: 'darwin' })).toThrow(SqliteVecPlatformUnsupportedError);
    expect(attempts).toBe(1);
  });

  test('elsewhere a refused load is rethrown as the original error, a loud defect', () => {
    const missing = 'dlopen failed: no such file or directory';
    let failure: unknown;
    try { loadSqliteVecExtension(fakeDb(missing) as never, { platform: 'linux' }); } catch (err) { failure = err; }
    expect(failure).not.toBeInstanceOf(SqliteVecPlatformUnsupportedError);
    expect((failure as Error).message).toBe(missing);
  });
});
