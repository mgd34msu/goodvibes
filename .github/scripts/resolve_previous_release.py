"""Pick the release a new release upgrades from: the highest earlier stable vN.N.N tag.

Usage: resolve_previous_release.py <release tag> <git revision to search from>

Prints `tag=` and `source=` to $GITHUB_OUTPUT when there is one. No earlier stable tag is a
first release: a warning says the upgrade and rollback proof is skipped. A tag listing that fails
is an error, never a silent skip.
"""
import os
import re
import subprocess
import sys

STABLE = re.compile(r'v\d+\.\d+\.\d+')


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True)


def version(tag):
    """(major, minor, patch) of a stable vN.N.N tag."""
    return tuple(int(part) for part in tag[1:].split('.'))


def resolve(release_tag, base, git=git):
    """Return (tag, source commit) of the previous release, or None for a first release.

    The previous release is the highest stable vN.N.N tag (by version, not by distance) among
    the tags merged into `base`, below the release being made. A nearer tag that is not of that
    exact form (v3.4, v3.3.1.1, v3.3.2-rc.1) is never the answer.
    """
    listed = git('tag', '--merged', base, '--list', 'v[0-9]*')
    if listed.returncode != 0:
        raise SystemExit(f'The release tags merged into {base} could not be listed: {listed.stderr.strip()}')
    earlier = [t for t in listed.stdout.split() if STABLE.fullmatch(t) and t != release_tag]
    if STABLE.fullmatch(release_tag):
        earlier = [t for t in earlier if version(t) < version(release_tag)]
    if not earlier:
        return None
    previous = max(earlier, key=version)
    source = git('rev-parse', f'{previous}^{{commit}}')
    if source.returncode != 0:
        raise SystemExit(f'The previous release tag {previous} does not name a commit: {source.stderr.strip()}')
    return previous, source.stdout.strip()


def main(argv):
    release_tag, base = argv
    found = resolve(release_tag, base)
    if found is None:
        print('::warning::No earlier stable release tag was found: the upgrade and rollback acceptance against a previous release is skipped for this release.')
        return
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a', encoding='utf-8') as stream:
            stream.write(f'tag={found[0]}\nsource={found[1]}\n')
    print(f'Previous release: {found[0]} ({found[1]})')


if __name__ == '__main__':
    main(sys.argv[1:])
