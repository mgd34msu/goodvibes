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
if sys.flags.optimize:
    # Every integrity check here is an assert; -O or PYTHONOPTIMIZE would silently remove them all.
    raise SystemExit('Release integrity checks need assertions; run without -O or PYTHONOPTIMIZE.')
from release_asset_pins import needs_metadata, validate_reader_assets, resume_existing_assets
from release_asset_sources import RetainedReleaseAsset

directory, tag = Path(sys.argv[1]), sys.argv[2]
repo = os.environ.get('GITHUB_REPOSITORY', 'mgd34msu/goodvibes')
assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'Invalid release repository'
checksum_name = sys.argv[3] if len(sys.argv) > 3 else 'SHA256SUMS.txt'
assert re.fullmatch(r'[A-Za-z0-9_.-]+', checksum_name), 'Checksum asset name must be a flat filename'
assert re.fullmatch(r'v\d+\.\d+\.\d+', tag), 'Invalid release tag: only stable vN.N.N tags are published'
source = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/git/ref/tags/{tag}'], text=True))['object']
while source['type'] == 'tag':
    source = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/git/tags/{source["sha"]}'], text=True))['object']
assert source['type'] == 'commit'
source = source['sha']
release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))
assert not release['draft'] and release['tag_name'] == tag
assets = {a['name']: a for a in release['assets']}
assert len(assets) == len(release['assets'])


def release_api(method, asset, *fields):
    subprocess.run(['gh', 'api', '-X', method, f'repos/{repo}/releases/assets/{asset["id"]}', *fields], check=True, stdout=subprocess.DEVNULL)


# A new manifest is uploaded under this name and then takes the published name, so the release never
# lacks a manifest while an upload runs. One left by an interrupted run is stale when the published
# manifest is still there, and otherwise is the published manifest that missed its rename.
staged_name = checksum_name + '.next'
if staged_name in assets:
    leftover = assets.pop(staged_name)
    if checksum_name in assets:
        release_api('DELETE', leftover)
    else:
        release_api('PATCH', leftover, '-f', f'name={checksum_name}')
        assets[checksum_name] = {**leftover, 'name': checksum_name}
with tempfile.TemporaryDirectory(prefix='goodvibes-release-completion-') as temporary, ExitStack() as ownership:
    temporary = Path(temporary)
    checks = {}
    published_manifest = None
    if checksum_name in assets:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', checksum_name, '--dir', str(temporary)], check=True)
        published_manifest = (temporary / checksum_name).read_text()
        for line in published_manifest.splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
            assert match and match[2] not in checks and match[2] != checksum_name
            checks[match[2]] = match[1]
    incoming, retained = {}, {}
    for path in sorted(directory.iterdir()):
        if path.name == checksum_name:
            # The collected manifest of a fresh build; the published one is rebuilt from the release below.
            continue
        assert path.is_file() and not path.is_symlink() and path.name != staged_name and re.fullmatch(r'[A-Za-z0-9_.-]+', path.name)
        # Existing checksummed payloads are immutable and win outright. Their
        # unused rebuilt candidates need neither a local pin nor an open FD.
        # A checksummed payload the release no longer holds is the exception:
        # its candidate is pinned so it can be uploaded again if it has the recorded digest.
        if path.name in checks and path.name in assets:
            continue
        original = ownership.enter_context(RetainedReleaseAsset(path))
        retained[path.name] = original
        incoming[path.name] = original.pin
    # Resume only actual candidate bytes left unlisted by a partial prior
    # upload. Arbitrary unchecksummed remote assets cannot join this source.
    resumed = resume_existing_assets(assets, checks, incoming, checksum_name)
    for name, digest in checks.items():
        assert name not in assets or assets[name]['digest'] == 'sha256:' + digest, name
    selected_pins = {name: {'sha256': digest, 'size': assets[name]['size']} for name, digest in checks.items() if name in assets}
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
    manifest = ''.join(f'{digest}  {name}\n' for name, digest in sorted(checks.items()))
    replaced = manifest != published_manifest
    if replaced:
        try:
            staged = temporary / staged_name
            staged.write_text(manifest)
            subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo, str(staged)], check=True)
            uploaded = {asset['name']: asset for asset in json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))['assets']}
            assert uploaded[staged_name]['digest'] == 'sha256:' + hashlib.sha256(manifest.encode()).hexdigest(), f'Uploaded {staged_name} differs from the manifest written'
            # Two metadata calls with no upload between them: the published manifest is replaced, never missing for an upload.
            if checksum_name in uploaded:
                release_api('DELETE', uploaded[checksum_name])
            release_api('PATCH', uploaded[staged_name], '-f', f'name={checksum_name}')
        except (subprocess.CalledProcessError, AssertionError, KeyError) as error:
            raise SystemExit(
                f'The release {tag} holds every payload, but replacing {checksum_name} stopped: {error}. '
                f'The release still lists the previous manifest or the new one as {staged_name}; '
                f'run this completion again to finish the replacement.')
    print(json.dumps({'tag': tag, 'added': added, 'resumed': sorted(resumed), 'originalPayloadsPreserved': True, 'checksumEntries': len(checks), 'checksumReplaced': replaced}))
