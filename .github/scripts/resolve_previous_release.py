"""Pick the release a new release upgrades from: the highest earlier stable vN.N.N version that
was actually published.

Usage: resolve_previous_release.py <release tag> <git revision to search from> <owner/repository>

Prints `tag=` and `source=` to $GITHUB_OUTPUT when there is one. A tag is not a release: a tag
whose release workflow failed published nothing, so the next release cannot upgrade from it. A
candidate counts only when GitHub has a release for its tag that is not a draft and has assets;
a higher tag passed over for lacking one is named in a plain line. No earlier published stable
release is a first release: a warning says the upgrade and rollback proof is skipped. A tag
listing or a release listing that fails is an error, never a silent skip and never a fall back
to bare tags.
"""
import os
import re
import subprocess
import sys

STABLE = re.compile(r'v\d+\.\d+\.\d+')
PUBLISHED = '.[] | select(.draft | not) | select((.assets | length) > 0) | .tag_name'


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True)


def gh(*args):
    try:
        return subprocess.run(['gh', *args], capture_output=True, text=True)
    except FileNotFoundError:
        return subprocess.CompletedProcess(['gh', *args], 127, '', 'the gh command is not installed')


def version(tag):
    """(major, minor, patch) of a stable vN.N.N tag."""
    return tuple(int(part) for part in tag[1:].split('.'))


def published_tags(repository, gh):
    """Tags of the releases of `repository` that are published: not a draft, with assets."""
    listed = gh('api', '--paginate', f'repos/{repository}/releases', '--jq', PUBLISHED)
    if listed.returncode != 0:
        raise SystemExit(f'The published releases of {repository} could not be listed from GitHub: {listed.stderr.strip()}')
    return set(listed.stdout.split())


def resolve(release_tag, base, repository, git=git, gh=gh):
    """Return (tag, source commit) of the previous release, or None for a first release.

    The previous release is the highest stable vN.N.N tag (by version, not by distance) among
    the tags merged into `base`, below the release being made, that has a published GitHub
    release. A nearer tag that is not of that exact form (v3.4, v3.3.1.1, v3.3.2-rc.1) is never
    the answer, and neither is a tag with no published release.
    """
    listed = git('tag', '--merged', base, '--list', 'v[0-9]*')
    if listed.returncode != 0:
        raise SystemExit(f'The release tags merged into {base} could not be listed: {listed.stderr.strip()}')
    earlier = [t for t in listed.stdout.split() if STABLE.fullmatch(t) and t != release_tag]
    if STABLE.fullmatch(release_tag):
        earlier = [t for t in earlier if version(t) < version(release_tag)]
    if not earlier:
        return None
    published = published_tags(repository, gh)
    previous = None
    for tag in sorted(earlier, key=version, reverse=True):
        if tag in published:
            previous = tag
            break
        print(f'{tag} is passed over: GitHub has no published release for it (none, a draft, or one without assets).')
    if previous is None:
        return None
    source = git('rev-parse', f'{previous}^{{commit}}')
    if source.returncode != 0:
        raise SystemExit(f'The previous release tag {previous} does not name a commit: {source.stderr.strip()}')
    return previous, source.stdout.strip()


def main(argv):
    release_tag, base, repository = argv
    found = resolve(release_tag, base, repository)
    if found is None:
        print('::warning::No earlier published stable release was found: the upgrade and rollback acceptance against a previous release is skipped for this release.')
        return
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a', encoding='utf-8') as stream:
            stream.write(f'tag={found[0]}\nsource={found[1]}\n')
    print(f'Previous release: {found[0]} ({found[1]})')


if __name__ == '__main__':
    main(sys.argv[1:])
