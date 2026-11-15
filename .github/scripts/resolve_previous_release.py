"""Pick the release a new release upgrades from: the nearest earlier stable vN.N.N tag.

Usage: resolve_previous_release.py <release tag> <git revision to search from>

Prints `tag=` and `source=` to $GITHUB_OUTPUT when there is one. No earlier stable tag is a
first release: a warning says the upgrade and rollback proof is skipped. A tag search that fails
while earlier stable tags exist is an error, never a silent skip.
"""
import os
import re
import subprocess
import sys

STABLE = re.compile(r'v\d+\.\d+\.\d+')


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True)


def resolve(release_tag, base, git=git):
    """Return (tag, source commit) of the previous release, or None for a first release."""
    earlier = [t for t in git('tag', '--merged', base, '--list', 'v[0-9]*').stdout.split() if STABLE.fullmatch(t) and t != release_tag]
    described = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', 'v*-*', '--exclude', 'v*+*', base)
    previous = described.stdout.strip() if described.returncode == 0 else ''
    if not previous or previous == release_tag:
        if earlier:
            raise SystemExit(f'Earlier stable release tags exist ({", ".join(sorted(earlier)[-3:])}) but the nearest one could not be resolved from {base}: {described.stderr.strip()}')
        return None
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
