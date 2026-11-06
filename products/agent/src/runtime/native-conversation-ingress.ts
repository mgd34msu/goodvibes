import { routeNativeConversationInput as route } from '@goodvibes-jev/engine/terminal-shell/native-ingress';
export { dispatchNativeConversationTurn } from '@goodvibes-jev/engine/terminal-shell/native-ingress';
export async function routeNativeConversationInput(deps: Parameters<typeof route>[0]): Promise<void> {
  await route({ ...deps, preparationFailureMessage: 'Native intake could not be inspected. No ordinary turn was started. Use /work intake-status to inspect the original input.' });
}
