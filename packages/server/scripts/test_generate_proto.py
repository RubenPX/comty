import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class ProtoGenerationTests(unittest.TestCase):
    def test_compatibility_entry_point_emits_only_server_client_api(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'comty.proto'
            result = subprocess.run(['python3', str(ROOT / 'scripts/generate_proto.py'), '--out', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            text = output.read_text()
            self.assertIn('service AuthService', text)
            self.assertIn('WS channel:send', text)
            self.assertNotIn('message DbUser', text)
            self.assertNotIn('service SfuIpcService', text)

if __name__ == '__main__':
    unittest.main()
