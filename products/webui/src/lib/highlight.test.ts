import { describe, expect, test } from 'bun:test';
import { escapeHtml, highlightCode, normalizeLanguage } from './highlight';

describe('escapeHtml', () => {
  test('escapes every character that could open markup or an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('normalizeLanguage', () => {
  test('resolves an alias to the registered language, ignoring case and padding', () => {
    expect(normalizeLanguage(' TS ')).toBe('typescript');
    expect(normalizeLanguage('sh')).toBe('bash');
  });
  test('an unknown tag resolves to nothing', () => {
    expect(normalizeLanguage('klingon')).toBe('');
    expect(normalizeLanguage('')).toBe('');
  });
});

describe('highlightCode', () => {
  test('an unknown language falls back to escaped plain text', () => {
    expect(highlightCode('<b>x</b>', 'klingon')).toEqual({ language: '', html: '&lt;b&gt;x&lt;/b&gt;' });
  });
  test('a known language returns highlighted markup under its canonical name', () => {
    const result = highlightCode('const a = 1;', 'ts');
    expect(result.language).toBe('typescript');
    expect(result.html).toContain('hljs-keyword');
  });
});
