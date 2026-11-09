"""Retain admitted CI bytes, then add only metadata-consistent suite assets."""
import hashlib
from pathlib import Path
import re
import shutil
import sys
from release_asset_pins import needs_metadata, validate_reader_assets


def inventory(directory):
    result = {}
    for path in directory.iterdir():
        assert re.fullmatch(r'[A-Za-z0-9_.-]+', path.name) and path.is_file() and not path.is_symlink(), 'Invalid staged asset'
        result[path.name] = path
    return result


def merge(original, incoming, tag, source):
    assert re.fullmatch(r'[0-9a-f]{40}', source), 'Invalid release source'
    existing, additions = inventory(original), inventory(incoming)
    selected = {**additions, **existing}  # Existing CI-admitted bytes win.
    pins, metadata, observations = {}, {}, {}
    for name, path in selected.items():
        before = path.stat()
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert path.stat() == before, f'Staged source changed: {name}'
        pins[name] = {'sha256': digest, 'size': before.st_size}
        observations[name] = before
        if needs_metadata(name):
            assert before.st_size <= 128 * 1024, f'Oversized release metadata: {name}'
            metadata[name] = path.read_bytes()
    # Validate the actual winning binary/libraries, never coordinator metadata
    # against coordinator bytes that publication will subsequently overwrite.
    validate_reader_assets(pins, metadata, tag, source)
    for name in sorted(additions.keys() - existing.keys()):
        path = selected[name]
        assert path.stat() == observations[name], f'Addition changed before copy: {name}'
        with path.open('rb') as source_file, (original / name).open('xb') as output:
            shutil.copyfileobj(source_file, output)
        assert path.stat() == observations[name], f'Addition changed while copying: {name}'
    return len(selected)


if __name__ == '__main__':
    assert len(sys.argv) == 5, 'Usage: merge-suite-release-assets.py <CI assets> <suite assets> <tag> <source SHA>'
    print(merge(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]))
