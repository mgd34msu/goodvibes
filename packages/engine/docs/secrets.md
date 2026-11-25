# Secret references

GoodVibes config values can point at secrets without embedding secret material
directly in config files. The platform-owned URI form is `goodvibes://`.

**Public subpath:** `@goodvibes/engine/platform/platform/config` (daemon embedders).

## Supported sources

| Source | Purpose |
|---|---|
| `env` | Read from an environment variable |
| `goodvibes` | Resolve from the local GoodVibes secret store supplied by the host |
| `file` | Read from a file path, with optional selector support |
| `exec` | Run a command and use its stdout as the secret |
| `1password` / `onepassword` | Resolve through the 1Password CLI/native reference shape |
| `bitwarden` | Resolve through the Bitwarden CLI |
| `vaultwarden` | Resolve through Bitwarden CLI against a Vaultwarden server |
| `bitwarden-secrets-manager` / `bws` | Resolve through Bitwarden Secrets Manager |

The removed generic `secret://` scheme is not supported. Use
`goodvibes://secrets/...` for platform-owned secret references.

## URI shape

```text
goodvibes://secrets/<source>/<id-or-path>?key=value
```

Examples:

```text
goodvibes://secrets/env/OPENAI_API_KEY
goodvibes://secrets/goodvibes/GOODVIBES_WORKER_TOKEN
goodvibes://secrets/file/%2Fhome%2Fme%2F.token
goodvibes://secrets/1password?vault=Private&item=OpenAI&field=password
goodvibes://secrets/bitwarden/My%20Login?field=password
goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000
```

JSON-style references are also supported through the `secretref:` prefix when
clients need structured fields that do not fit naturally in a URI.

## Shorthand URI schemes

Provider-native URI forms are also accepted directly, without the `goodvibes://secrets/`
prefix, alongside the canonical shape above:

- **`op://vault/item/field`**, 1Password's own reference syntax. Passed through verbatim
  to the 1Password CLI as `ref`, rather than being decomposed into `vault`/`item`/`field`
  parameters.
- **`bw://item/field?...`**, **`vaultwarden://item/field?...`**, and **`bws://id/field?...`**,
  shorthand host-based forms of the `goodvibes://secrets/bitwarden/...`,
  `goodvibes://secrets/vaultwarden/...`, and `goodvibes://secrets/bws/...` shapes. The item
  (or secret id) is the URI host, the field is the first path segment or a `?field=`
  parameter, and the same query parameters (`server`, `serverEnv`, `customField`
  for Bitwarden; `profile` for Bitwarden Secrets Manager) apply.

A reference names only what to read. Which program runs it, the Bitwarden data
directory, the variable holding a session or access token, and the Bitwarden
Secrets Manager config file and server are this machine's settings, never part
of a reference, so a reference that arrives in a repository or an imported file
cannot choose a program to run or a server to hand a token to:

| Setting | Used for | Empty means |
| --- | --- | --- |
| `storage.secretProviders.onePasswordCli` | `op://` and `1password` references | `op` on your PATH |
| `storage.secretProviders.bitwardenCli` | `bitwarden` and `vaultwarden` references | `bw` on your PATH |
| `storage.secretProviders.bitwardenAppDataDir` | `BITWARDENCLI_APPDATA_DIR` for `bw` | the CLI's own |
| `storage.secretProviders.bitwardenSessionEnv` | the variable passed to `bw` as `BW_SESSION` | `BW_SESSION` as it is |
| `storage.secretProviders.bwsCli` | `bws` references | `bws` on your PATH |
| `storage.secretProviders.bwsAccessTokenEnv` | the variable passed to `bws` as `BWS_ACCESS_TOKEN` | `BWS_ACCESS_TOKEN` as it is |
| `storage.secretProviders.bwsConfigFile` | `bws --config-file` | the CLI's own |
| `storage.secretProviders.bwsServerUrl` | `bws --server-url` | the CLI's own |

