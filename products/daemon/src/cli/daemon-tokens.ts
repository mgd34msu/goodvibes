/** The token values the daemon's process environment can set. */

/** A set-but-blank variable (an env template left empty) is not a token. */
function presentToken(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * `GOODVIBES_DAEMON_TOKEN`: when set, the daemon serves it as its shared
 * operator token instead of the one in `operator-tokens.json`, and every
 * command of this program that talks to this machine's daemon sends it.
 */
export function readEnvDaemonToken(env: NodeJS.ProcessEnv): string | undefined {
  return presentToken(env.GOODVIBES_DAEMON_TOKEN);
}

/**
 * `GOODVIBES_HTTP_TOKEN`: when set, the webhook listener's bearer token in
 * place of the one in `http-listener-token.json`. Never the operator token.
 */
export function readEnvHttpListenerToken(env: NodeJS.ProcessEnv): string | undefined {
  return presentToken(env.GOODVIBES_HTTP_TOKEN);
}
