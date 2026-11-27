import { routeNativeConversationInput as route } from '@goodvibes/engine/terminal-shell/native-ingress';
export { dispatchNativeConversationTurn, releaseUnstartedNativeTurn, describeFailedNativeDispatch } from '@goodvibes/engine/terminal-shell/native-ingress';
export function routeNativeConversationInput(deps: Parameters<typeof route>[0]): ReturnType<typeof route> {
  return route({ ...deps, preparationFailureMessage: 'Your message could not be checked, so nothing was run. It is kept in Work, under Unanswered: check it there.' });
}
