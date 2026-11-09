"""Original local upload sources; hashes bind published bytes, not currentness."""
import hashlib
import os
from pathlib import Path
import stat


def file_revision(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def parent_revision(path):
    value = path.lstat()
    assert stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode), f'Upload parent is not an ordinary directory: {path}'
    # Child creation is expected; it must not retire the actual directory owner.
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid)


class RetainedReleaseAsset:
    """One original FD/pin retained until all actual publication I/O completes.

    The trusted release job owns these directories. Before/after checks detect
    source replacement while gh reads a pathname; the final GitHub digest check
    independently refuses any uploaded bytes other than this original pin.
    """
    def __init__(self, path):
        self.path = Path(os.path.abspath(path))
        self.stream = None
        self.parents = []
        parent = self.path.parent
        while True:
            self.parents.append((parent, parent_revision(parent)))
            if parent == parent.parent:
                break
            parent = parent.parent
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                self.stream = os.fdopen(fd, 'rb')
            except BaseException:
                os.close(fd)
                raise
            observed = os.fstat(self.stream.fileno())
            assert stat.S_ISREG(observed.st_mode), f'Upload source is not an ordinary file: {self.path}'
            self.revision = file_revision(observed)
            os.set_blocking(self.stream.fileno(), True)
            self.assert_current()
            # The sole local hash produces the release integrity pin sent to
            # metadata validation and compared to GitHub's actual asset digest.
            self.digest = hashlib.file_digest(self.stream, 'sha256').hexdigest()
            self.size = observed.st_size
            self.assert_current()
        except BaseException:
            self.close()
            raise

    @property
    def pin(self):
        return {'sha256': self.digest, 'size': self.size}

    def assert_current(self):
        for path, original in self.parents:
            assert parent_revision(path) == original, f'Upload parent changed: {path}'
        assert self.stream is not None and not self.stream.closed, 'Upload source descriptor is closed'
        assert file_revision(os.fstat(self.stream.fileno())) == self.revision, f'Upload descriptor changed: {self.path}'
        assert file_revision(self.path.lstat()) == self.revision, f'Upload source changed: {self.path}'
        for path, original in self.parents:
            assert parent_revision(path) == original, f'Upload parent changed: {path}'

    def read_metadata(self):
        self.assert_current()
        assert self.size <= 128 * 1024, f'Oversized release metadata: {self.path.name}'
        # Read the already pinned original descriptor, never a newly resolved
        # pathname, and never rehash it just to detect a local file change.
        self.stream.seek(0)
        raw = self.stream.read(self.size + 1)
        assert len(raw) == self.size, f'Upload metadata changed: {self.path}'
        self.assert_current()
        return raw

    def close(self):
        if self.stream is not None:
            self.stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
