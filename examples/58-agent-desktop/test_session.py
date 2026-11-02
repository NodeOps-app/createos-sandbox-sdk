import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('desktop_session', Path(__file__).with_name('session.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SessionSelectionTest(unittest.TestCase):
    def test_one_session_is_selected(self):
        self.assertEqual(module.select_session([{'DISPLAY': ':0'}]), {'DISPLAY': ':0'})

    def test_no_session_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'No running'):
            module.select_session([])

    def test_multiple_sessions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Multiple'):
            module.select_session([{'DISPLAY': ':0'}, {'DISPLAY': ':1'}])

unittest.main()
