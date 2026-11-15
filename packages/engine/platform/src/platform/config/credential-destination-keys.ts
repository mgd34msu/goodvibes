/**
 * Settings that name where a stored credential is sent. Changing one while the
 * credential stays configured redirects the credential to the new host.
 */
export const CREDENTIAL_DESTINATION_KEYS: ReadonlySet<string> = new Set([
  'surfaces.calendar.caldavUrl',
  'surfaces.ntfy.baseUrl',
  'surfaces.homeassistant.instanceUrl',
  'surfaces.signal.bridgeUrl',
  'surfaces.whatsapp.bridgeUrl',
  'surfaces.telephony.bridgeUrl',
  'surfaces.imessage.bridgeUrl',
  'surfaces.bluebubbles.serverUrl',
  'surfaces.mattermost.baseUrl',
  'surfaces.matrix.homeserverUrl',
]);
