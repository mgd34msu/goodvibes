// ============================================================================
// USE GIT UI HOOK - UI state management, section toggles, refs
// ============================================================================

import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { GitPanelState, ExpandedSections } from '../types';
import type { UseGitUIReturn } from './types';

/**
 * Hook for managing Git panel UI state
 */
export function useGitUI(
  state: GitPanelState,
  setState: Dispatch<SetStateAction<GitPanelState>>
): UseGitUIReturn {
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setState(prev => ({ ...prev, showBranchDropdown: false }));
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [setState]);

  // Toggle section expand/collapse
  const toggleSection = useCallback((section: keyof ExpandedSections) => {
    setState(prev => ({
      ...prev,
      expandedSections: {
        ...prev.expandedSections,
        [section]: !prev.expandedSections[section],
      },
    }));
  }, [setState]);

  // Total changes count
  const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;

  return {
    branchDropdownRef,
    toggleSection,
    totalChanges,
  };
}
