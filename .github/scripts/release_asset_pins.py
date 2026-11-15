"""Check descriptor pins against the bytes actually selected for publication.

This is a release integrity boundary, not a runtime identity/hash cache. The
caller owns source admission and supplies either local file digests or the
already verified immutable GitHub asset digests.
"""
import glob
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

if sys.flags.optimize:
    # Every integrity check here is an assert; -O or PYTHONOPTIMIZE would silently remove them all.
    raise SystemExit('Release integrity checks need assertions; run without -O or PYTHONOPTIMIZE.')

PROFILE = re.compile(r'(goodvibes(?:-agent|-daemon)?)-(linux|macos)-(x64|arm64)\.(reader-ci-artifact|ci-artifact)\.json')
SQLITE = re.compile(r'sqlite-darwin-(?:x64|arm64)\.dylib\.json')


def needs_metadata(name):
    match = PROFILE.fullmatch(name)
    return bool(match and (match[4] == 'reader-ci-artifact' or match[1] == 'goodvibes-daemon' and match[2] == 'linux')) or bool(SQLITE.fullmatch(name))


# The one table of installed members and their release assets, read from the
# tagged source, so publication does not trust the descriptor the build produced.
# The table is strict JSON between two markers in the TypeScript module that owns it.
COHORT_TABLE = Path(__file__).resolve().parents[2] / 'packages/engine/platform/src/platform/runtime/native-cohort-table.ts'
COHORT_MARKERS = re.compile(r'/\* cohort-table:begin \*/(.*?)/\* cohort-table:end \*/', re.S)


def cohort_members():
    match = COHORT_MARKERS.search(COHORT_TABLE.read_text(encoding='utf-8'))
    assert match, f'The cohort table markers are missing from {COHORT_TABLE}'
    return json.loads(match[1])['members']


def reader_member_assets(name):
    """Installed-member to published-asset mapping for an evidence file, from the cohort table."""
    match = PROFILE.fullmatch(name)
    if not match or not needs_metadata(name):
        return {}
    product, platform, arch, _ = match.groups()
    target = f'{"darwin" if platform == "macos" else platform}-{arch}'
    return {member['path']: member['asset'] for member in cohort_members()
            if member['product'] == product and member['target'] == target}


def validate_reader_assets(pins, metadata, tag, source=None):
    assert re.fullmatch(r'v\d+\.\d+\.\d+', tag), 'Invalid release tag: only stable vN.N.N tags are published'
    version = tag[1:]
    for name in pins:
        if re.fullmatch(r'goodvibes(?:-agent|-daemon)?-(?:linux|macos)-(?:x64|arm64)', name):
            assert name + '.reader-ci-artifact.json' in metadata, f'Selected program has no reader evidence: {name}'
    for name, raw in metadata.items():
        match = PROFILE.fullmatch(name)
        if not match or not needs_metadata(name):
            continue
        product, platform, arch, kind = match.groups()
        asset = f'{product}-{platform}-{arch}'
        target = f'{"darwin" if platform == "macos" else platform}-{arch}'
        native_linux = product == 'goodvibes-daemon' and platform == 'linux'
        reader = kind == 'reader-ci-artifact'
        member_assets = reader_member_assets(name)
        expected = list(member_assets)
        assert len(raw) <= 128 * 1024, f'Oversized reader metadata: {name}'
        value = json.loads(raw)
        assert value['target'] == target, f'Reader target mismatch: {name}'
        assert value['schema'] == (2 if native_linux and reader else 1), f'Reader schema mismatch: {name}'
        if not native_linux:
            package = '@goodvibes-jev/' + {'goodvibes': 'tui', 'goodvibes-agent': 'agent', 'goodvibes-daemon': 'daemon'}[product]
            assert value['packageName'] == package and value['version'] == version, f'Reader product/version mismatch: {name}'
        if reader:
            assert value['readers']['schema'] == 1 and value['readers']['version'] == version, f'Reader version mismatch: {name}'
        if source is not None:
            assert value['sourceCommit'] == source and value['headCommit'] == source, f'Reader source mismatch: {name}'
        members = value['files']
        assert len(members) == len(expected) and {member['path'] for member in members} == set(expected), f'Incomplete reader cohort: {name}'
        for member in members:
            path = member['path']
            selected = member_assets[path]
            assert selected in pins, f'Reader references missing asset: {name}: {selected}'
            actual = pins[selected]
            assert member['sha256'] == actual['sha256'] and member['size'] == actual['size'], f'Reader pins do not match selected published bytes: {name}: {selected}'
            expected_mode = 0o755 if path == asset or path == asset + '.bun' else 0o644
            assert member['mode'] == expected_mode, f'Reader member mode mismatch: {name}: {selected}'
        if native_linux and not reader:
            rich_name = asset + '.reader-ci-artifact.json'
            assert rich_name in metadata, f'Current Linux daemon has no affirmative reader evidence: {asset}'
            rich = json.loads(metadata[rich_name])
            for key in ['sourceCommit', 'sourceTree', 'headCommit', 'target', 'files']:
                assert value[key] == rich[key], f'Legacy/rich daemon descriptors disagree: {asset}'
        if product == 'goodvibes-daemon' and platform == 'macos':
            producer_name = f'sqlite-{target}.dylib.json'
            assert producer_name in metadata, f'Darwin SQLite producer is absent: {asset}'
            owner = json.loads(metadata[producer_name])
            library = pins[f'sqlite-{target}.dylib']
            assert owner['schema'] == 1 and owner['packageName'] == '@goodvibes-jev/daemon' and owner['daemonVersion'] == version and owner['target'] == target, f'Darwin SQLite producer identity mismatch: {asset}'
            assert owner['sha256'] == library['sha256'] and owner['size'] == library['size'], f'Darwin SQLite producer does not bind selected library: {asset}'


