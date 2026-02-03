// ============================================================================
// SCAN STATUS HOOK
// ============================================================================

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

export function useScanStatus(): void {
  const setLoading = useAppStore((s) => s.setLoading);

  useEffect(() => {
    const handleScanStatus = (data: { status: string; message?: string; progress?: { current: number; total: number } }) => {
      if (data.status === 'scanning') {
        setLoading(true, data.message || 'Scanning sessions...', data.progress);
      } else {
        setLoading(false);
      }
    };

    // onScanStatus returns a cleanup function
    const cleanup = window.goodvibes.onScanStatus(handleScanStatus);

    return cleanup;
  }, [setLoading]);
}
