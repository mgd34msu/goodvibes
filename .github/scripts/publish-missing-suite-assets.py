"""Complete an existing release, retaining every previously published payload."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

directory, tag = Path(sys.argv[1]), sys.argv[2]
repo = 'mgd34msu/goodvibes-jev'
release = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))
assert not release['draft'] and release['tag_name'] == tag
assets = {a['name']: a for a in release['assets']}
assert len(assets) == len(release['assets'])
with tempfile.TemporaryDirectory(prefix='goodvibes-release-completion-') as temporary:
    temporary = Path(temporary)
    subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', 'SHA256SUMS.txt', '--dir', str(temporary)], check=True)
    checks = {}
    for line in (temporary / 'SHA256SUMS.txt').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
        assert match and match[2] not in checks
        checks[match[2]] = match[1]
    assert set(assets) == set(checks) | {'SHA256SUMS.txt'}
    for name, digest in checks.items():
        assert assets[name]['digest'] == 'sha256:' + digest, name
    added = []
    for path in sorted(directory.iterdir()):
        assert path.is_file() and not path.is_symlink()
        if path.name in assets:
            continue
        digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
        subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo, str(path)], check=True)
        checks[path.name] = digest
        added.append(path.name)
    checksum = temporary / 'SHA256SUMS.txt'
    checksum.write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(checks.items())))
    subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo, str(checksum), '--clobber'], check=True)
    print(json.dumps({'tag': tag, 'added': added, 'originalPayloadsPreserved': True, 'checksumEntries': len(checks)}))
