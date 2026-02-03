// ============================================================================
// SHARED UTILITIES - Used by both main and renderer processes
// ============================================================================

// Common file extensions that should be converted to dotted format
const COMMON_EXTENSIONS = ['sh', 'ts', 'js', 'py', 'rs', 'go', 'md', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'io', 'ai', 'co'] as const;

/**
 * Apply extension logic to convert folder names like "goodvibes-sh" to "goodvibes.sh"
 * @param pathStr - The path string to process
 * @returns The path with extension logic applied
 */
function applyExtensionLogic(pathStr: string): string {
  const pathParts = pathStr.split('/');
  const lastPart = pathParts[pathParts.length - 1];
  
  if (lastPart && (COMMON_EXTENSIONS as readonly string[]).includes(lastPart) && pathParts.length >= 2) {
    const secondToLast = pathParts[pathParts.length - 2];
    pathParts[pathParts.length - 2] = secondToLast + '.' + lastPart;
    pathParts.pop();
    return pathParts.join('/');
  }
  return pathStr;
}

/**
 * Decode project name from path-encoded format
 *
 * @param name - The encoded project name (e.g., "C--Users-buzzkill-Documents-myproject" or "-home-buzzkill-Projects-myproject")
 * @param projectsRoot - Optional projects root path to compute relative paths
 * @returns The decoded project name with smart home directory handling
 *
 * Examples:
 * Windows:
 * - decodeProjectName("C--Users-buzzkill-Documents-goodvibes") => "goodvibes"
 * - decodeProjectName("C--Users-buzzkill") => "~"
 *
 * Linux:
 * - decodeProjectName("-home-buzzkill-Projects-goodvibes-sh") => "goodvibes.sh"
 * - decodeProjectName("-home-buzzkill") => "~"
 */
