// ============================================================================
// COMMAND FILTERS COMPONENT
// ============================================================================

import { Search } from 'lucide-react';

interface CommandFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  showBuiltIn: boolean;
  onToggleBuiltIn: () => void;
}

export function CommandFilters({
  searchQuery,
  onSearchChange,
  showBuiltIn,
  onToggleBuiltIn,
}: CommandFiltersProps) {
  return (
    <div className="flex gap-4 mt-4">
      <div className="flex-1 relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search commands..."
          className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>
      <button
        onClick={onToggleBuiltIn}
        className={`px-3 py-2 text-sm rounded-lg transition-colors ${
          showBuiltIn
            ? 'bg-surface-700 text-surface-200'
            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
        }`}
      >
        {showBuiltIn ? 'Hide Built-in' : 'Show Built-in'}
      </button>
    </div>
  );
}
