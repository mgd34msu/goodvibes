# @goodvibes-jev/tui-darwin-arm64

Prebuilt `goodvibes` binary for **darwin-arm64**, alongside the matching
`sqlite-vec` native addon (`vec0.dylib`) that the terminal's own `/recall`
semantic search needs.

This is a payload package with no lifecycle scripts. It is installed
automatically as an optional dependency of
[`@goodvibes-jev/tui`](https://www.npmjs.com/package/@goodvibes-jev/tui)
when your platform matches its `os`/`cpu` fields. The package manager
verifies it against the registry integrity hash, so no trust step and no
post-install download are required. Do not depend on it directly.

`goodvibes-daemon` is not part of this package. The daemon is its own
product with its own npm package, `@goodvibes-jev/daemon`, which
`@goodvibes-jev/tui` declares as a regular dependency so installing the
terminal still brings the daemon along; that package's own postinstall
places the `goodvibes-daemon` binary.
