"""Regression coverage for release publication checksum selection."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from release_asset_pins import resume_existing_assets, stage_release_assets, validate_reader_assets
from release_asset_sources import file_revision

SOURCE = 'a' * 40


def pin(value):
    return {'sha256': hashlib.sha256(value).hexdigest(), 'size': len(value)}


def reader_payloads(binary=b'original'):
    asset = 'goodvibes-linux-x64'
    return {asset: binary, asset + '.bun': b'runtime', asset + '.bun.LICENSE.md': b'license', asset + '.bun.json': b'owner'}


class ReleasePinSelection(unittest.TestCase):
    def test_file_revision_preserves_every_mutation_field_except_access_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'program'
            path.write_bytes(b'original')
            before = path.stat()
            self.assertEqual(file_revision(before), (before.st_dev, before.st_ino, before.st_mode,
                before.st_uid, before.st_gid, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns))


    def test_missing_program_evidence_refuses_publication(self):
        payloads = reader_payloads()
        with self.assertRaisesRegex(AssertionError, 'no reader evidence'):
            # The actual precondition refuses a selected program lacking its
            # reader before any member pin can be inspected. Only names are
            # relevant here; no discarded descriptor or fixture digest.
            validate_reader_assets({name: {} for name in payloads}, {}, 'v3.1.2', SOURCE)


    def test_partial_upload_resume_requires_exact_candidate_pin(self):
        candidate = pin(b'published')
        assets = {'companion': {'digest': 'sha256:' + candidate['sha256'], 'size': candidate['size']}, 'SHA256SUMS.txt': {}}
        checks = {}
        self.assertEqual(resume_existing_assets(assets, checks, {'companion': candidate}), ['companion'])
        self.assertEqual(checks, {'companion': candidate['sha256']})
        with self.assertRaisesRegex(AssertionError, 'Unknown partial upload'):
            resume_existing_assets(assets, {}, {'companion': pin(b'other rebuild')})


    def test_partial_upload_without_any_checksum_manifest_can_resume_only_exact_bytes(self):
        candidate = pin(b'published')
        assets = {'program': {'digest': 'sha256:' + candidate['sha256'], 'size': candidate['size']}}
        checks = {}
        self.assertEqual(resume_existing_assets(assets, checks, {'program': candidate}, 'CUSTOM-SUMS.txt'), ['program'])
        self.assertEqual(checks, {'program': candidate['sha256']})

    def test_release_completion_refuses_ambiguous_asset_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / 'first', root / 'second'
            first.mkdir()
            second.mkdir()
            (first / 'program').write_bytes(b'original')
            (second / 'program').write_bytes(b'other')
            stage = root / 'stage'
            with self.assertRaisesRegex(AssertionError, 'Ambiguous release asset basename'):
                stage_release_assets(stage, f'{first}/* {second}/*', 'SHA256SUMS.txt')
            self.assertEqual(list(stage.iterdir()), [])

    def test_release_completion_selects_explicit_candidates_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'program'
            source.write_bytes(b'original')
            stage = root / 'stage'
            self.assertEqual(stage_release_assets(stage, f'{source} {source}', 'SHA256SUMS.txt'), ['program'])
            self.assertEqual((stage / 'program').read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
