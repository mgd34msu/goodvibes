// ============================================================================
// OUTPUT DECISION HELP COMPONENT
// Displays available decisions and output schema for a selected hook event type
// ============================================================================

import { EVENT_TYPES, type HookEventType } from './types';
import { CollapsibleSection } from './CollapsibleSection';
import { Settings2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

// ============================================================================
// TYPES
// ============================================================================

interface OutputDecisionHelpProps {
  eventType: HookEventType;
}

// ============================================================================
// DECISION BADGE STYLING
// ============================================================================

const DECISION_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  allow: {
    bg: 'bg-green-500/10',
    text: 'text-green-400',
    border: 'border-green-500/30',
  },
  deny: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    border: 'border-red-500/30',
  },
  ask: {
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-400',
    border: 'border-yellow-500/30',
  },
  block: {
    bg: 'bg-orange-500/10',
    text: 'text-orange-400',
    border: 'border-orange-500/30',
  },
};

const DECISION_DESCRIPTIONS: Record<string, string> = {
  allow: 'Bypass permission system',
  deny: 'Prevent operation',
  ask: 'Show user confirmation dialog',
  block: 'Block with feedback to Claude',
};

// ============================================================================
// SAFE JSON SYNTAX HIGHLIGHTING
// React-based JSON rendering without dangerouslySetInnerHTML
// ============================================================================

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface JsonTokenProps {
  value: JsonValue;
  indent?: number;
}

function JsonToken({ value, indent = 0 }: JsonTokenProps) {
  const indentStr = '  '.repeat(indent);

  if (value === null) {
    return <span className="text-surface-500">null</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-amber-400">{value.toString()}</span>;
  }

  if (typeof value === 'number') {
    return <span className="text-info-400">{value}</span>;
  }

  if (typeof value === 'string') {
    return <span className="text-green-400">"{value}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span>{'[]'}</span>;
    }
    return (
      <>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {indentStr}{'  '}
            <JsonToken value={item as JsonValue} indent={indent + 1} />
            {i < value.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {indentStr}{']'}
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <span>{'{}'}</span>;
    }
    return (
      <>
        {'{\n'}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {indentStr}{'  '}
            <span className="text-purple-400">"{key}"</span>
            {': '}
            <JsonToken value={val as JsonValue} indent={indent + 1} />
            {i < entries.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {indentStr}{'}'}
      </>
    );
  }

  return <span>{String(value)}</span>;
}

function SafeJsonHighlight({ data }: { data: Record<string, unknown> }) {
  return (
    <code className="text-xs font-mono text-surface-200">
      <JsonToken value={data as JsonValue} />
    </code>
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

export function OutputDecisionHelp({ eventType }: OutputDecisionHelpProps): React.JSX.Element | null {
  const eventMetadata = EVENT_TYPES.find((e) => e.value === eventType);

  if (!eventMetadata) {
    return null;
  }

  const { canBlock, exitCode2Behavior, availableDecisions, outputSchemaExample } = eventMetadata;

  return (
    <CollapsibleSection
      title="Output & Decision Control"
      icon={<Settings2 className="w-4 h-4" />}
    >
      <div className="space-y-4">
        {/* Exit Code Behavior */}
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
            Exit Codes
          </h4>
          <div className="bg-surface-900 rounded-md border border-surface-700 overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                <tr className="border-b border-surface-700">
                  <td className="px-3 py-2 font-mono text-green-400 w-16">0</td>
                  <td className="px-3 py-2 text-surface-300">
                    Success, stdout processed
                  </td>
                </tr>
                <tr className="border-b border-surface-700">
                  <td className="px-3 py-2 font-mono text-yellow-400 w-16">2</td>
                  <td className="px-3 py-2 text-surface-300">
                    {exitCode2Behavior}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono text-surface-500 w-16">Other</td>
                  <td className="px-3 py-2 text-surface-300">
                    Non-blocking error, stderr shown in verbose mode
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Can Block Indicator */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-surface-400 uppercase tracking-wider">
            Blocking:
          </span>
          {canBlock ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/30">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Can Block
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-surface-700 text-surface-400 border border-surface-600">
              <AlertCircle className="w-3 h-3" />
              Cannot Block
            </span>
          )}
        </div>

        {/* Available Decisions */}
        {availableDecisions && availableDecisions.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              Available Decisions
            </h4>
            <div className="flex flex-wrap gap-2">
              {availableDecisions.map((decision) => {
                const style = DECISION_STYLES[decision] || {
                  bg: 'bg-surface-700',
                  text: 'text-surface-300',
                  border: 'border-surface-600',
                };
                const description = DECISION_DESCRIPTIONS[decision];

                return (
                  <div
                    key={decision}
                    className={clsx(
                      'px-2.5 py-1.5 rounded-md border text-xs',
                      style.bg,
                      style.text,
                      style.border
                    )}
                  >
                    <span className="font-mono font-semibold">{decision}</span>
                    {description && (
                      <span className="text-surface-400 ml-1.5">- {description}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Output Schema Example */}
        {outputSchemaExample && (
          <div>
            <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              Output Schema Example
            </h4>
            <div className="rounded-lg overflow-hidden bg-surface-950 border border-surface-700">
              <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800 border-b border-surface-700">
                <span className="text-xs text-surface-400 font-mono">json</span>
              </div>
              <div className="overflow-x-auto">
                <pre className="p-3">
                  <SafeJsonHighlight data={outputSchemaExample} />
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* No output schema message */}
        {!outputSchemaExample && !availableDecisions && (
          <div className="flex items-center gap-2 text-xs text-surface-500 italic">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>This event type does not support structured output or decisions.</span>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default OutputDecisionHelp;
