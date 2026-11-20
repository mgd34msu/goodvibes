import { createContext, isValidElement, memo, ReactNode, useContext, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { highlightCode, normalizeLanguage } from '../lib/highlight';
import { useWebUiPreferences } from '../lib/ui-preferences';
import { useOptionalToast } from '../lib/toast';
import { IconButton } from './ui/IconButton';
import '../styles/components/markdown.css';

function codeElementFromChildren(children: ReactNode) {
  const child = Array.isArray(children) ? children[0] : children;
  return isValidElement<{ className?: string; children?: ReactNode }>(child) ? child : null;
}

function languageFromCodeChild(children: ReactNode): string {
  const child = codeElementFromChildren(children);
  if (!child) return '';
  const className = child.props.className ?? '';
  const match = /language-([\w-]+)/.exec(className);
  return match?.[1] ?? '';
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return '';
}

function codeTextFromChildren(children: ReactNode): string {
  const child = codeElementFromChildren(children);
  return textFromReactNode(child?.props.children ?? children);
}

// Code blocks read the line-number preference from here, so the renderer map below can be
// one module-level object: a new map on every render would be a new component type, and
// React would unmount and rebuild every code block on each keystroke or streamed token.
const LineNumbersContext = createContext(false);
// True inside a reply still being streamed: its code changes on every token, so an
// untagged block is not run through language detection (every grammar, every token)
// until the finished reply renders.
const LiveContext = createContext(false);

function CodeBlock({ children }: { children: ReactNode }) {
  const lineNumbers = useContext(LineNumbersContext);
  const live = useContext(LiveContext);
  const [copied, setCopied] = useState(false);
  const toastCtx = useOptionalToast();
  const language = languageFromCodeChild(children);
  const code = codeTextFromChildren(children);
  const visibleCode = code.endsWith('\n') ? code.slice(0, -1) : code;
  const highlighted = useMemo(() => highlightCode(visibleCode, language, { autoDetect: !live }), [visibleCode, language, live]);
  const highlightedLines = highlighted.html.split('\n');
  const displayLanguage = language || highlighted.language;

  async function copyCode() {
    if (!code) return;
    if (!navigator.clipboard) {
      toastCtx?.toast({ title: 'Copy failed', description: 'Clipboard API unavailable', tone: 'danger', durationMs: 3000 });
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      toastCtx?.toast({ title: 'Copy failed', description: 'Could not write to clipboard', tone: 'danger', durationMs: 3000 });
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  return (
    <div className={lineNumbers ? 'markdown-code-block numbered' : 'markdown-code-block'}>
      <div className="markdown-code-header">
        <div className="markdown-code-label">{displayLanguage || 'code'}</div>
        <IconButton
          className="markdown-code-copy"
          size="sm"
          label={copied ? 'Copied' : 'Copy code'}
          icon={copied ? <Check /> : <Copy />}
          tooltipPlacement="top"
          onClick={() => void copyCode()}
        />
      </div>
      {lineNumbers ? (
        <pre className="markdown-code-pre">
          <code>
            {highlightedLines.map((line, index) => (
              <span className="markdown-code-line" key={`${index}-${line}`}>
                <span className="markdown-code-line-number" aria-hidden="true">{index + 1}</span>
                <span
                  className="markdown-code-line-content"
                  dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
                />
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre className="markdown-code-pre">
          <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        </pre>
      )}
    </div>
  );
}

/**
 * The image a message may show inline: a `data:` or `blob:` image, or an
 * artifact this daemon serves (same origin, under /api/artifacts/). Any other
 * image URL in model or data-block text is never fetched on render: it would
 * send a request (and whatever its URL carries) to a server the text chose.
 */
function inlineImageSource(src: unknown): string | null {
  if (typeof src !== 'string' || src.trim() === '') return null;
  const value = src.trim();
  if (/^data:image\//i.test(value) || /^blob:/i.test(value)) return value;
  try {
    const url = new URL(value, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/artifacts/')) return url.toString();
  } catch {
    return null;
  }
  return null;
}

function MarkdownImage({ src, alt, title }: { src?: string | undefined; alt?: string | undefined; title?: string | undefined }) {
  const inline = inlineImageSource(src);
  if (inline) return <img src={inline} alt={alt ?? ''} title={title} loading="lazy" />;
  if (typeof src !== 'string' || src.trim() === '') return <>{alt ?? ''}</>;
  // A remote image is a link the person can choose to open, never an automatic request.
  return (
    <a href={src} target="_blank" rel="noreferrer noopener" title={src}>
      {alt ? `Image: ${alt}` : 'Image link'}
    </a>
  );
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const COMPONENTS: Components = {
  img: ({ src, alt, title }) => (
    <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />
  ),
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

interface MarkdownMessageProps {
  content: string;
  lineNumbers?: boolean;
  /** The text is a reply still being streamed (see LiveContext). */
  live?: boolean;
}

/** Re-renders only when its text or line-number setting changes; a parent's keystroke or token does not re-parse it. */
export const MarkdownMessage = memo(function MarkdownMessage({ content, lineNumbers, live = false }: MarkdownMessageProps) {
  const [preferences] = useWebUiPreferences();
  const showLineNumbers = lineNumbers ?? preferences.codeBlockLineNumbers;

  return (
    <div className="markdown-message">
      <LineNumbersContext.Provider value={showLineNumbers}>
        <LiveContext.Provider value={live}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
            {content}
          </ReactMarkdown>
        </LiveContext.Provider>
      </LineNumbersContext.Provider>
    </div>
  );
});
