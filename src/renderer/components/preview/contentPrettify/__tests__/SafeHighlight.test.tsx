// ============================================================================
// SAFE HIGHLIGHT TESTS
// Tests for XSS prevention in syntax highlighting
// ============================================================================

import { describe, it, expect } from 'vitest';
import React from 'react';
import { parseHighlightedCode, splitHighlightedLines } from '../SafeHighlight';

// Helper to check if element is a React element with specific type
function isReactElementOfType(el: unknown, type: string): boolean {
  return React.isValidElement(el) && el.type === type;
}

// Helper to check if element has specific props
function elementHasClassName(el: unknown, className: string): boolean {
  if (!React.isValidElement(el)) return false;
  const props = el.props as { className?: string };
  return props.className === className;
}

describe('parseHighlightedCode', () => {
  describe('Safe HTML Parsing', () => {
    it('parses simple hljs span elements', () => {
      const html = '<span class="hljs-keyword">const</span>';
      const elements = parseHighlightedCode(html);

      expect(elements).toHaveLength(1);
      expect(elements[0]).toBeTruthy();
    });

    it('parses nested hljs span elements', () => {
      const html = '<span class="hljs-function"><span class="hljs-keyword">function</span></span>';
      const elements = parseHighlightedCode(html);

      expect(elements).toHaveLength(1);
    });

    it('parses text before and after spans', () => {
      const html = 'before <span class="hljs-keyword">const</span> after';
      const elements = parseHighlightedCode(html);

      expect(elements.length).toBeGreaterThan(1);
    });

    it('decodes HTML entities', () => {
      const html = '&lt;script&gt; &amp; &quot;test&quot;';
      const elements = parseHighlightedCode(html);

      // The decoded string should contain the actual characters
      const textContent = elements.map(el => typeof el === 'string' ? el : '').join('');
      expect(textContent).toContain('<script>');
      expect(textContent).toContain('&');
      expect(textContent).toContain('"test"');
    });
  });

  describe('XSS Prevention', () => {
    it('does not create script elements from input', () => {
      // If highlight.js were compromised or input was malformed
      const malicious = '<script>alert("XSS")</script><span class="hljs-keyword">safe</span>';
      const elements = parseHighlightedCode(malicious);

      // The parser should only extract hljs spans, ignoring script tags
      // Script content will be treated as plain text
      const hasScript = elements.some((el) => isReactElementOfType(el, 'script'));
      expect(hasScript).toBe(false);
    });

    it('rejects non-hljs class names', () => {
      // Only hljs-* classes should create span elements
      const html = '<span class="malicious-class">test</span>';
      const elements = parseHighlightedCode(html);

      // The entire string is treated as plain text since it doesn't match hljs-* pattern
      expect(elements).toHaveLength(1);
      expect(typeof elements[0]).toBe('string');
    });

    it('creates spans only with hljs-* class names', () => {
      const html = '<span class="hljs-keyword">const</span>';
      const elements = parseHighlightedCode(html);

      expect(elements).toHaveLength(1);
      expect(elementHasClassName(elements[0], 'hljs-keyword')).toBe(true);
    });

    it('rejects spans with event handlers by not including them in output', () => {
      const malicious = '<span class="hljs-keyword" onclick="alert(1)">test</span>';
      const elements = parseHighlightedCode(malicious);

      // The parser only captures class="hljs-*" pattern, onclick is ignored
      // because the regex specifically matches class="hljs-..."
      // If there are extra attributes, they won't be in the output
      const stringified = JSON.stringify(elements);
      expect(stringified).not.toContain('onclick');
      expect(stringified).not.toContain('alert');
    });

    it('handles malicious content inside valid spans', () => {
      const html = '<span class="hljs-string">"&lt;script&gt;alert(1)&lt;/script&gt;"</span>';
      const elements = parseHighlightedCode(html);

      // The content is decoded but rendered as text, not executed
      expect(elements).toHaveLength(1);
      // When rendered as React elements, these are text nodes, not HTML
    });

    it('ignores iframe tags', () => {
      const malicious = '<iframe src="javascript:alert(1)"></iframe><span class="hljs-keyword">safe</span>';
      const elements = parseHighlightedCode(malicious);

      const hasIframe = elements.some((el) => isReactElementOfType(el, 'iframe'));
      expect(hasIframe).toBe(false);
    });

    it('ignores img tags with onerror', () => {
      const malicious = '<img onerror="alert(1)" src="x"><span class="hljs-keyword">safe</span>';
      const elements = parseHighlightedCode(malicious);

      const hasImg = elements.some((el) => isReactElementOfType(el, 'img'));
      expect(hasImg).toBe(false);
    });
  });

  describe('Highlight.js Typical Output', () => {
    it('parses JavaScript code highlighting', () => {
      const html = '<span class="hljs-keyword">const</span> x = <span class="hljs-number">42</span>;';
      const elements = parseHighlightedCode(html);

      expect(elements.length).toBeGreaterThan(0);
    });

    it('parses TypeScript code highlighting', () => {
      const html = '<span class="hljs-keyword">interface</span> <span class="hljs-title class_">Person</span>';
      const elements = parseHighlightedCode(html);

      expect(elements.length).toBeGreaterThan(0);
    });

    it('parses HTML/XML code highlighting', () => {
      const html = '<span class="hljs-tag">&lt;<span class="hljs-name">div</span>&gt;</span>content';
      const elements = parseHighlightedCode(html);

      expect(elements.length).toBeGreaterThan(0);
    });

    it('parses Python code highlighting', () => {
      const html = '<span class="hljs-keyword">def</span> <span class="hljs-title function_">hello</span>():';
      const elements = parseHighlightedCode(html);

      expect(elements.length).toBeGreaterThan(0);
    });
  });
});

describe('splitHighlightedLines', () => {
  it('splits HTML by newlines', () => {
    const html = 'line1\nline2\nline3';
    const lines = splitHighlightedLines(html);

    expect(lines).toHaveLength(3);
  });

  it('preserves highlighting across lines', () => {
    const html = '<span class="hljs-keyword">const</span>\n<span class="hljs-number">42</span>';
    const lines = splitHighlightedLines(html);

    expect(lines).toHaveLength(2);
  });

  it('handles empty lines', () => {
    const html = 'line1\n\nline3';
    const lines = splitHighlightedLines(html);

    expect(lines).toHaveLength(3);
    // Empty lines should get a non-breaking space
    expect(lines[1]).toEqual(['\u00A0']);
  });

  it('handles single line', () => {
    const html = '<span class="hljs-keyword">const</span>';
    const lines = splitHighlightedLines(html);

    expect(lines).toHaveLength(1);
  });
});
