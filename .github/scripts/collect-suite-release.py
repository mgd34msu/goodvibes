"""Admit flat, hashed same-source release assets from native publisher jobs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

archives, destination, tag = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?', tag)
repository = 'mgd34msu/goodvibes'
def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{repository}/{path}'], text=True))
ref = api(f'git/ref/tags/{tag}')['object']
while ref['type'] == 'tag':
    ref = api(f'git/tags/{ref["sha"]}')['object']
assert ref['type'] == 'commit'
source = ref['sha']
assert re.fullmatch(r'[a-f0-9]{40}', source), 'Release source must be one commit ID'
destination.mkdir(parents=True, exist_ok=False)
targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
for target in targets:
    found = list(archives.rglob(f'suite-{target}.tgz'))
    assert len(found) == 1, target
    with tarfile.open(found[0], 'r:gz') as archive:
        members = [m for m in archive.getmembers() if m.isfile()]
        assert all(m.isfile() or m.isdir() for m in archive.getmembers())
        names = [m.name.removeprefix('./') for m in members]
        assert len(names) == len(set(names))
        assert all(re.fullmatch(r'[A-Za-z0-9_.-]+', n) for n in names)
        metadata_name = f'suite-release-source-{target}.json'
        metadata = json.load(archive.extractfile(members[names.index(metadata_name)]))
        assert metadata['sourceCommit'] == source and metadata['tag'] == tag and metadata['target'] == target
        assert set(names) == set(metadata['files']) | {metadata_name}
        for member, name in zip(members, names):
            assert 0 <= member.size <= 512 * 1024 * 1024
            payload = archive.extractfile(member).read()
            if name == metadata_name:
                continue
            expected = metadata['files'][name]
            assert len(payload) == expected['size'] and hashlib.sha256(payload).hexdigest() == expected['sha256']
            target_file = destination / name
            if target_file.exists():
                assert target_file.read_bytes() == payload, name
            else:
                target_file.write_bytes(payload)
        print(json.dumps({'target': target, 'tag': tag, 'sourceCommit': source, 'admittedFiles': len(metadata['files'])}))
# Expose the exact tag commit already used for every admitted target only after
# the complete collection succeeds. A failed/mixed collection grants no output.
if output := os.environ.get('GITHUB_OUTPUT'):
    with open(output, 'a', encoding='utf-8') as stream:
        stream.write(f'source={source}\n')
