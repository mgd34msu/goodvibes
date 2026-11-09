"""Complete an existing release, retaining every previously published payload."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from release_asset_pins import needs_metadata, validate_reader_assets, resume_existing_assets
from release_asset_sources import RetainedReleaseAsset

directory, tag = Path(sys.argv[1]), sys.argv[2]
repo = os.environ.get('GITHUB_REPOSITORY', 'mgd34msu/goodvibes')
assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'Invalid release repository'
checksum_name = sys.argv[3] if len(sys.argv) > 3 else 'SHA256SUMS.txt'
assert re.fullmatch(r'[A-Za-z0-9_.-]+', checksum_name), 'Checksum asset name must be a flat filename'
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', tag), 'Invalid release tag'
source = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/git/ref/tags/{tag}'], text=True))['object']
while source['type'] == 'tag':
    source = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/git/tags/{source["sha"]}'], text=True))['object']
assert source['type'] == 'commit'
source = source['sha']
release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))
assert not release['draft'] and release['tag_name'] == tag
assets = {a['name']: a for a in release['assets']}
assert len(assets) == len(release['assets'])
with tempfile.TemporaryDirectory(prefix='goodvibes-release-completion-') as temporary, ExitStack() as ownership:
    temporary = Path(temporary)
    checks = {}
    if checksum_name in assets:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', checksum_name, '--dir', str(temporary)], check=True)
        for line in (temporary / checksum_name).read_text().splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
            assert match and match[2] not in checks and match[2] != checksum_name
            checks[match[2]] = match[1]
    assert set(checks) <= set(assets), 'A previously checksummed immutable asset is missing'
    incoming, retained = {}, {}
    for path in sorted(directory.iterdir()):
        assert path.is_file() and not path.is_symlink() and path.name != checksum_name and re.fullmatch(r'[A-Za-z0-9_.-]+', path.name)
        # Existing checksummed payloads are immutable and win outright. Their
        # unused rebuilt candidates need neither a local pin nor an open FD.
        if path.name in checks:
            continue
        original = ownership.enter_context(RetainedReleaseAsset(path))
        retained[path.name] = original
        incoming[path.name] = original.pin
    # Resume only actual candidate bytes left unlisted by a partial prior
    # upload. Arbitrary unchecksummed remote assets cannot join this source.
    resumed = resume_existing_assets(assets, checks, incoming, checksum_name)
    for name, digest in checks.items():
        assert assets[name]['digest'] == 'sha256:' + digest, name
    selected_pins = {name: {'sha256': digest, 'size': assets[name]['size']} for name, digest in checks.items()}
    selected_pins.update({name: pin for name, pin in incoming.items() if name not in assets})
    selected_metadata = {}
    metadata_dir = temporary / 'metadata'
    metadata_dir.mkdir()
    for name in selected_pins:
        if not needs_metadata(name):
            continue
        if name in assets:
            subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', str(metadata_dir)], check=True)
            path = metadata_dir / name
            assert path.stat().st_size <= 128 * 1024, f'Oversized release metadata: {name}'
            raw = path.read_bytes()
            # These bytes arrived from GitHub and require their actual published
            # integrity pin. Local candidates were already pinned exactly once.
            assert hashlib.sha256(raw).hexdigest() == selected_pins[name]['sha256'], f'Published metadata pin mismatch: {name}'
        else:
            raw = retained[name].read_metadata()
        selected_metadata[name] = raw
    # Refuse rebuilt metadata for different already-published binaries before
    # the first upload; filling a release must preserve a coherent source tuple.
    validate_reader_assets(selected_pins, selected_metadata, tag, source)
    added = []
    for name, original in sorted(retained.items()):
        if name in assets:
            continue
        original.assert_current()
        subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo, str(original.path)], check=True)
        original.assert_current()
        checks[name] = original.digest
        added.append(name)
    # Publication jobs share a tag-scoped concurrency group. Re-read actual
    # immutable asset digests before the final checksum replacement as well.
    final_release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))
    final_assets = {asset['name']: asset for asset in final_release['assets']}
    assert len(final_assets) == len(final_release['assets']) and set(final_assets) == set(checks) | ({checksum_name} if checksum_name in assets else set()), 'Release changed during completion'
    for name, digest in checks.items():
        assert final_assets[name]['digest'] == 'sha256:' + digest and final_assets[name]['size'] == selected_pins[name]['size'], f'Uploaded bytes differ from admitted pins: {name}'
    checksum = temporary / checksum_name
    checksum.write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(checks.items())))
    subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo, str(checksum), '--clobber'], check=True)
    print(json.dumps({'tag': tag, 'added': added, 'resumed': sorted(resumed), 'originalPayloadsPreserved': True, 'checksumEntries': len(checks)}))
