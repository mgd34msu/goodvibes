// ============================================================================
// SANITIZATION UTILITY TESTS
// Tests for XSS prevention in HTML rendering
// ============================================================================

import { describe, it, expect } from 'vitest';
import { sanitizeHtml, createSanitizedHtml, escapeHtmlStrict } from '../sanitize';

describe('sanitizeHtml', () => {
  describe('XSS Attack Prevention', () => {
    it('removes script tags', () => {
      const malicious = '<script>alert("XSS")</script>safe content';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('alert');
      expect(result).toContain('safe content');
    });

    it('removes script tags with attributes', () => {
      const malicious = '<script src="evil.js"></script>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('evil.js');
    });

    it('removes event handler attributes', () => {
      const malicious = '<span onclick="alert(\'XSS\')">click me</span>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('alert');
      expect(result).toContain('click me');
    });

    it('removes onerror handlers', () => {
      const malicious = '<img onerror="alert(\'XSS\')" src="x">';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('alert');
    });

    it('removes iframe tags', () => {
      const malicious = '<iframe src="javascript:alert(\'XSS\')"></iframe>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('javascript:');
    });

    it('removes javascript: URLs', () => {
      const malicious = '<a href="javascript:alert(\'XSS\')">click</a>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('href');
    });

    it('removes style tags', () => {
      const malicious = '<style>body{background:url("javascript:alert(\'XSS\')")}</style>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<style');
      expect(result).not.toContain('javascript:');
    });

    it('removes form elements', () => {
      const malicious = '<form action="http://evil.com"><input name="password"></form>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<form');
      expect(result).not.toContain('<input');
      expect(result).not.toContain('evil.com');
    });

    it('removes object/embed tags', () => {
      const malicious = '<object data="malware.swf"></object><embed src="evil.swf">';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<object');
      expect(result).not.toContain('<embed');
      expect(result).not.toContain('malware.swf');
    });

    it('handles nested XSS attempts', () => {
      const malicious = '<div><script><script>alert("XSS")</script></script></div>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
    });

    it('handles encoded XSS attempts', () => {
      // Various encoding attempts
      const malicious1 = '<scr\x00ipt>alert("XSS")</script>';
      const malicious2 = '<script>alert&#40;"XSS"&#41;</script>';

      expect(sanitizeHtml(malicious1)).not.toContain('<script');
      expect(sanitizeHtml(malicious2)).not.toContain('<script');
    });

    it('removes data: URLs in src attributes', () => {
      const malicious = '<img src="data:text/html,<script>alert(1)</script>">';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('data:');
      expect(result).not.toContain('<script');
    });

    it('handles SVG-based XSS', () => {
      const malicious = '<svg onload="alert(\'XSS\')"><script>alert(1)</script></svg>';
      const result = sanitizeHtml(malicious);
      expect(result).not.toContain('onload');
      expect(result).not.toContain('<script');
    });
  });

  describe('Safe Content Preservation', () => {
    it('allows safe span elements with class attributes', () => {
      const safe = '<span class="hljs-keyword">const</span>';
      const result = sanitizeHtml(safe);
      expect(result).toContain('<span');
      expect(result).toContain('hljs-keyword');
      expect(result).toContain('const');
    });

    it('allows nested span elements', () => {
      const safe = '<span class="outer"><span class="inner">text</span></span>';
      const result = sanitizeHtml(safe);
      expect(result).toContain('<span');
      expect(result).toContain('outer');
      expect(result).toContain('inner');
      expect(result).toContain('text');
    });

    it('allows pre and code elements', () => {
      const safe = '<pre><code class="language-js">console.log("hello")</code></pre>';
      const result = sanitizeHtml(safe);
      expect(result).toContain('<pre');
      expect(result).toContain('<code');
      expect(result).toContain('console.log');
    });

    it('allows div elements', () => {
      const safe = '<div class="wrapper">content</div>';
      const result = sanitizeHtml(safe);
      expect(result).toContain('<div');
      expect(result).toContain('wrapper');
      expect(result).toContain('content');
    });

    it('allows br elements', () => {
      const safe = 'line1<br>line2';
      const result = sanitizeHtml(safe);
      expect(result).toContain('<br');
      expect(result).toContain('line1');
      expect(result).toContain('line2');
    });

    it('preserves plain text content', () => {
      const safe = 'This is just plain text with <no> special meaning';
      const result = sanitizeHtml(safe);
      expect(result).toContain('This is just plain text');
    });
  });

  describe('Highlight.js Output Safety', () => {
    it('sanitizes typical highlight.js output', () => {
      const hljsOutput = `
        <span class="hljs-keyword">function</span> <span class="hljs-title">test</span>() {
          <span class="hljs-keyword">return</span> <span class="hljs-number">42</span>;
        }
      `;
      const result = sanitizeHtml(hljsOutput);
      expect(result).toContain('hljs-keyword');
      expect(result).toContain('function');
      expect(result).toContain('test');
      expect(result).toContain('42');
    });

    it('handles malicious code within syntax highlighting', () => {
      // Simulates someone trying to inject via code content that gets highlighted
      const maliciousCode = '<span class="hljs-string">"&lt;script&gt;alert(1)&lt;/script&gt;"</span>';
      const result = sanitizeHtml(maliciousCode);
      expect(result).not.toContain('<script>');
      expect(result).toContain('hljs-string');
    });
  });
});

describe('createSanitizedHtml', () => {
  it('returns object with __html property', () => {
    const result = createSanitizedHtml('<span>test</span>');
    expect(result).toHaveProperty('__html');
    expect(typeof result.__html).toBe('string');
  });

  it('sanitizes the HTML in __html property', () => {
    const result = createSanitizedHtml('<script>alert("XSS")</script><span>safe</span>');
    expect(result.__html).not.toContain('<script');
    expect(result.__html).toContain('safe');
  });
});

describe('escapeHtmlStrict', () => {
  it('escapes < and > characters', () => {
    const result = escapeHtmlStrict('<script>');
    expect(result).toBe('&lt;script&gt;');
  });

  it('escapes ampersands', () => {
    const result = escapeHtmlStrict('a & b');
    expect(result).toBe('a &amp; b');
  });

  it('escapes quotes', () => {
    const result = escapeHtmlStrict('"double" and \'single\'');
    expect(result).toContain('&quot;');
    expect(result).toContain('&#039;');
  });

  it('escapes backticks', () => {
    const result = escapeHtmlStrict('`template`');
    expect(result).toContain('&#x60;');
  });

  it('escapes forward slashes', () => {
    const result = escapeHtmlStrict('/path/to/file');
    expect(result).toContain('&#x2F;');
  });

  it('handles multiple special characters', () => {
    const input = '<script>alert("XSS" & \'more\')</script>';
    const result = escapeHtmlStrict(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).not.toContain('&"'); // raw ampersand followed by quote
  });
});
