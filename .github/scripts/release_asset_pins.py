"""Check descriptor pins against the bytes actually selected for publication.

This is a release integrity boundary, not a runtime identity/hash cache. The
caller owns source admission and supplies either local file digests or the
already verified immutable GitHub asset digests.
"""
import glob
import json
from pathlib import Path
import re
import shutil

PROFILE = re.compile(r'(goodvibes(?:-agent|-daemon)?)-(linux|macos)-(x64|arm64)\.(reader-ci-artifact|ci-artifact)\.json')
SQLITE = re.compile(r'sqlite-darwin-(?:x64|arm64)\.dylib\.json')


def needs_metadata(name):
    match = PROFILE.fullmatch(name)
    return bool(match and (match[4] == 'reader-ci-artifact' or match[1] == 'goodvibes-daemon' and match[2] == 'linux')) or bool(SQLITE.fullmatch(name))


def reader_member_assets(name):
    """Fixed installed-member to published-asset mapping, independent of JSON."""
    match = PROFILE.fullmatch(name)
    if not match or not needs_metadata(name):
        return {}
    product, platform, arch, _ = match.groups()
    asset = f'{product}-{platform}-{arch}'
    target = f'{"darwin" if platform == "macos" else platform}-{arch}'
    members = [asset]
    if platform == 'linux':
        members += [asset + suffix for suffix in ['.bun', '.bun.LICENSE.md', '.bun.json']]
        if product == 'goodvibes-daemon':
            members.append(f'lib/sqlite-vec-{target}/vec0.so')
    elif product == 'goodvibes-daemon':
        members += [f'lib/sqlite-vec-{target}/vec0.dylib', f'lib/sqlite-{target}/libsqlite3.dylib', f'lib/sqlite-{target}/libsqlite3.dylib.json']
    result = {}
    for path in members:
        if path.startswith('lib/sqlite-vec-'):
            result[path] = f'sqlite-vec-{target}.{ "so" if platform == "linux" else "dylib" }'
        elif path.startswith('lib/sqlite-'):
            result[path] = f'sqlite-{target}.dylib' + ('.json' if path.endswith('.json') else '')
        else:
            result[path] = path
    return result


def validate_reader_assets(pins, metadata, tag, source=None):
    assert re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', tag), 'Invalid release tag'
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
    assert set(checks) <= set(assets), 'A previously checksummed immutable asset is missing'
    pending = sorted(set(assets) - set(checks) - {checksum_name})
    for name in pending:
        assert name in incoming and assets[name]['digest'] == 'sha256:' + incoming[name]['sha256'] and assets[name]['size'] == incoming[name]['size'], f'Unknown partial upload: {name}'
    for name in pending:
        checks[name] = incoming[name]['sha256']
    return pending


def stage_release_assets(directory, patterns, checksum_name):
    """Select immutable file candidates with the same whitespace/glob contract.

    Release asset names are flat. Refuse basename ambiguity instead of silently
    letting a later match replace a different binary during release completion.
    """
    directory = Path(directory)
    directory.mkdir(exist_ok=False)
    selected = {}
    for pattern in patterns.split():
        matches = glob.glob(pattern)
        assert matches, f'No release asset matched: {pattern}'
        for value in matches:
            path = Path(value)
            assert path.is_file() and not path.is_symlink(), f'Invalid release asset: {path}'
            assert re.fullmatch(r'[A-Za-z0-9_.-]+', path.name), f'Invalid release asset name: {path}'
            assert path.name != checksum_name, 'Payload globs must exclude the generated checksum manifest'
            prior = selected.get(path.name)
            assert prior is None or prior.resolve() == path.resolve(), f'Ambiguous release asset basename: {path.name}'
            selected[path.name] = path
    assert selected, 'No release assets selected'
    for name, path in selected.items():
        with path.open('rb') as source, (directory / name).open('xb') as output:
            shutil.copyfileobj(source, output)
    return sorted(selected)
