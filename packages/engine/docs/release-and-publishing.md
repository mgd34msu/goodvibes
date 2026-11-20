# Releasing GoodVibes

Every package and program in this repository shares one version, and one tag
`vX.Y.Z` releases all of them. This page is the procedure for cutting that
release.

## Before the tag

1. Set the new version in the root `package.json`, then write it everywhere
   else with `bun run sync:version` (every workspace manifest and the version
   each program reports when its package file is not readable). Bun does not
   rewrite the workspace versions in `bun.lock` on a version-only change: set
   the six `"version"` lines of the workspace entries there to the same value.
   `bun run version:check` must pass.
2. Write the release notes at `docs/releases/X.Y.Z.md` and a
   `## [X.Y.Z] - YYYY-MM-DD` section at the top of
   `packages/engine/CHANGELOG.md` that links to them. A release without that
   section is refused.
3. Change the version in the places people copy it from: the install command in
   `README.md` and `docs/installation.md`, `products/agent/release/release-notes.md`,
   `products/tui/docs/github-action.md`, the icon links in
   `products/webui/index.html`, and the parts of `docs/llms/` that name the
   current release.
4. Regenerate what carries the version: `bun run refresh:contracts`,
   `bun run agent-spec:generate`, `bun run llms:generate`,
   `bun run --cwd products/webui release:prepare`, `bun run build`,
   `bun run api:extract` and `bun run api:subpath`.
5. Commit, push to `main`, and wait for the CI workflow to finish green on that
   commit.

## Cutting the release

From a clean working tree on the commit to release:

```sh
bun run release:tag --push
```

It makes the annotated tag `vX.Y.Z` from the engine's version and pushes it. A
tag that already exists on the same commit is pushed again rather than made
twice; one on another commit is refused.

## What the tag starts

The tag push runs the Release workflow (`.github/workflows/release.yml`):

1. **The tag must match the version.** Only a plain `vX.Y.Z` is released, and it
   must equal the version in `packages/engine/package.json`.
2. **CI must be green on that commit.** The newest "CI ok" check of this
   repository's CI workflow (`.github/workflows/ci.yml`) on the tagged commit
   must have succeeded. If CI is still running, failed, or never ran on that
   commit, nothing is published: let it finish or fix it, then release again.
3. **The programs are built and installed for real.** The release files for
   every platform are built from the tag, then fresh installs and upgrades from
   the previous release are run. All of them must pass.
4. **npm, only when switched on.** The packages are published to npm only when
   the repository variable `PUBLISH_NPM` is `true`, through the `production`
   environment (its approval is set in the repository's settings) with the
   `NPM_TOKEN` secret. When it is not set, npm is skipped and the release goes on
   without it.
5. **The GitHub release.** The release is created with every release file,
   `SHA256SUMS.txt` and `docs/releases/X.Y.Z.md` as its text, first as a draft
   and then published. The "latest" mark is given to the highest stable
   release. The installer and every daemon's update check follow that mark, so
   installed daemons start updating to the new version once it is set.

## Trying it without releasing

Run the Release workflow by hand: `dry-run` (the default) builds and packs the
npm packages and previews the publish without writing anything; `candidate`
with a full commit SHA builds and install-tests the release files for that
commit without a tag and without publishing.
