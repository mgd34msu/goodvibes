"""Physical upload source retention: the original file and its parents are pinned once and any replacement or rewrite is refused."""
import hashlib
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from release_asset_sources import RetainedReleaseAsset, file_revision


class ReleaseOriginalSource(unittest.TestCase):
    def test_initial_integrity_pin_is_reused_for_metadata_and_later_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'metadata.json'
            raw = b'{"original":true}'
            path.write_bytes(raw)
            with patch('release_asset_sources.hashlib.file_digest', wraps=hashlib.file_digest) as digest:
                with RetainedReleaseAsset(path) as original:
                    self.assertEqual(original.pin, {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw)})
                    self.assertEqual(original.read_metadata(), raw)
                    for _ in range(5):
                        original.assert_current()
                    digest.assert_called_once()
                self.assertTrue(original.stream.closed)

    def test_every_mutation_field_changes_the_revision_but_access_time_does_not(self):
        fields = dict(st_dev=1, st_ino=2, st_mode=0o100644, st_uid=3, st_gid=4, st_nlink=1, st_size=8, st_mtime_ns=5, st_ctime_ns=6, st_atime_ns=7)
        base = file_revision(types.SimpleNamespace(**fields))
        for field in [name for name in fields if name != 'st_atime_ns']:
            with self.subTest(field):
                self.assertNotEqual(file_revision(types.SimpleNamespace(**{**fields, field: fields[field] + 1})), base)
        self.assertEqual(file_revision(types.SimpleNamespace(**{**fields, 'st_atime_ns': 99})), base)

    def test_same_bytes_under_a_replacement_filename_do_not_replace_original_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'program'
            path.write_bytes(b'original')
            with RetainedReleaseAsset(path) as original:
                foreign = Path(temporary) / 'foreign'
                foreign.write_bytes(b'original')
                foreign.replace(path)
                with self.assertRaisesRegex(AssertionError, 'changed'):
                    original.assert_current()
                self.assertEqual(path.read_bytes(), b'original')

    def test_same_size_in_place_rewrite_with_restored_mtime_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'program'
            path.write_bytes(b'original')
            with RetainedReleaseAsset(path) as original:
                before = path.stat()
                # A coarse kernel clock can stamp the rewrite with the same change time as the
                # original; rewrite until the change time is observably different.
                for _ in range(200_000):
                    path.write_bytes(b'foreign!')
                    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
                    if path.stat().st_ctime_ns != before.st_ctime_ns:
                        break
                else:
                    self.fail('the change time never moved')
                self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
                with self.assertRaisesRegex(AssertionError, 'changed'):
                    original.assert_current()

    def test_original_parent_replacement_is_refused_even_for_the_original_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / 'selected'
            directory.mkdir()
            path = directory / 'program'
            path.write_bytes(b'original')
            with RetainedReleaseAsset(path) as original:
                retired = root / 'retired'
                directory.rename(retired)
                directory.mkdir()
                # A hardlink preserves the leaf inode; the physical parent is
                # still retired and must never become an accepted alias.
                os.link(retired / 'program', path)
                with self.assertRaisesRegex(AssertionError, 'parent changed'):
                    original.assert_current()
                self.assertEqual((retired / 'program').read_bytes(), b'original')

    def test_owned_sibling_creation_does_not_revoke_original_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'program'
            path.write_bytes(b'original')
            with RetainedReleaseAsset(path) as original:
                (root / 'another-upload').write_bytes(b'sibling')
                original.assert_current()

    def test_symlink_and_non_regular_payloads_are_refused_without_blocking(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'program'
            path.write_bytes(b'original')
            alias = root / 'alias'
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                RetainedReleaseAsset(alias)
            pipe = root / 'pipe'
            os.mkfifo(pipe)
            with self.assertRaisesRegex(AssertionError, 'ordinary file'):
                RetainedReleaseAsset(pipe)

    def test_context_closes_original_descriptor_when_upload_raises(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'program'
            path.write_bytes(b'original')
            with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                with RetainedReleaseAsset(path) as original:
                    raise RuntimeError('upload failed')
            self.assertTrue(original.stream.closed)


if __name__ == '__main__':
    unittest.main()
