// ============================================================================
// TIMEZONE SETTINGS COMPONENT
// ============================================================================

import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow } from './components';

interface TimezoneSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

// Common timezones with city labels for user-friendliness
const TIMEZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'US Eastern (New York)' },
  { value: 'America/Chicago', label: 'US Central (Chicago)' },
  { value: 'America/Denver', label: 'US Mountain (Denver)' },
  { value: 'America/Los_Angeles', label: 'US Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'US Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'US Hawaii (Honolulu)' },
  { value: 'Europe/London', label: 'UK (London)' },
  { value: 'Europe/Paris', label: 'Europe Central (Paris)' },
  { value: 'Europe/Berlin', label: 'Europe Central (Berlin)' },
  { value: 'Europe/Moscow', label: 'Europe Eastern (Moscow)' },
  { value: 'Asia/Dubai', label: 'Gulf (Dubai)' },
  { value: 'Asia/Kolkata', label: 'India (Mumbai)' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Shanghai', label: 'China (Shanghai)' },
  { value: 'Asia/Tokyo', label: 'Japan (Tokyo)' },
  { value: 'Asia/Seoul', label: 'Korea (Seoul)' },
  { value: 'Australia/Sydney', label: 'Australia Eastern (Sydney)' },
  { value: 'Australia/Perth', label: 'Australia Western (Perth)' },
  { value: 'Pacific/Auckland', label: 'New Zealand (Auckland)' },
];

export function TimezoneSettings({ settings, onChange }: TimezoneSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Date & Time">
      <SettingRow
        label="Timezone"
        description="Timezone used for displaying timestamps throughout the application"
      >
        <select
          value={settings.timezone}
          onChange={(e) => onChange('timezone', e.target.value)}
          className="select w-64"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsSection>
  );
}

export default TimezoneSettings;
