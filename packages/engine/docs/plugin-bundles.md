# Capability bundles and SHA-pinned distribution

A **capability bundle** is a distributable unit that declares, up front, in a
manifest, exactly which capabilities it needs. `kind` names what the bundle
is: `plugin` (registers tools and hooks), `skill` (a packaged instruction set
a runtime loads on demand), `hook-pack` (a set of runtime-hook subscriptions
with no tools of its own), or `policy-pack` (config-domain and channel
declarations that shape existing behavior rather than adding new tools). The
runtime grants a bundle **only** what it declared: deny-by-default at the
surface level, not merely at the security-capability level. Distribution is
**SHA-256 pinned**, and the marketplace index format is **governed by
construction**. An unpinned or capability-opaque entry cannot be represented.

Import from `@goodvibes/engine/platform/platform/runtime/ecosystem`.

## Plugin manifest signatures

The plugin trust platform verifies Ed25519 signatures with the publisher's PEM public
key. Authors keep the private key in their signing environment and sign the bytes
returned by `pluginManifestSignaturePayload(manifest)`, exported from
`@goodvibes/engine/platform/platform/runtime/operations`. Store the 64-byte signature
as canonical base64 in the manifest's `signature` field.

The payload includes every JSON manifest field except `signature`; object keys
and the capability list are sorted. Entry points, hooks, descriptions, and runtime
constraints therefore participate in verification. `validatePluginSignature`
checks a signature, and `PluginTrustStore.trustSigned(name, manifest, publicKey)`
(both exported from the same subpath)
grants trust only to the matching plugin name after verification.

Previously accepted HMAC signatures need to be replaced with publisher signatures;
persisted grants from that format require re-verification. A manifest signature
authenticates its metadata. Verify distributed code with the bundle's published
pin as described below.

## The manifest

```jsonc
{
  "schemaVersion": 1,
  "id": "my-bundle",
  "name": "My Bundle",
  "version": "1.0.0",
  "description": "What it does.",
  "kind": "plugin",
  "capabilities": {
    "runtime": ["register.tool", "filesystem.read"],  // deny-by-default security caps
    "tools": ["my.tool"],                              // tool ids it registers
    "hooks": ["session:start"],                        // runtime hooks it subscribes to
    "configDomains": ["my"],                           // config domains it reads
    "channels": ["tui"]                                // channel surfaces it touches
  }
}
```

`validateCapabilityBundleManifest(value)` returns the typed manifest or the full
list of reasons it was rejected. An unknown security capability is a hard error,
not a silent drop. A typo cannot slip past review.

## Enforcement: declaration is the grant

`createBundleCapabilityGuard(manifest)` returns a deny-by-default guard, and
`enforceBundleCapability(guard, surface, name)` throws `BundleCapabilityViolation`
for anything the manifest did not declare.

An installed bundle's receipt carries its grant: the security capabilities its
trust tier granted and the tools, hooks, config domains and channels it
declared. When the plugin loader starts a plugin installed from a bundle, it
builds the guard from that receipt, and every registration is checked before it
takes effect: a tool needs `register.tool` and the tool's id (as the plugin names
it, or as registered, `plugin_<plugin>_<name>`) in `tools`; an event
subscription needs `register.hook` and the event name in `hooks`; a provider of
any kind needs `register.provider`; a channel plugin or delivery strategy needs
its id in `channels`. A registration outside the grant stops the plugin's start
and names what was not declared. A plugin whose install receipt exists but
cannot be read is not loaded; reinstalling it writes the receipt again.

Every plugin, bundle or not, is also held to its trust tier at each start: the
capabilities its `manifest.json` declares (a plain list, or a bundle manifest's
`capabilities.runtime`) are resolved against the plugin's current tier, a tool,
provider or hook registration outside that grant fails the start, and a
declared high-risk capability the tier withholds keeps the plugin from starting.
An untrusted plugin gets `register.panel` and `filesystem.read` (and may add
commands); `limited` adds the tools, providers and hooks it declares, and lets
it register gateway methods, channels and delivery strategies; `trusted` adds
the high-risk ones. The tier is one decision per plugin shared by every app on
the machine (`PluginManagerOptions.trustFilePath`, `~/.goodvibes/plugin-trust.json`):
an app reads it again at each plugin start when the file changed.

```ts
const guard = createBundleCapabilityGuard(manifest);
enforceBundleCapability(guard, 'tool', 'my.tool');   // ok, declared
enforceBundleCapability(guard, 'channel', 'slack');  // throws, not declared
```

## Quarantine on install

`planBundleActivation(manifest, { trustTier })` resolves the bundle's declared
security capabilities against the trust tier using the existing plugin
capability model. If the bundle declared high-risk capabilities the tier does
not grant, it installs **quarantined**: those capabilities are withheld and
recorded (`plan.quarantine`), and the returned guard cannot exercise them even
though they were declared. Because a plugin runs inside the process, the loader
does not start a plugin while a high-risk capability it declares is withheld;
`/plugin trust <id> trusted` (or removing the capability) lets it start.
Over-reach is withheld, never silently granted.

## SHA-256 pinned distribution

A pinned source carries a required `sha256`:

```ts
const source: PinnedBundleSource = {
  kind: 'file' | 'url' | 'git',
  location: '…',
  sha256: '<64 hex chars>',   // required
  ref: 'v1.0.0',              // required for git
};
const { bytes } = await fetchAndVerifyBundle(source);
```

`fetchAndVerifyBundle` verifies the pin **before** returning. A missing or
mismatched pin throws `BundlePinRefusal`. There is no path that yields bytes for
an unverified source. All three source kinds resolve to the same byte space, so
one pin convention (hex SHA-256 of the fetched bytes) governs every source.

## Governed marketplace index

A `PinnedMarketplaceIndex` is a static, self-hostable JSON document. Each entry's
`source.sha256` and `capabilities` summary are **required by the type**.
`parseMarketplaceIndex` rejects any entry missing them, so a registry built from
this format cannot list an unpinned or capability-opaque bundle. There is no
field to omit that would let one through.

```ts
const entry = buildMarketplaceIndexEntry(manifest, source);
const doc = serializeMarketplaceIndex({ version: 1, bundles: [entry] });
```

## CLI

```
bun packages/engine/scripts/plugin-bundle.ts init --id my-bundle --kind plugin --out bundle.json
bun packages/engine/scripts/plugin-bundle.ts validate --manifest bundle.json
bun packages/engine/scripts/plugin-bundle.ts validate --index marketplace.json
```

Both subcommands are thin front-ends over the exported library functions, so
every behavior is also callable programmatically.
