import { routeNativeConversationInput as route } from '@goodvibes/engine/terminal-shell/native-ingress';
export { dispatchNativeConversationTurn, releaseUnstartedNativeTurn, describeFailedNativeDispatch } from '@goodvibes/engine/terminal-shell/native-ingress';
export function routeNativeConversationInput(deps: Parameters<typeof route>[0]): ReturnType<typeof route> {
  return route({ ...deps, preparationFailureMessage: 'Native intake could not be inspected. No ordinary turn was started. Use /work intake to inspect the original input.' });
}
