// ============================================================================
// USE RESOLVED PROJECT NAME HOOK
// ============================================================================
//
// Resolves encoded project paths to display names via IPC.
// Uses the main process filesystem-aware resolver for accurate hyphen handling,
// falling back to the naive decoder during loading or on error.
//
// ============================================================================

import { useQuery } from '@tanstack/react-query';
import { decodeProjectName, formatProjectDisplayName } from '../../shared/utils';

/**
 * Hook that resolves an encoded project name to a display-friendly name
 * via the main process IPC resolver.
 *
 * Uses React Query for caching (staleTime: Infinity) since paths don't change
 * during the app's lifetime.
 *
 * @param encodedName - The encoded project name (e.g., "-home-buzzkill-Projects-goodvibes-sh")
 * @param projectsRoot - Optional projects root for relative path display
 * @returns The resolved display name, or a naive fallback while loading
 */
export function useResolvedProjectName(
  encodedName: string | null | undefined,
  projectsRoot?: string | null
): string {
  const { data: resolvedPath } = useQuery({
    queryKey: ['resolve-project-path', encodedName],
    queryFn: async () => {
      const result = await window.goodvibes.resolveProjectPath(encodedName!);
      return result?.path ?? null;
    },
    enabled: !!encodedName,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // If we have a resolved path from IPC, format it properly
  if (resolvedPath) {
    return formatProjectDisplayName(resolvedPath, projectsRoot);
  }

  // Fallback to naive decoder while loading or on error
  return decodeProjectName(encodedName, projectsRoot);
}