def resume_existing_assets(assets, checks, incoming, checksum_name='SHA256SUMS.txt'):
    """Admit only exact candidate bytes left unlisted by a prior partial upload."""
    # A checksummed name the release lost (a payload upload that failed after the manifest landed) is
    # uploaded again, but only from a candidate with exactly the digest the manifest recorded.
    for name in sorted(set(checks) - set(assets)):
        assert name in incoming and incoming[name]['sha256'] == checks[name], (
            f'A previously checksummed immutable asset is missing and no candidate has its recorded digest: {name}')
    pending = sorted(set(assets) - set(checks) - {checksum_name})
    for name in pending:
        assert name in incoming and assets[name]['digest'] == 'sha256:' + incoming[name]['sha256'] and assets[name]['size'] == incoming[name]['size'], (
            f'Unknown partial upload: {name}. The release holds it but no checksum entry lists it and the rebuilt bytes differ. '
            f'Delete {name} from the release and run the completion again, or rerun with the original build output.')
    for name in pending:
        checks[name] = incoming[name]['sha256']
    return pending


def select_payloads(patterns, checksum_name='SHA256SUMS.txt'):
    """The release payloads named by whitespace-separated globs: flat names, one file per basename.

    The checksum manifest travels beside the payloads and is never a payload itself.
    Refuse basename ambiguity instead of letting a later match replace a different binary.
    """
    assert re.fullmatch(r'[A-Za-z0-9_.-]+', checksum_name), 'Checksum asset name must be a flat filename'
    selected = {}
    for pattern in patterns.split():
        matches = glob.glob(pattern)
        assert matches, f'No release asset matched: {pattern}'
        for value in matches:
            path = Path(value)
            assert path.is_file() and not path.is_symlink(), f'Invalid release asset: {path}'
            if path.name == checksum_name:
                continue
            assert re.fullmatch(r'[A-Za-z0-9_.-]+', path.name), f'Invalid release asset name: {path}'
            prior = selected.get(path.name)
            assert prior is None or prior.resolve() == path.resolve(), f'Ambiguous release asset basename: {path.name}'
            selected[path.name] = path
    assert selected, 'No release assets selected'
    return selected


def stage_release_assets(directory, patterns, checksum_name='SHA256SUMS.txt'):
    """Copy the selected payloads into a new flat directory for release completion."""
    directory = Path(directory)
    directory.mkdir(exist_ok=False)
    selected = select_payloads(patterns, checksum_name)
    for name, path in selected.items():
        with path.open('rb') as source, (directory / name).open('xb') as output:
            shutil.copyfileobj(source, output)
    return sorted(selected)


def release_exists(repository, tag, run=subprocess.run):
    """Whether the tag already has a published release. Only a 404 means absent; any other failure stops."""
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'Invalid release repository'
    result = run(['gh', 'api', f'repos/{repository}/releases/tags/{tag}'], capture_output=True, text=True)
    try:
        value = json.loads(result.stdout)
    except ValueError:
        value = None
    if not isinstance(value, dict):
        value = {}
    if result.returncode:
        assert str(value.get('status')) == '404', (
            f'Looking up the release {tag} failed ({result.stderr.strip() or "no response"}); re-run the job once GitHub answers.')
        return False
    assert value.get('tag_name') == tag and value.get('draft') is False, (
        f'The release {tag} exists as a draft or under another tag; publish or delete it, then re-run the job.')
    return True


def write_output(name, value):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        if '\n' in value:
            output.write(f'{name}<<GOODVIBES_{name.upper()}_EOF\n{value}GOODVIBES_{name.upper()}_EOF\n')
        else:
            output.write(f'{name}={value}\n')


def main(argv):
    """Workflow entry: `payloads <globs>`, `release-exists <tag>`, `stage <directory> <globs>`."""
    command, *args = argv
    if command == 'payloads':
        (patterns,) = args
        selected = select_payloads(patterns)
        write_output('paths', ''.join(str(selected[name]) + '\n' for name in sorted(selected)))
    elif command == 'release-exists':
        (tag,) = args
        write_output('exists', str(release_exists(os.environ['GITHUB_REPOSITORY'], tag)).lower())
    elif command == 'stage':
        directory, patterns = args
        print(json.dumps({'staged': stage_release_assets(directory, patterns)}))
    else:
        raise SystemExit(f'Unknown command {command}; expected payloads, release-exists or stage.')


if __name__ == '__main__':
    main(sys.argv[1:])
