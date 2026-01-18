// ============================================================================
// IPC LISTENERS HOOK
// ============================================================================

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useQueryClient } from '@tanstack/react-query';
import type { ViewName } from '../../shared/constants';

export function useIpcListeners(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Collect cleanup functions from each listener
    const cleanups: (() => void)[] = [];

    // Menu commands - use store.getState() inside callbacks to always get current values
    cleanups.push(
      window.goodvibes.onNewSession(() => {
        useAppStore.getState().openFolderPicker();
      })
    );

    cleanups.push(
      window.goodvibes.onCloseTab(() => {
        const { activeTerminalId } = useTerminalStore.getState();
        if (activeTerminalId !== null) {
          useTerminalStore.getState().closeTerminal(activeTerminalId);
        }
      })
    );

    cleanups.push(
      window.goodvibes.onNextTab(() => {
        useTerminalStore.getState().switchToNextTab();
      })
    );

    cleanups.push(
      window.goodvibes.onPrevTab(() => {
        useTerminalStore.getState().switchToPrevTab();
      })
    );

    cleanups.push(
      window.goodvibes.onSwitchView((view: string) => {
        useAppStore.getState().setCurrentView(view as ViewName);
      })
    );

    cleanups.push(
      window.goodvibes.onOpenSettings(() => {
        useAppStore.getState().setCurrentView('settings');
      })
    );

    cleanups.push(
      window.goodvibes.onShowAbout(() => {
        useAppStore.getState().openModal('about');
      })
    );

    // Terminal events
    cleanups.push(
      window.goodvibes.onTerminalExit((data: { id: number; exitCode: number }) => {
        // Remove the terminal from the store when it exits
        // This prevents memory leaks from zombie terminal entries
        useTerminalStore.getState().removeTerminal(data.id);
      })
    );

    // Session events
    cleanups.push(
      window.goodvibes.onSessionDetected(() => {
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
      })
    );

    cleanups.push(
      window.goodvibes.onSubagentSessionUpdate(() => {
        queryClient.invalidateQueries({ queryKey: ['live-sessions'] });
      })
    );

    // Cleanup all listeners on unmount
    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [queryClient]);
}
