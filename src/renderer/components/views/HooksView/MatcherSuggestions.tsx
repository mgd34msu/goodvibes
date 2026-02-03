// ============================================================================
// MATCHER SUGGESTIONS COMPONENT
// Context-sensitive matcher pattern suggestions based on hook event type
// ============================================================================

import { Info, Lightbulb } from 'lucide-react';
import { EVENT_TYPES, type HookEventType } from './types';

interface MatcherSuggestionsProps {
  eventType: HookEventType;
  onSelect: (pattern: string) => void;
  currentValue: string;
}

export function MatcherSuggestions({
  eventType,
  onSelect,
  currentValue,
}: MatcherSuggestionsProps) {
  const eventMetadata = EVENT_TYPES.find((e) => e.value === eventType);

  if (!eventMetadata) {
    return null;
  }

  // If this hook type doesn't support matchers, show info message
  if (!eventMetadata.supportsMatcher) {
    return (
      <div className="flex items-center gap-2 text-surface-500 text-xs italic">
        <Info className="w-3 h-3" />
        <span>This hook type doesn't use matchers</span>
      </div>
    );
  }

  // Build suggestions array with wildcard first
  const suggestions = ['*', ...eventMetadata.matcherExamples.filter((e) => e !== '*')];

  const isToolMatcher = eventMetadata.matcherType === 'tool';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <span className="text-surface-400 text-xs">Suggestions:</span>
        {suggestions.map((pattern) => {
          const isSelected = currentValue === pattern;
          return (
            <button
              key={pattern}
              type="button"
              onClick={() => onSelect(pattern)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                isSelected
                  ? 'bg-accent-purple/20 border border-accent-purple text-surface-200'
                  : 'bg-surface-700 hover:bg-surface-600 text-surface-300 border border-transparent'
              }`}
            >
              {pattern}
            </button>
          );
        })}
      </div>

      {isToolMatcher && (
        <div className="flex items-center gap-2 text-surface-400 text-xs">
          <Lightbulb className="w-3 h-3 text-yellow-500" />
          <span>
            For MCP tools, use pattern: <code className="text-accent-purple">mcp__&lt;server&gt;__&lt;tool&gt;</code>
          </span>
        </div>
      )}
    </div>
  );
}

export default MatcherSuggestions;
