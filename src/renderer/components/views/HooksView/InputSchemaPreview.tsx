// ============================================================================
// INPUT SCHEMA PREVIEW COMPONENT
// Displays the expected JSON input schema for a selected hook event type
// ============================================================================

import { useMemo } from 'react';
import { FileJson } from 'lucide-react';
import { EVENT_TYPES, type HookEventType } from './types';
import { CollapsibleSection } from './CollapsibleSection';

// ============================================================================
// TYPES
// ============================================================================

interface InputSchemaPreviewProps {
  eventType: HookEventType;
}

// ============================================================================
// JSON SYNTAX HIGHLIGHTING
// ============================================================================

interface HighlightedLine {
  lineNumber: number;
  content: React.ReactNode;
}

/**
 * Tokenizes and highlights a JSON string with syntax coloring
 */
function highlightJson(json: string): HighlightedLine[] {
  const lines = json.split('\n');

  return lines.map((line, index) => ({
    lineNumber: index + 1,
    content: highlightLine(line),
  }));
}

/**
 * Highlights a single line of JSON
 */
function highlightLine(line: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  let remaining = line;
  let keyIndex = 0;

  while (remaining.length > 0) {
    // Match leading whitespace
    const whitespaceMatch = remaining.match(/^(\s+)/);
    if (whitespaceMatch && whitespaceMatch[1]) {
      tokens.push(whitespaceMatch[1]);
      remaining = remaining.slice(whitespaceMatch[1].length);
      continue;
    }

    // Match JSON key (quoted string followed by colon)
    const keyMatch = remaining.match(/^("(?:[^"\\]|\\.)*")(\s*:)/);
    if (keyMatch && keyMatch[1] && keyMatch[2]) {
      tokens.push(
        <span key={`key-${keyIndex++}`} className="text-cyan-400">
          {keyMatch[1]}
        </span>
      );
      tokens.push(keyMatch[2]);
      remaining = remaining.slice(keyMatch[0].length);
      continue;
    }

    // Match string value
    const stringMatch = remaining.match(/^("(?:[^"\\]|\\.)*")/);
    if (stringMatch && stringMatch[1]) {
      tokens.push(
        <span key={`str-${keyIndex++}`} className="text-green-400">
          {stringMatch[1]}
        </span>
      );
      remaining = remaining.slice(stringMatch[1].length);
      continue;
    }

    // Match number
    const numberMatch = remaining.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (numberMatch && numberMatch[1]) {
      tokens.push(
        <span key={`num-${keyIndex++}`} className="text-orange-400">
          {numberMatch[1]}
        </span>
      );
      remaining = remaining.slice(numberMatch[1].length);
      continue;
    }

    // Match boolean
    const boolMatch = remaining.match(/^(true|false)/);
    if (boolMatch && boolMatch[1]) {
      tokens.push(
        <span key={`bool-${keyIndex++}`} className="text-purple-400">
          {boolMatch[1]}
        </span>
      );
      remaining = remaining.slice(boolMatch[1].length);
      continue;
    }

    // Match null
    const nullMatch = remaining.match(/^(null)/);
    if (nullMatch && nullMatch[1]) {
      tokens.push(
        <span key={`null-${keyIndex++}`} className="text-gray-500">
          {nullMatch[1]}
        </span>
      );
      remaining = remaining.slice(nullMatch[1].length);
      continue;
    }

    // Match structural characters and punctuation
    const structMatch = remaining.match(/^([{}\[\],])/);
    if (structMatch && structMatch[1]) {
      tokens.push(
        <span key={`struct-${keyIndex++}`} className="text-surface-400">
          {structMatch[1]}
        </span>
      );
      remaining = remaining.slice(structMatch[1].length);
      continue;
    }

    // Fallback: take one character
    tokens.push(remaining[0]);
    remaining = remaining.slice(1);
  }

  return <>{tokens}</>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InputSchemaPreview({ eventType }: InputSchemaPreviewProps): React.JSX.Element | null {
  const eventMetadata = useMemo(
    () => EVENT_TYPES.find((e) => e.value === eventType),
    [eventType]
  );

  const formattedJson = useMemo(() => {
    if (!eventMetadata?.inputSchemaExample) return '';
    return JSON.stringify(eventMetadata.inputSchemaExample, null, 2);
  }, [eventMetadata]);

  const highlightedLines = useMemo(
    () => highlightJson(formattedJson),
    [formattedJson]
  );

  if (!eventMetadata) {
    return null;
  }

  const lineNumberWidth = String(highlightedLines.length).length;

  return (
    <CollapsibleSection
      title="Input Schema"
      icon={<FileJson className="w-4 h-4" />}
      defaultExpanded={false}
    >
      <div className="space-y-3">
        {/* Common fields note */}
        <p className="text-xs text-surface-400">
          All hooks receive these common fields plus event-specific data
        </p>

        {/* JSON code block */}
        <div className="bg-surface-950 rounded p-3 overflow-x-auto">
          <pre className="font-mono text-xs leading-relaxed">
            {highlightedLines.map(({ lineNumber, content }) => (
              <div key={lineNumber} className="flex">
                {/* Line number */}
                <span
                  className="text-surface-600 select-none pr-4 text-right"
                  style={{ minWidth: `${lineNumberWidth + 2}ch` }}
                >
                  {lineNumber}
                </span>
                {/* Code content */}
                <code className="flex-1">{content}</code>
              </div>
            ))}
          </pre>
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default InputSchemaPreview;
