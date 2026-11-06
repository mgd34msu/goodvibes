import { ProfilePickerModal as PlatformProfiles } from '@goodvibes-jev/engine/terminal-shell/profile-picker-state';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
function configProfileDeletionDisabledMessage(name: string): string {
  return `Config-profile deletion is disabled in Agent for ${name}. Open Agent Workspace -> Profiles for isolated Agent profile homes.`;
}

function configProfileSavingDisabledMessage(name: string): string {
  return `Config-profile saving is disabled in Agent for ${name}. Open Agent Workspace -> Profiles to create isolated Agent homes.`;
}

export function renderProfilePickerStatePackageText(): string {
  return [
    'Profile name cannot be empty',
    'Loaded profile',
    'Saved profile',
    'Error',
    configProfileDeletionDisabledMessage('<profile>'),
    configProfileSavingDisabledMessage('<profile>'),
  ].join('\n');
}

/** Agent configuration profiles can be loaded; writes keep their explicit command/confirmation path. */
export class ProfilePickerModal extends PlatformProfiles {
  constructor(manager: ProfileManager) {
    super(manager, {
      deletionDisabled: configProfileDeletionDisabledMessage,
      savingDisabled: configProfileSavingDisabledMessage,
      loadedPrefix: 'Loaded profile ',
      savedPrefix: 'Saved profile ',
      errorPrefix: 'Error ',
      rejectLoad: (data) =>
        data.behavior && Object.hasOwn(data.behavior, 'notificationsMetadataOnly')
          ? 'This profile includes notification privacy settings that this Agent build cannot apply. No settings were changed.'
          : undefined,
    });
  }
  saveCurrentAsConfirmed(name: string, config: ConfigManager): boolean {
    return this.saveCurrentProfile(name, config);
  }
}
