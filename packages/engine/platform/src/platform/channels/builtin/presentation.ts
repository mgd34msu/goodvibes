import type { ChannelRenderPolicy, ChannelSurface } from '../types.js';
import { DEFAULT_POLICY } from '../reply-policy.js';

/** The built-in surface's render policy: the one default table, marked as built in. */
export function renderBuiltinPolicy(surface: ChannelSurface): ChannelRenderPolicy {
  return { ...DEFAULT_POLICY[surface], metadata: { ...DEFAULT_POLICY[surface].metadata, builtIn: true } };
}

export function surfaceLabelForBuiltin(surface: ChannelSurface): string {
  switch (surface) {
    case 'tui':
      return 'Terminal UI';
    case 'web':
      return 'Web control plane';
    case 'slack':
      return 'Slack';
    case 'discord':
      return 'Discord';
    case 'ntfy':
      return 'ntfy';
    case 'webhook':
      return 'Generic webhook';
    case 'homeassistant':
      return 'Home Assistant';
    case 'telegram':
      return 'Telegram';
    case 'google-chat':
      return 'Google Chat';
    case 'signal':
      return 'Signal';
    case 'whatsapp':
      return 'WhatsApp';
    case 'telephony':
      return 'Telephony';
    case 'imessage':
      return 'iMessage';
    case 'msteams':
      return 'Microsoft Teams';
    case 'bluebubbles':
      return 'BlueBubbles';
    case 'mattermost':
      return 'Mattermost';
    case 'matrix':
      return 'Matrix';
  }
}
