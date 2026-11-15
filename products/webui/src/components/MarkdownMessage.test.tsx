/**
 * MarkdownMessage code blocks: syntax highlighting, a labelled copy action, and
 * decorative (hidden from assistive tech) line numbers when asked for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MarkdownMessage } from './MarkdownMessage';
import { ToastProvider, useToastContext } from '../lib/toast';

let capturedToasts: { title: string; description?: string }[] = [];
function ToastProbe(): null {
  capturedToasts = useToastContext().toasts;
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(element));
  return container;
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('MarkdownMessage', () => {
  test('a fenced code block renders its code and offers a copy action', () => {
    const el = render(<MarkdownMessage content={'```ts\nconst answer = 42;\n```'} />);
    expect(el.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    expect(el.querySelector('pre')?.textContent).toContain('const answer = 42;');
  });

  test('line numbers are rendered per line and hidden from assistive tech', () => {
    const el = render(<MarkdownMessage content={'```bash\nbun test\nbun run build\n```'} lineNumbers />);
    const numbers = [...el.querySelectorAll('pre [aria-hidden="true"]')].map((n) => n.textContent);
    expect(numbers).toEqual(['1', '2']);
    expect(el.querySelector('pre')?.textContent).toContain('bun run build');
  });

  test('a parent re-render with the same text keeps the code block node and sends nothing', () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (): Promise<Response> => { requests++; return new Response(null, { status: 503 }); }, { preconnect: originalFetch.preconnect });
    try {
      const content = '```\ndef square(value):\n    return value ** 2\n```';
      const el = render(<div><MarkdownMessage content={content} /></div>);
      const block = el.querySelector('.markdown-code-block');
      expect(el.querySelector('.markdown-code-label')?.textContent).toBe('python');
      for (let i = 0; i < 20; i++) flushSync(() => root.render(<div data-tick={i}><MarkdownMessage content={content} /></div>));
      expect(el.querySelector('.markdown-code-block')).toBe(block);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('without line numbers no hidden numbering spans exist', () => {
    const el = render(<MarkdownMessage content={'```bash\nbun test\n```'} lineNumbers={false} />);
    expect(el.querySelectorAll('pre [aria-hidden="true"]')).toHaveLength(0);
  });

  describe('copying code', () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    afterEach(() => {
      capturedToasts = [];
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });
    const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
    const renderCode = () => render(<ToastProvider><ToastProbe /><MarkdownMessage content={'```ts\nconst a = 1;\n```'} /></ToastProvider>);
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    test('a missing clipboard toasts and never shows Copied', async () => {
      setClipboard(undefined);
      const el = renderCode();
      flushSync(() => el.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click());
      await settle();
      expect(capturedToasts.some((t) => t.description === 'Clipboard API unavailable')).toBe(true);
      expect(el.querySelector('button[aria-label="Copied"]')).toBeNull();
    });

    test('a rejected write toasts and never shows Copied', async () => {
      setClipboard({ writeText: () => Promise.reject(new Error('denied')) });
      const el = renderCode();
      flushSync(() => el.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click());
      await settle();
      expect(capturedToasts.some((t) => t.description === 'Could not write to clipboard')).toBe(true);
      expect(el.querySelector('button[aria-label="Copied"]')).toBeNull();
    });

    test('a successful write shows Copied', async () => {
      const written: string[] = [];
      setClipboard({ writeText: (t: string) => { written.push(t); return Promise.resolve(); } });
      const el = renderCode();
      flushSync(() => el.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click());
      await settle();
      expect(written[0]).toContain('const a = 1;');
      expect(el.querySelector('button[aria-label="Copied"]')).not.toBeNull();
    });
  });
});