export function decodeProjectName(name: string | null | undefined, projectsRoot?: string | null): string {
  if (!name) return 'Unknown';

  // Get home directory for replacement (cross-platform)
  const homeDir = typeof process !== 'undefined' && process.env?.HOME
    ? process.env.HOME
    : typeof process !== 'undefined' && process.env?.USERPROFILE
    ? process.env.USERPROFILE
    : null;

  // Handle Linux-style dash-separated paths (e.g., "-home-buzzkill-Projects-myproject")
  if (name.startsWith('-')) {
    // Parse the encoded path: split by dash and rebuild full path
    const parts = name.substring(1).split('-').filter(Boolean); // Remove leading dash and split
    const fullPath = '/' + parts.join('/');

    // Check if this is the home directory itself
    if (homeDir && fullPath === homeDir) {
      return '~';
    }

    // If projectsRoot is provided, compute relative path
    if (projectsRoot) {
      const normalizedRoot = projectsRoot.replace(/\\/g, '/').replace(/\/$/, '');
      if (fullPath.startsWith(normalizedRoot + '/')) {
        const relativePath = fullPath.substring(normalizedRoot.length + 1);
        const processedPath = applyExtensionLogic(relativePath);
        
        // BUGFIX: The encoded path loses information about hyphens in folder names.
        // When split by dashes, "goodvibes-plugin" becomes "goodvibes/plugin".
        // We need to distinguish between:
        // 1. Single folder with hyphens (e.g., "goodvibes-plugin" -> "goodvibes/plugin")
        // 2. Nested folders (e.g., "apps/myapp.ts" stays as-is)
        //
        // Heuristic: If the path has slashes and matches these conditions, join with hyphens:
        // - Only 2 path components (likely a single folder name with one hyphen)
        // - Last part is NOT a known file extension (not part of extension logic)
        if (processedPath.includes('/')) {
          const parts = processedPath.split('/');
          const lastPart = parts[parts.length - 1];
          
          // If it's a simple two-part path and the last part is not a known extension,
          // it's likely a folder name with a hyphen that was incorrectly split
          if (parts.length === 2 && !(COMMON_EXTENSIONS as readonly string[]).includes(lastPart)) {
            return processedPath.replace(/\//g, '-');
          }
        }
        
        return processedPath || parts[parts.length - 1] || name;
      }
    }

    // Handle encoded dots in folder names (e.g., "goodvibes-sh" -> "goodvibes.sh")
    const lastPart = parts[parts.length - 1];
    if (lastPart && (COMMON_EXTENSIONS as readonly string[]).includes(lastPart) && parts.length >= 2) {
      const secondToLast = parts[parts.length - 2];
      return secondToLast + '.' + lastPart;
    }

    // Return just the last part (folder name)
    return parts[parts.length - 1] || name;
  }

  // Handle Windows-style dash-separated paths (e.g., "C--Users-name-project")
  // Format: "C--Users-buzzkill-Documents-myproject" (-- after drive, - between dirs)
  if (name.includes('--') || name.match(/^[A-Z]-/)) {
    // Parse the encoded path into parts
    const mainParts = name.split('--');
    const pathParts: string[] = [];

    mainParts.forEach((part, idx) => {
      if (idx === 0) {
        // First part is the drive letter (e.g., "C")
        pathParts.push(part);
      } else {
        // Subsequent parts are dash-separated directories
        part.split('-').forEach(sp => {
          if (sp) pathParts.push(sp);
        });
      }
    });

    // Reconstruct full path to check if it's home directory
    const fullPath = pathParts[0] + ':/' + pathParts.slice(1).join('/');

    // Check if this is the home directory itself
    if (homeDir && fullPath.replace(/\\/g, '/') === homeDir.replace(/\\/g, '/')) {
      return '~';
    }

    // If projectsRoot is provided, compute relative path
    if (projectsRoot) {
      const rootParts = projectsRoot
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(p => p.replace(':', '').toLowerCase());

      const encodedLower = pathParts.map(p => p.toLowerCase());

      // Find where root ends in the encoded path
      let matchEnd = 0;
      for (let i = 0; i < rootParts.length; i++) {
        for (let j = matchEnd; j < encodedLower.length; j++) {
          if (encodedLower[j] === rootParts[i]) {
            matchEnd = j + 1;
            break;
          }
        }
      }

      // Return relative path from projects root
      if (matchEnd > 0 && matchEnd < pathParts.length) {
        const relativePath = pathParts.slice(matchEnd).join('/');
        return applyExtensionLogic(relativePath);
      }
    }

    // Fallback: return just the last part (project folder name)
    return pathParts[pathParts.length - 1] || name;
  }

  return name;
}

/**
 * Format duration in seconds to human-readable string
 * @param seconds - The duration in seconds to format
 * @returns Formatted duration string (e.g., "42s", "2:30", "1:23:45")
 * @example
 * formatDuration(45) // => "45s"
 * formatDuration(90) // => "1:30"
 * formatDuration(3661) // => "1:01:01"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format large numbers with comma separators for thousands, then M/B/T suffixes for larger numbers
 * @param num - The number to format (nullable)
 * @returns Formatted number string with thousands separators or M/B/T suffix
 * @example
 * formatNumber(999) // => "999"
 * formatNumber(1000) // => "1,000"
 * formatNumber(999999) // => "999,999"
 * formatNumber(1000000) // => "1.00M"
 * formatNumber(1500000000) // => "1.50B"
 * formatNumber(2500000000000) // => "2.50T"
 */
export function formatNumber(num: number | null | undefined): string {
  if (num == null || isNaN(num)) return '0';

  if (num >= 1_000_000_000_000) {
    return `${(num / 1_000_000_000_000).toFixed(2)}T`;
  }

  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(2)}B`;
  }

  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }

  // For numbers under 1 million, use locale string with commas
  return num.toLocaleString();
}

/**
 * Format cost with 2 decimal places and thousands separators
 * @param cost - The cost amount in USD to format (nullable)
 * @returns Formatted cost string in USD currency format
 * @example
 * formatCost(0) // => "$0.00"
 * formatCost(0.001) // => "$0.00"
 * formatCost(0.015) // => "$0.02"
 * formatCost(1.5) // => "$1.50"
 * formatCost(1234.56) // => "$1,234.56"
 * formatCost(1234567.89) // => "$1,234,567.89"
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || isNaN(cost)) return '$0.00';

  // Use Intl.NumberFormat for locale-aware formatting with thousands separators
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cost);
}

/**
 * Format date for display in locale-aware short format
 * @param dateStr - ISO date string or null/undefined
 * @returns Formatted date string (e.g., "Jan 15, 2024") or "Unknown" if invalid
 * @example
 * formatDate("2024-01-15T10:30:00Z") // => "Jan 15, 2024"
 */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown';

  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Invalid date';
  }
}

/**
 * Format date and time for display in locale-aware format
 * @param dateStr - ISO date string or null/undefined
 * @returns Formatted date and time string (e.g., "Jan 15, 2024, 10:30 AM") or "Unknown" if invalid
 * @example
 * formatDateTime("2024-01-15T10:30:00Z") // => "Jan 15, 2024, 10:30 AM"
 */
export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown';

  try {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Invalid date';
  }
}

/**
 * Format relative time from now (e.g., "2 hours ago")
 * @param dateStr - ISO date string or null/undefined
 * @returns Human-readable relative time string or "Unknown" if invalid
 * @example
 * formatRelativeTime("2024-01-15T10:00:00Z") // => "2 hours ago" (if current time is 12:00)
 * formatRelativeTime("2024-01-10T10:00:00Z") // => "5 days ago"
 */
export function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Unknown';

  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) {
      return 'just now';
    }

    if (diffMins < 60) {
      return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    }

    if (diffHours < 24) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    }

    if (diffDays < 7) {
      return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    }

    return formatDate(dateStr);
  } catch {
    return 'Invalid date';
  }
}

/**
 * Decode project name from path-encoded format back to full path
 *
 * @param name - The encoded project name (e.g., "C--Users-buzzkill-Documents-myproject" or "-home-buzzkill-Projects-myproject")
 * @returns The decoded full path (e.g., "C:/Users/buzzkill/Documents/myproject" or "/home/buzzkill/Projects/myproject")
 *
 * Examples:
 * - decodeProjectPath("C--Users-buzzkill-Documents-goodvibes") => "C:/Users/buzzkill/Documents/goodvibes"
 * - decodeProjectPath("-home-user-projects-myapp") => "/home/user/projects/myapp"
 * - decodeProjectPath("home-user-projects-myapp") => "/home/user/projects/myapp"
 */
export function decodeProjectPath(name: string | null | undefined): string | null {
  if (!name) return null;

  // Handle Linux-style dash-separated paths with leading dash (e.g., "-home-buzzkill-Projects-myproject")
  if (name.startsWith('-home-') || name.startsWith('-Users-')) {
    // Parse the encoded path: split by dash and rebuild full path
    const parts = name.substring(1).split('-').filter(Boolean); // Remove leading dash and split
    return '/' + parts.join('/');
  }

  // Handle dash-separated path encoding (e.g., "C--Users-name-project")
  // Format: "C--Users-buzzkill-Documents-myproject" (-- after drive, - between dirs)
  if (name.includes('--') || name.match(/^[A-Z]-/)) {
    // Parse the encoded path into parts
    const mainParts = name.split('--');
    const pathParts: string[] = [];

    mainParts.forEach((part, idx) => {
      if (idx === 0) {
        // First part is the drive letter (e.g., "C")
        pathParts.push(part + ':');
      } else {
        // Subsequent parts are dash-separated directories
        part.split('-').forEach(sp => {
          if (sp) pathParts.push(sp);
        });
      }
    });

    // Return full path (using forward slashes for cross-platform compatibility)
    return pathParts.join('/');
  }

  // Unix-style paths without leading dash (e.g., "home-user-projects")
  if (name.match(/^home-/) || name.match(/^Users-/)) {
    const parts = name.split('-');
    return '/' + parts.join('/');
  }

  return null;
}
