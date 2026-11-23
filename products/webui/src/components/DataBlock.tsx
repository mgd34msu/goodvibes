import { useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { compactJson } from '../lib/object';
import { copyOutcomeMessage, copyText } from '../lib/copy-text';
import { MarkdownMessage } from './MarkdownMessage';
import { Button } from './ui/Button';
import { CodeFrame, DetailSection } from './data-view/DataView';
import { useOptionalToast } from '../lib/toast';
import '../styles/components/feedback.css';

interface DataBlockProps {
  title: string;
  value: unknown;
  empty?: string;
}

/** Copy button for the JSON <pre> branch; `showing` is the element that shows the text. */
function DataBlockCopyButton({ text, showing }: { text: string; showing: () => Element | null }) {
  const [copied, setCopied] = useState(false);
  const toastCtx = useOptionalToast();

  function handleCopy(): void {
    void copyText(text, showing()).then((outcome) => {
      const message = copyOutcomeMessage(outcome);
      if (message) {
        toastCtx?.toast({ title: outcome === 'selected' ? 'Selected' : 'Copy failed', description: message, tone: outcome === 'selected' ? 'info' : 'danger', durationMs: 6000 });
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    });
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="feedback-data-block__copy"
      onClick={handleCopy}
      title="Copy"
      aria-label="Copy value"
      icon={copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function DataBlock({ title, value, empty = 'No data' }: DataBlockProps) {
  const hasValue = value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  const codeRef = useRef<HTMLDivElement>(null);

  return (
    <DetailSection title={title}>
      {hasValue
        ? typeof value === 'string'
          ? <div className="feedback-data-block__markdown"><MarkdownMessage content={value} /></div>
          : (
            <div className="feedback-data-block__code" ref={codeRef}>
              <DataBlockCopyButton text={compactJson(value)} showing={() => codeRef.current?.querySelector('pre') ?? null} />
              <CodeFrame>{compactJson(value)}</CodeFrame>
            </div>
          )
        : <p className="feedback-data-block__empty">{empty}</p>}
    </DetailSection>
  );
}
