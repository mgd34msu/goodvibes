// ============================================================================
// MARKDOWN RENDERER - With syntax highlighting via rehype-highlight
// ============================================================================

import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { clsx } from 'clsx';

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: ({ inline, className, children, ...props }: any) => {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';

          if (inline) {
            return (
              <code
                className="px-1.5 py-0.5 bg-surface-700 rounded text-sm font-mono text-primary-300"
                {...props}
              >
                {children}
              </code>
            );
          }

          // For code blocks, wrap in a styled container with copy button
          return (
            <CodeBlockWrapper language={language || ''}>
              <code className={clsx('hljs', className)} {...props}>
                {children}
              </code>
            </CodeBlockWrapper>
          );
        },
        pre: ({ children }) => <>{children}</>,
        p: ({ children, node }) => {
          // Check if paragraph contains block-level elements (like code blocks)
          // If so, render as div to avoid invalid HTML nesting (<pre> cannot be inside <p>)
          const hasBlockChild = node?.children?.some(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (child: any) =>
              child.tagName === 'pre' ||
              child.tagName === 'div' ||
              child.tagName === 'table' ||
              child.tagName === 'blockquote' ||
              child.tagName === 'ul' ||
              child.tagName === 'ol'
          );
          if (hasBlockChild) {
            return <div className="mb-2 last:mb-0">{children}</div>;
          }
          return <p className="mb-2 last:mb-0">{children}</p>;
        },
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="text-surface-200">{children}</li>,
        h1: ({ children }) => <h1 className="text-xl font-bold mb-2 text-surface-100">{children}</h1>,
        h2: ({ children }) => <h2 className="text-lg font-bold mb-2 text-surface-100">{children}</h2>,
        h3: ({ children }) => <h3 className="text-base font-bold mb-2 text-surface-100">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-surface-600 pl-4 my-2 text-surface-300 italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-400 hover:text-primary-300 underline"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full border-collapse border border-surface-600">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-surface-600 px-3 py-2 bg-surface-700 text-left text-surface-200">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-surface-600 px-3 py-2 text-surface-300">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// Wrapper for code blocks with copy functionality
function CodeBlockWrapper({ language, children }: { language: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);

  const handleCopy = async () => {
    if (codeRef.current) {
      const text = codeRef.current.textContent || '';
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden bg-surface-950 border border-surface-700">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800 border-b border-surface-700">
        <span className="text-xs text-surface-400 font-mono">{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-surface-400 hover:text-surface-200 transition-colors flex items-center gap-1"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre ref={codeRef} className="p-3 overflow-x-auto text-sm">
        {children}
      </pre>
    </div>
  );
}
