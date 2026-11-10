"""Unrun regression source for actual release merge/publication pin selection."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from release_asset_pins import resume_existing_assets, stage_release_assets, validate_reader_assets
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('merge_suite_assets', Path(__file__).with_name('merge-suite-release-assets.py'))
merger = module_from_spec(spec)
spec.loader.exec_module(merger)
SOURCE = 'a' * 40


def pin(value):
    return {'sha256': hashlib.sha256(value).hexdigest(), 'size': len(value)}


def reader_payloads(binary=b'original'):
    asset = 'goodvibes-linux-x64'
    return {asset: binary, asset + '.bun': b'runtime', asset + '.bun.LICENSE.md': b'license', asset + '.bun.json': b'owner'}


def reader(binary=b'original'):
    asset = 'goodvibes-linux-x64'
    payloads = reader_payloads(binary)
    value = {'schema': 1, 'packageName': '@goodvibes-jev/tui', 'version': '3.1.2', 'target': 'linux-x64',
             'sourceCommit': SOURCE, 'sourceTree': 'b' * 40, 'headCommit': SOURCE,
             'readers': {'schema': 1, 'version': '3.1.2', 'formats': []},
             'files': [{'path': name, **pin(data), 'mode': 0o755 if name == asset or name == asset + '.bun' else 0o644} for name, data in payloads.items()]}
    name = asset + '.reader-ci-artifact.json'
    return payloads, name, json.dumps(value).encode()


class ReleasePinSelection(unittest.TestCase):
    def test_merge_hashes_only_fixed_reader_members_and_still_refuses_changed_required_bytes(self):
        payloads, name, metadata = reader()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, incoming = root / 'ci', root / 'suite'
            old.mkdir()
            incoming.mkdir()
            for asset, data in {**payloads, name: metadata}.items():
                (old / asset).write_bytes(data)
            unrelated = old / 'goodvibes-webui.tar.gz'
            unrelated.write_bytes(b'already admitted unrelated archive')
            original_open, original_digest = Path.open, hashlib.file_digest
            hashed = []

            def open_selected(path, *args, **kwargs):
                self.assertNotEqual(path, unrelated, 'Local merge must not read an unrelated admitted archive')
                return original_open(path, *args, **kwargs)

            def digest_selected(stream, algorithm):
                hashed.append(Path(stream.name).name)
                return original_digest(stream, algorithm)

            with patch.object(Path, 'open', open_selected), patch.object(hashlib, 'file_digest', digest_selected):
                merger.merge(old, incoming, 'v3.1.2', SOURCE)
                self.assertCountEqual(hashed, payloads)
                hashed.clear()
                (old / 'goodvibes-linux-x64').write_bytes(b'changed after the independent reader expectation')
                with self.assertRaisesRegex(AssertionError, 'selected published bytes'):
                    merger.merge(old, incoming, 'v3.1.2', SOURCE)
                self.assertIn('goodvibes-linux-x64', hashed)

    def test_missing_program_evidence_refuses_publication(self):
        payloads = reader_payloads()
        with self.assertRaisesRegex(AssertionError, 'no reader evidence'):
            # The actual precondition refuses a selected program lacking its
            # reader before any member pin can be inspected. Only names are
            # relevant here; no discarded descriptor or fixture digest.
            validate_reader_assets({name: {} for name in payloads}, {}, 'v3.1.2', SOURCE)

    def test_ci_winning_bytes_cannot_receive_rebuilt_coordinator_metadata(self):
        original = reader_payloads()
        name = 'goodvibes-linux-x64.reader-ci-artifact.json'
        _, _, incompatible = reader(b'different rebuild')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, incoming = root / 'ci', root / 'suite'
            old.mkdir()
            incoming.mkdir()
            for asset, data in original.items():
                (old / asset).write_bytes(data)
            (incoming / name).write_bytes(incompatible)
            with self.assertRaisesRegex(AssertionError, 'selected published bytes'):
                merger.merge(old, incoming, 'v3.1.2', SOURCE)
            self.assertFalse((old / name).exists())
            self.assertEqual((old / 'goodvibes-linux-x64').read_bytes(), b'original')

    def test_compatible_missing_metadata_is_added_without_replacing_original_bytes(self):
        payloads, name, metadata = reader()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, incoming = root / 'ci', root / 'suite'
            old.mkdir()
            incoming.mkdir()
            for asset, data in payloads.items():
                (old / asset).write_bytes(data)
            (incoming / name).write_bytes(metadata)
            merger.merge(old, incoming, 'v3.1.2', SOURCE)
            self.assertEqual((old / name).read_bytes(), metadata)
            self.assertEqual((old / 'goodvibes-linux-x64').read_bytes(), b'original')

    def test_existing_ci_metadata_and_complete_cohort_win_together(self):
        payloads, name, metadata = reader()
        rebuilt = reader_payloads(b'not selected')
        # The merge must preserve the entire admitted CI cohort, including
        # its original metadata. An unselected coordinator descriptor need
        # not be parsed or furnished with independently computed body pins.
        rebuilt_metadata = b'unselected coordinator metadata'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, incoming = root / 'ci', root / 'suite'
            old.mkdir()
            incoming.mkdir()
            for asset, data in {**payloads, name: metadata}.items():
                (old / asset).write_bytes(data)
            for asset, data in {**rebuilt, name: rebuilt_metadata}.items():
                (incoming / asset).write_bytes(data)
            merger.merge(old, incoming, 'v3.1.2', SOURCE)
            self.assertEqual((old / name).read_bytes(), metadata)
            self.assertEqual((old / 'goodvibes-linux-x64').read_bytes(), b'original')

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
