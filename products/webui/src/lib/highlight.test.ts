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
  test('an untagged or unknown-tag block is detected locally against the registered grammars', () => {
    expect(highlightCode('def square(value):\n    return value ** 2\nprint(square(4))', '').language).toBe('python');
    expect(highlightCode('SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id ORDER BY 2 DESC;', 'klingon').language).toBe('sql');
  });
  test('ordinary text with no grammar stays escaped plain text', () => {
    expect(highlightCode('', 'klingon')).toEqual({ language: '', html: '' });
    expect(highlightCode('<'.repeat(20_001), '')).toEqual({ language: '', html: '&lt;'.repeat(20_001) });
  });
  test('a known language returns highlighted markup under its canonical name', () => {
    const result = highlightCode('const a = 1;', 'ts');
    expect(result.language).toBe('typescript');
    expect(result.html).toContain('hljs-keyword');
  });
});
