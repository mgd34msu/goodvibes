import type { PermissionCategory } from '@goodvibes-jev/engine/platform/platform/permissions';
import { activeTokens } from './renderer/theme.js';
export function getPermissionCategoryLabel(category: PermissionCategory): {
  label: string;
  color: string;
} {
  const p = activeTokens();
  switch (category) {
    case 'write':
      return { label: 'WRITE', color: p.warning };
    case 'execute':
      return { label: 'EXECUTE', color: p.error };
    case 'delegate':
      return { label: 'DELEGATE', color: p.blocked };
    default:
      return { label: 'PERMISSION', color: p.textMuted };
  }
}
