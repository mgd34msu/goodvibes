export type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

/** A set-but-blank variable (an env template left empty) is not a token. */
function presentToken(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function readDaemonCliTokens(env: NodeJS.ProcessEnv): DaemonCliTokens {
  const daemonToken = presentToken(env.GOODVIBES_DAEMON_TOKEN);
  return {
    daemonToken,
    httpToken: presentToken(env.GOODVIBES_HTTP_TOKEN) ?? daemonToken,
  };
}
