import os
import tempfile
import unittest


class TempData(unittest.TestCase):
    """Each test gets its own data folder, so a fresh secret and database."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._old = os.environ.get("HACKU_DATA_DIR")
        os.environ["HACKU_DATA_DIR"] = self._dir.name

    def tearDown(self):
        if self._old is None:
            os.environ.pop("HACKU_DATA_DIR", None)
        else:
            os.environ["HACKU_DATA_DIR"] = self._old
        self._dir.cleanup()
