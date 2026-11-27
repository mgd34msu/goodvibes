/** Local environment hygiene. No network or judgment dependency on process spawning. */
// Conventional credential variables. Explicit tool env and the configured
// allowlist retain their existing override semantics. A bare KEY, PASS, PWD or
// SESSION suffix is deliberately not matched without a separator: PWD and
// OLDPWD are the working directory, not a password.
const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|KEY|API_KEY|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIALS|AUTH|AUTH_TOKEN|SK|PAT|DSN|COOKIE)$|_PWD$|^(?:PGPASSWORD|PGPASSFILE|NETRC|SSH_AUTH_SOCK|DATABASE_URL|OPENAI_KEY|REDIS_URL|MONGODB_URI|MONGO_URL|AMQP_URL|BROKER_URL)$/i;
// A URL value that carries a user and password: scheme://user:secret@host.
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export function readCredentialEnvName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

/** Injectable scrub configuration (wired from `permissions.exec.*` config by the consumer). */
export interface CredentialEnvScrubConfig {
  /** Master switch. Default true, the scrub is on unless a consumer disables it. */
  readonly enabled?: boolean | undefined;
  /** Variable names always kept without a reading (case-insensitive). */
  readonly allowlist?: readonly string[] | undefined;
}

/** Resolved, non-optional scrub configuration. */
export interface ResolvedCredentialEnvScrub {
  readonly enabled: boolean;
  readonly allowlist: ReadonlySet<string>;
}

/** Resolve raw scrub config into the internal form. Enabled by default. */
export function resolveCredentialEnvScrub(config: CredentialEnvScrubConfig = {}): ResolvedCredentialEnvScrub {
  return {
    enabled: config.enabled !== false,
    allowlist: new Set((config.allowlist ?? []).map((name) => name.toUpperCase())),
  };
}

export interface CredentialEnvScrubResult {
  /** The environment with credential-bearing variables removed. */
  readonly env: Record<string, string>;
  /** Names withheld from `env`, sorted. NEVER includes values. */
  readonly withheld: string[];
}

/**
 * Remove credential-bearing variables from `env`. An allowlisted name is kept
 * without a reading; every other name is withheld when {@link readCredentialEnvName}
 * says it is a credential, or its value is a URL that embeds a password. When the scrub is disabled the env
 * passes through untouched with an empty withheld set and nothing is read.
 */
export async function scrubCredentialEnv(
  env: Record<string, string>,
  scrub: ResolvedCredentialEnvScrub,
): Promise<CredentialEnvScrubResult> {
  if (!scrub.enabled) return { env, withheld: [] };
  const entries = Object.entries(env);
  const withholds = entries.map(([name, value]) =>
    scrub.allowlist.has(name.toUpperCase()) ? false : readCredentialEnvName(name) || URL_WITH_PASSWORD.test(value));
  const kept: Record<string, string> = {};
  const withheld: string[] = [];
  entries.forEach(([name, value], index) => {
    if (withholds[index]) withheld.push(name);
    else kept[name] = value;
  });
  withheld.sort();
  return { env: kept, withheld };
}

/**
 * This process's environment without its credentials (a variable named like one, a URL carrying a password): what a
 * long-lived program the product starts by itself inherits (a tool server, a language server), so the operator token
 * and the keys the person exported are never copied into another process's environment, where any process of the
 * account could read them. What the program's own configuration gives it (a tool server's `env`) is added by the
 * caller after this, as given.
 */
export function inheritedEnvWithoutCredentials(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || readCredentialEnvName(name) || URL_WITH_PASSWORD.test(value)) continue;
    kept[name] = value;
  }
  return kept;
}
