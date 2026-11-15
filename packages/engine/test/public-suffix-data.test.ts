import { describe, expect, test } from 'bun:test';
import { comparePublicSuffixList } from '../scripts/check-public-suffix-drift.ts';
import { renderPublicSuffixData } from '../scripts/generate-public-suffix-data.ts';
import { CURATED_PRIVATE_SUFFIXES, MIN_MULTI_LABEL_SUFFIXES } from '../scripts/public-suffix-source.ts';

function listText(multiLabel: readonly string[], extra: readonly string[] = []): string {
  return ['// ===BEGIN ICANN DOMAINS===', ...multiLabel, ...extra, '// ===END ICANN DOMAINS===', '// ===BEGIN PRIVATE DOMAINS==='].join('\n');
}

function manySuffixes(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `s${String(index)}.example`);
}

const bundledOf = (multiLabel: string[], wildcardParents: string[] = [], exceptions: string[] = []) => ({
  multiLabel: new Set(multiLabel),
  wildcardParents: new Set(wildcardParents),
  exceptions: new Set(exceptions),
});

describe('generator', () => {
  test('refuses a list with markers but too few suffixes and writes nothing', () => {
    expect(() => renderPublicSuffixData(listText(['a.example', 'b.example']), '2026-01-01')).toThrow('refusing to overwrite');
  });

  test('refuses markers in the wrong order', () => {
    expect(() => renderPublicSuffixData('// ===END ICANN DOMAINS===\n// ===BEGIN ICANN DOMAINS===', '2026-01-01')).toThrow('markers');
  });

  test('a full list renders its curated private suffixes alongside the ICANN ones', () => {
    const { source, multiLabel } = renderPublicSuffixData(listText(manySuffixes(MIN_MULTI_LABEL_SUFFIXES + 5), ['*.wild.example', '!ok.wild.example']), '2026-01-01');
    expect(multiLabel).toBe(MIN_MULTI_LABEL_SUFFIXES + 5 + CURATED_PRIVATE_SUFFIXES.length);
    expect(source).toContain("'github.io'");
    expect(source).toContain("'wild.example'");
    expect(source).toContain("'ok.wild.example'");
  });
});

describe('drift check', () => {
  test('a curated private suffix is never reported stale', () => {
    const drift = comparePublicSuffixList(listText(['a.example']), bundledOf(['a.example', ...CURATED_PRIVATE_SUFFIXES]));
    expect(drift.stale).toEqual([]);
  });

  test('a suffix removed from the bundle but kept upstream is reported missing', () => {
    const drift = comparePublicSuffixList(listText(['a.example', 'b.example']), bundledOf(['a.example']));
    expect(drift.missing).toEqual(['b.example']);
  });

  test('an upstream wildcard the bundle lacks is reported', () => {
    const drift = comparePublicSuffixList(listText(['a.example'], ['*.new.example']), bundledOf(['a.example']));
    expect(drift.missingWildcards).toEqual(['new.example']);
  });

  test('a dropped wildcard and a dropped exception are reported stale', () => {
    const drift = comparePublicSuffixList(
      listText(['a.example']),
      bundledOf(['a.example'], ['old.example'], ['x.old.example']),
    );
    expect(drift.staleWildcards).toEqual(['old.example']);
    expect(drift.staleExceptions).toEqual(['x.old.example']);
  });

  test('an upstream exception the bundle lacks is reported', () => {
    const drift = comparePublicSuffixList(listText(['a.example'], ['!ok.wild.example']), bundledOf(['a.example'], ['wild.example']));
    expect(drift.missingExceptions).toEqual(['ok.wild.example']);
  });

  test('matching lists report nothing', () => {
    const drift = comparePublicSuffixList(
      listText(['a.example'], ['*.w.example', '!k.w.example']),
      bundledOf(['a.example'], ['w.example'], ['k.w.example']),
    );
    expect([drift.missing, drift.stale, drift.missingWildcards, drift.staleWildcards, drift.missingExceptions, drift.staleExceptions].flat()).toEqual([]);
  });
});
