// ============================================================================
// SAFE HIGHLIGHT XSS PREVENTION TESTS
// Verifies that XSS payloads are properly neutralized
// ============================================================================

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { parseHighlightedCode, splitHighlightedLines } from './SafeHighlight';

describe('SafeHighlight XSS Prevention', () => {
  describe('parseHighlightedCode', () => {
    it('renders plain text safely without executing scripts', () => {
      // XSS payload that should NOT execute
      const xssPayload = '<script>alert("XSS")</script>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // The script tags should be rendered as text, not executed
      expect(container.innerHTML).not.toContain('<script>');
      expect(container.textContent).toContain('<script>alert("XSS")</script>');
    });

    it('rejects malicious event handlers by not creating span elements', () => {
      // Attempt to inject onclick handler - spans with extra attributes don't match
      // the strict hljs pattern, so they become plain text
      const xssPayload = '<span class="hljs-keyword" onclick="alert(1)">const</span>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // No span elements should be created - malformed input is rejected entirely
      const span = container.querySelector('span');
      expect(span).toBeNull();
      // The text should be rendered as plain text
      expect(container.textContent).toContain('const');
    });

    it('rejects XSS in class attribute values by not creating span elements', () => {
      // Attempt to break out of class attribute - spans with extra attributes
      // don't match the strict hljs pattern
      const xssPayload = '<span class="hljs-keyword" onmouseover="alert(1)">test</span>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // No span elements should be created
      const span = container.querySelector('span');
      expect(span).toBeNull();
    });

    it('neutralizes javascript: URLs in content', () => {
      const xssPayload = 'javascript:alert(1)';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // Should render as plain text
      expect(container.textContent).toBe('javascript:alert(1)');
      expect(container.querySelector('a')).toBeNull();
    });

    it('handles nested script injection attempts', () => {
      const xssPayload = '<span class="hljs-string">"<script>alert(1)</script>"</span>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // Script should be rendered as text content, not executed
      expect(container.innerHTML).not.toContain('<script>');
      expect(container.textContent).toContain('<script>alert(1)</script>');
    });

    it('handles img onerror XSS', () => {
      const xssPayload = '<img src=x onerror=alert(1)>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // Should render as text, not as an img element
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('handles SVG-based XSS', () => {
      const xssPayload = '<svg onload=alert(1)>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // Should render as text, not as SVG
      expect(container.querySelector('svg')).toBeNull();
      expect(container.textContent).toContain('<svg onload=alert(1)>');
    });

    it('preserves legitimate hljs class names', () => {
      const legitimate =
        '<span class="hljs-keyword">const</span> <span class="hljs-variable">x</span>';
      const elements = parseHighlightedCode(legitimate);

      const { container } = render(<>{elements}</>);

      const spans = container.querySelectorAll('span');
      expect(spans).toHaveLength(2);
      expect(spans[0]?.className).toBe('hljs-keyword');
      expect(spans[0]?.textContent).toBe('const');
      expect(spans[1]?.className).toBe('hljs-variable');
      expect(spans[1]?.textContent).toBe('x');
    });

    it('decodes HTML entities safely', () => {
      const withEntities = '&lt;div&gt; &amp; &quot;test&quot;';
      const elements = parseHighlightedCode(withEntities);

      const { container } = render(<>{elements}</>);

      expect(container.textContent).toBe('<div> & "test"');
    });

    it('handles data: URI XSS attempts', () => {
      const xssPayload = 'data:text/html,<script>alert(1)</script>';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      // Should be plain text
      expect(container.textContent).toBe('data:text/html,<script>alert(1)</script>');
    });

    it('handles template literal XSS', () => {
      const xssPayload = '${alert(1)}';
      const elements = parseHighlightedCode(xssPayload);

      const { container } = render(<>{elements}</>);

      expect(container.textContent).toBe('${alert(1)}');
    });

    it('only allows hljs-* class names', () => {
      // Try to inject non-hljs class
      const malicious = '<span class="evil-class">test</span>';
      const elements = parseHighlightedCode(malicious);

      const { container } = render(<>{elements}</>);

      // evil-class should not be rendered as a span with that class
      const span = container.querySelector('.evil-class');
      expect(span).toBeNull();
      // Content should be rendered as text
      expect(container.textContent).toContain('test');
    });
  });

  describe('splitHighlightedLines', () => {
    it('splits multiline content safely', () => {
      const multiline = 'line1\nline2\nline3';
      const lines = splitHighlightedLines(multiline);

      expect(lines).toHaveLength(3);

      // Render each line and verify
      lines.forEach((lineElements, i) => {
        const { container } = render(<>{lineElements}</>);
        expect(container.textContent).toBe(`line${i + 1}`);
      });
    });

    it('handles XSS across line boundaries', () => {
      const xssPayload = '<script>\nalert(1)\n</script>';
      const lines = splitHighlightedLines(xssPayload);

      expect(lines).toHaveLength(3);

      // None of the lines should create actual script elements
      lines.forEach((lineElements) => {
        const { container } = render(<>{lineElements}</>);
        expect(container.querySelector('script')).toBeNull();
      });
    });

    it('preserves empty lines', () => {
      const withEmpty = 'line1\n\nline3';
      const lines = splitHighlightedLines(withEmpty);

      expect(lines).toHaveLength(3);
      // Empty line should have non-breaking space
      const { container } = render(<>{lines[1]}</>);
      expect(container.textContent).toBe('\u00A0');
    });
  });
});
