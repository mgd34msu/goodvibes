"""Unrun regression source for actual release merge/publication pin selection."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from release_asset_pins import resume_existing_assets, stage_release_assets, validate_reader_assets
from release_asset_sources import file_revision
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


def reader(binary=b'original', *, expected_pins=True):
    asset = 'goodvibes-linux-x64'
    payloads = reader_payloads(binary)
    # Hash only expectations that the exercised validation actually compares:
    # True selects every member, False none, and a set selects named members.
    def expected_pin(name, data):
        if expected_pins is True or (expected_pins is not False and name in expected_pins):
            return pin(data)
        return {'sha256': '0' * 64, 'size': len(data)}

    value = {'schema': 1, 'packageName': '@goodvibes-jev/tui', 'version': '3.1.2', 'target': 'linux-x64',
             'sourceCommit': SOURCE, 'sourceTree': 'b' * 40, 'headCommit': SOURCE,
             'readers': {'schema': 1, 'version': '3.1.2', 'formats': []},
             'files': [{'path': name, **expected_pin(name, data), 'mode': 0o755 if name == asset or name == asset + '.bun' else 0o644} for name, data in payloads.items()]}
    name = asset + '.reader-ci-artifact.json'
    return payloads, name, json.dumps(value).encode()


class ReleasePinSelection(unittest.TestCase):
    def test_merge_accepts_only_access_time_changes_from_its_own_reads(self):
        payloads, name, metadata = reader()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, incoming = root / 'ci', root / 'suite'
            old.mkdir()
            incoming.mkdir()
            for asset, data in payloads.items():
                (old / asset).write_bytes(data)
            (incoming / name).write_bytes(metadata)
            (incoming / 'browser-driver.tar.gz').write_bytes(b'additional archive')
            original_stat, original_read = Path.stat, Path.read_bytes
            original_digest, original_copy = hashlib.file_digest, merger.shutil.copyfileobj
            accesses, observed = {}, {'metadata': 0, 'digest': 0, 'copy': 0}

            class AccessTimeObservation:
                # Deterministically model a read-updated atime even on noatime
                # mounts. Every identity/content field is the real stat result.
                def __init__(self, value, access):
                    self.value, self.access = value, access

                def __getattr__(self, key):
                    if key == 'st_atime_ns':
                        return self.value.st_atime_ns + self.access
                    if key == 'st_atime':
                        return self.value.st_atime + self.access
                    return getattr(self.value, key)

                def __eq__(self, other):
                    return isinstance(other, AccessTimeObservation) and self.value == other.value and self.access == other.access

            def stat_observed(path, *args, **kwargs):
                return AccessTimeObservation(original_stat(path, *args, **kwargs), accesses.get(path, 0))

            def accessed(path, kind):
                path = Path(path)
                accesses[path] = accesses.get(path, 0) + 1
                observed[kind] += 1

            def read_observed(path):
                result = original_read(path)
                accessed(path, 'metadata')
                return result

            def digest_observed(stream, algorithm):
                result = original_digest(stream, algorithm)
                accessed(stream.name, 'digest')
                return result

            def copy_observed(source, output, *args, **kwargs):
                result = original_copy(source, output, *args, **kwargs)
                accessed(source.name, 'copy')
                return result

            with patch.object(Path, 'stat', stat_observed), patch.object(Path, 'read_bytes', read_observed), \
                    patch.object(hashlib, 'file_digest', digest_observed), patch.object(merger.shutil, 'copyfileobj', copy_observed):
                self.assertEqual(merger.merge(old, incoming, 'v3.1.2', SOURCE), len(payloads) + 2)
            self.assertEqual(observed, {'metadata': 1, 'digest': len(payloads), 'copy': 2})
            self.assertEqual((old / name).read_bytes(), metadata)
            self.assertEqual((old / 'browser-driver.tar.gz').read_bytes(), b'additional archive')

    def test_merge_still_refuses_real_mutations_after_metadata_digest_and_copy(self):
        for phase in ['metadata', 'digest', 'copy']:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                payloads, name, metadata = reader(expected_pins=phase == 'copy')
                root = Path(temporary)
                old, incoming = root / 'ci', root / 'suite'
                old.mkdir()
                incoming.mkdir()
                for asset, data in {**payloads, name: metadata}.items():
                    (old / asset).write_bytes(data)
                addition = incoming / 'browser-driver.tar.gz'
                addition.write_bytes(b'additional archive')
                original_read, original_digest, original_copy = Path.read_bytes, hashlib.file_digest, merger.shutil.copyfileobj
                changes = []

                def read_changed(path):
                    result = original_read(path)
                    if phase == 'metadata' and path.name == name:
                        path.chmod(path.stat().st_mode ^ 0o100)
                        changes.append('metadata')
                    return result

                def digest_changed(stream, algorithm):
                    result = original_digest(stream, algorithm)
                    if phase == 'digest' and Path(stream.name).name == 'goodvibes-linux-x64':
                        path = Path(stream.name)
                        before = path.stat()
                        path.write_bytes(b'foreign!')  # same length; restore mtime
                        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
                        changes.append('digest')
                    return result

                def copy_changed(source, output, *args, **kwargs):
                    result = original_copy(source, output, *args, **kwargs)
                    if phase == 'copy' and Path(source.name) == addition:
                        replacement = incoming / 'replacement'
                        replacement.write_bytes(b'additional archive')
                        replacement.replace(addition)
                        changes.append('copy')
                    return result

                with patch.object(Path, 'read_bytes', read_changed), patch.object(hashlib, 'file_digest', digest_changed), \
                        patch.object(merger.shutil, 'copyfileobj', copy_changed):
                    refusal = {'metadata': f'Staged source changed: {name}',
                               'digest': 'Staged source changed: goodvibes-linux-x64',
                               'copy': 'Addition changed while copying: browser-driver.tar.gz'}[phase]
                    with self.assertRaisesRegex(AssertionError, refusal):
                        merger.merge(old, incoming, 'v3.1.2', SOURCE)
                self.assertEqual(changes, [phase])

    def test_file_revision_preserves_every_mutation_field_except_access_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'program'
            path.write_bytes(b'original')
            before = path.stat()
            self.assertEqual(file_revision(before), (before.st_dev, before.st_ino, before.st_mode,
                before.st_uid, before.st_gid, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns))

    def test_retained_merge_uses_its_complete_tooling_closure_outside_the_tag_checkout(self):
        payloads, name, metadata = reader()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tooling, checkout, old, incoming = (root / child for child in ['tooling', 'tag-checkout', 'ci', 'suite'])
            for directory in [tooling, checkout, old, incoming]:
                directory.mkdir()
            for filename in ['merge-suite-release-assets.py', 'release_asset_pins.py', 'release_asset_sources.py']:
                shutil.copyfile(Path(__file__).with_name(filename), tooling / filename)
            # A different checkout must neither supply nor replace the retained
            # merger's dependency closure after its tag checkout.
            for filename in ['release_asset_pins.py', 'release_asset_sources.py']:
                (checkout / filename).write_text('raise RuntimeError("wrong checkout helper")\n')
            for asset, data in payloads.items():
                (old / asset).write_bytes(data)
            (incoming / name).write_bytes(metadata)
            result = subprocess.run([sys.executable, str(tooling / 'merge-suite-release-assets.py'), str(old),
                str(incoming), 'v3.1.2', SOURCE], cwd=checkout, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.strip(), str(len(payloads) + 1))
            self.assertEqual((old / name).read_bytes(), metadata)
            self.assertEqual((old / 'goodvibes-linux-x64').read_bytes(), b'original')

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
        _, _, incompatible = reader(b'different rebuild', expected_pins={'goodvibes-linux-x64'})
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
