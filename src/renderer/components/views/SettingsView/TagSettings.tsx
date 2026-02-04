// ============================================================================
// TAG SETTINGS SECTION
// ============================================================================

import { useState, useEffect } from 'react';
import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow, ToggleSwitch } from './components';
import { ScanProgressModal } from '../../overlays/ScanProgressModal';

interface TagSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function TagSettings({ settings, onChange }: TagSettingsProps): React.JSX.Element {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [isLoadingCount, setIsLoadingCount] = useState(true);

  // Fetch pending session count on mount
  useEffect(() => {
    const fetchPendingCount = async () => {
      try {
        setIsLoadingCount(true);
        const result = await window.goodvibes.getScanCounts();
        if (result.success) {
          setPendingCount(result.data.pending);
        } else {
          console.error('Failed to fetch pending session count:', result.error);
          setPendingCount(0);
        }
      } catch (error) {
        console.error('Failed to fetch pending session count:', error);
        setPendingCount(0);
      } finally {
        setIsLoadingCount(false);
      }
    };

    void fetchPendingCount();
  }, []);

  const handleScanAll = () => {
    setIsScanModalOpen(true);
  };

  const handleScanComplete = () => {
    setIsScanModalOpen(false);
    // Refresh pending count after scan completes
    void (async () => {
      try {
        const result = await window.goodvibes.getScanCounts();
        if (result.success) {
          setPendingCount(result.data.pending);
        } else {
          console.error('Failed to refresh pending count:', result.error);
        }
      } catch (error) {
        console.error('Failed to refresh pending count:', error);
      }
    })();
  };

  const handleScanCancel = async () => {
    try {
      await window.goodvibes.stopBackgroundScan();
    } catch (error) {
      console.error('Failed to cancel scan:', error);
    }
    setIsScanModalOpen(false);
  };

  return (
    <>
      <SettingsSection title="Display">
        <SettingRow
          label="Show Tags in Session List"
          description="Display tags inline with session titles"
        >
          <ToggleSwitch
            checked={settings.showTagsInSessionList}
            onChange={(value) => onChange('showTagsInSessionList', value)}
          />
        </SettingRow>

        <SettingRow
          label="Max Visible Tags"
          description="Maximum number of tags to show per session"
        >
          <select
            value={settings.maxVisibleTagsInList}
            onChange={(e) => onChange('maxVisibleTagsInList', parseInt(e.target.value, 10))}
            className="select w-24"
            disabled={!settings.showTagsInSessionList}
            aria-label="Maximum visible tags"
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Remember Filter State"
          description="Persist tag filters between app sessions"
        >
          <ToggleSwitch
            checked={settings.rememberFilterState}
            onChange={(value) => onChange('rememberFilterState', value)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="AI Suggestions">
        <SettingRow
          label="Enable AI Tag Suggestions"
          description="Use AI to automatically suggest tags for sessions"
        >
          <ToggleSwitch
            checked={settings.enableAiSuggestions}
            onChange={(value) => onChange('enableAiSuggestions', value)}
          />
        </SettingRow>

        <SettingRow
          label="Sessions per Hour"
          description="Rate limit for AI tag suggestions"
        >
          <input
            type="number"
            value={settings.aiSuggestionsSessionsPerHour}
            onChange={(e) => {
              const value = parseInt(e.target.value, 10);
              if (!isNaN(value) && value >= 1 && value <= 1000) {
                onChange('aiSuggestionsSessionsPerHour', value);
              }
            }}
            min="1"
            max="1000"
            step="1"
            className="input w-24"
            disabled={!settings.enableAiSuggestions}
            aria-label="Sessions per hour"
          />
        </SettingRow>

        <SettingRow
          label="Min Session Length"
          description="Minimum number of messages before suggesting tags"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={settings.aiSuggestionsMinSessionLength}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                if (!isNaN(value) && value >= 1 && value <= 100) {
                  onChange('aiSuggestionsMinSessionLength', value);
                }
              }}
              min="1"
              max="100"
              step="1"
              className="input w-24"
              disabled={!settings.enableAiSuggestions}
              aria-label="Minimum session length"
            />
            <span className="text-xs text-surface-500">messages</span>
          </div>
        </SettingRow>

        <SettingRow
          label="Scan Depth"
          description="How thoroughly to analyze session content"
        >
          <select
            value={settings.aiSuggestionsScanDepth}
            onChange={(e) => onChange('aiSuggestionsScanDepth', e.target.value as 'quick' | 'full')}
            className="select w-32"
            disabled={!settings.enableAiSuggestions}
            aria-label="Scan depth"
          >
            <option value="quick">Quick</option>
            <option value="full">Full</option>
          </select>
        </SettingRow>

        <SettingRow
          label="Rate Limit Scanning"
          description="Limit scanning to control token usage (100 sessions per hour)"
        >
          <ToggleSwitch
            checked={settings.tagScanRateLimitEnabled}
            onChange={(value) => onChange('tagScanRateLimitEnabled', value)}
            disabled={!settings.enableAiSuggestions}
          />
        </SettingRow>

        <SettingRow
          label="Scan Agent Sessions"
          description="Include agent sessions in tag suggestions (disabled by default)"
        >
          <ToggleSwitch
            checked={settings.tagScanAgentSessions}
            onChange={(value) => onChange('tagScanAgentSessions', value)}
            disabled={!settings.enableAiSuggestions}
          />
        </SettingRow>

        <SettingRow
          label="Auto-Accept High-Confidence Tags"
          description="Automatically apply tags with high confidence scores"
        >
          <ToggleSwitch
            checked={settings.aiSuggestionsAutoAccept}
            onChange={(value) => onChange('aiSuggestionsAutoAccept', value)}
            disabled={!settings.enableAiSuggestions}
          />
        </SettingRow>

        {settings.aiSuggestionsAutoAccept && (
          <SettingRow
            label="Auto-Accept Threshold"
            description="Minimum confidence score to auto-accept (0.0-1.0)"
          >
            <input
              type="number"
              value={settings.aiSuggestionsAutoAcceptThreshold}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value) && value >= 0 && value <= 1) {
                  onChange('aiSuggestionsAutoAcceptThreshold', value);
                }
              }}
              min="0"
              max="1"
              step="0.05"
              className="input w-24"
              disabled={!settings.enableAiSuggestions}
              aria-label="Auto-accept threshold"
            />
          </SettingRow>
        )}

        <div className="px-5 py-4 space-y-3 bg-surface-800/30">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-surface-100">Backlog Status</div>
              <div className="text-xs text-surface-500 mt-0.5">
                {isLoadingCount ? (
                  'Loading...'
                ) : pendingCount > 0 ? (
                  `${pendingCount} session${pendingCount === 1 ? '' : 's'} pending analysis`
                ) : (
                  'All sessions have been analyzed'
                )}
              </div>
            </div>
            <button
              onClick={handleScanAll}
              disabled={!settings.enableAiSuggestions || pendingCount === 0 || isLoadingCount}
              className="btn btn-primary btn-sm"
            >
              Scan All Sessions
            </button>
          </div>
        </div>
      </SettingsSection>

      <ScanProgressModal
        isOpen={isScanModalOpen}
        onClose={handleScanComplete}
        onCancel={handleScanCancel}
      />
    </>
  );
}