A project settings file, which is repository content, may carry only
`goodvibes://secrets/goodvibes/<KEY>` references (a named key in your own
store); any other reference in it is skipped with a notice.

```text
op://Private/OpenAI/password
bw://My%20Login/password
bws://00000000-0000-0000-0000-000000000000/value
```

## Resolution

`resolveSecretRef()` returns `{ source, value }`. A `null` value means the
reference parsed but the backing secret was unavailable.

Hosts can provide:

- `resolveLocalSecret` for `goodvibes` refs.
- `runCommand` for CLI-backed providers.
- `homeDirectory` for `~` expansion in file refs.
- `providers` for the password-manager host settings above (otherwise the
  settings the process's credential store reads).

The credential store resolves a password-manager reference once and keeps the
value until a credential is set, deleted or imported, or a store file changes;
"Test a secret reference" (the capability `secrets.test`) always asks the password manager.

CLI-backed refs support timeouts. Command
execution is host-owned so embedders can apply their own permission prompts,
logging, and sandboxing.

## Config usage

Secret refs are used by provider keys, surface credentials, Cloudflare tokens,
Worker/client tokens, Tunnel tokens, Access service tokens, webhook secrets,
and other daemon-owned integration credentials.

Store secret refs in config; store the secret values in the backing secret
provider. A setting that holds a credential (a channel token, `cluster.secret`,
a Cloudflare token reference, the ntfy topic names, an incoming or outbound
webhook URL, the notification webhook URLs and the rest of the declared list)
takes only a `goodvibes://secrets/` reference: a plain value is refused with the
control that stores it ("Store a secret" on the Secrets tab of Permissions and safety, "add an address" on the
Notifications tab of Mail, calendar and channels for a notification webhook, or
the settings screen, which stores the value and writes
the reference for you). Card number, expiry, CVV and cardholder
name are never settings; cards are kept in the daemon's card store through
"Add a card" in Money (its Cards tab) or the web UI.

## Where stored secrets are read from

A lookup reads the environment, then the daemon's store, then your own store
(`~/.goodvibes/<surface>/secrets.enc`, then the plaintext file), and last the
store of the project you opened (`<project>/.goodvibes/<surface>/secrets.enc`).
Directories above the project are never read. A project's store is part of the
checkout, so a key in it is used only after you stored it there yourself or
confirmed it once with "Use a secret from this project's store"; until then the
Secrets tab marks it "waits for you". The confirmation is kept beside your own store,
outside every checkout. A reference found in a project's store is followed only
when it names a key in your store (`goodvibes://secrets/goodvibes/<KEY>`).

A value you store is the credential itself, even when its text looks like a
reference (`op://...`, a JSON reference): it is stored wrapped and handed back
as typed. Only "Point a secret at a password manager" (`secrets.link`, a
`goodvibes://secrets/` reference) stores a pointer.

Each store file is read once and kept until it changes; a lookup costs one
`stat` per store file, and a change another process makes is noticed by that
`stat` or by the watch on the store directories.

## Live provider credentials

Provider API keys resolve through one request-time chain: environment
variable → secrets store → subscription accounts. Writing, rotating, or
deleting a key in the secrets store re-registers the affected providers in
the same process (`SecretsManager.onDidChange` →
`ProviderRegistry.refreshProviderCredentials()`), so a provider becomes
usable the moment its key is stored. No restart anywhere. Only the providers
whose key changed are rebuilt; storing an unrelated secret leaves every
provider, its discovered models and its warm caches as they were. Status badges,
the model picker, and chat all read the same refreshed provider instances,
so status can never be green while chat fails auth. Every registered
provider must declare how its credentials are obtained
(`credentialAuthority: 'resolver' | 'anonymous' | 'subscription' | 'oauth'`);
registration is refused otherwise.

## Related

This page is the canonical reference for the secret sources and `goodvibes://` URI syntax. For how secret refs and the `SecretsManager` storage layers fit the daemon security model, see [Security Best Practices](./security.md).
