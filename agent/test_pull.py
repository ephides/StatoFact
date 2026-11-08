import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import mock_open, patch

path = pathlib.Path(__file__).with_name("statofact-agent.py")
spec = importlib.util.spec_from_file_location("statofact_agent_pull", path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class PassiveAgentTests(unittest.TestCase):
    def test_pull_config_requires_passive_and_reads_name(self):
        config = 'STATOFACT_MODE=passive\nSTATOFACT_NAME="Test host"\nSTATOFACT_TOKEN=secret\n'
        with patch("builtins.open", mock_open(read_data=config)):
            self.assertEqual(agent.read_pull_config()["STATOFACT_NAME"], "Test host")
        for config in ("", "STATOFACT_MODE=active\n"):
            with self.subTest(config=config), patch("builtins.open", mock_open(read_data=config)):
                with self.assertRaisesRegex(RuntimeError, "passiven Modus"):
                    agent.read_pull_config()

    def test_rejects_bad_config_and_missing_file(self):
        with patch("builtins.open", mock_open(read_data="STATOFACT_MODE=passive\nSTATOFACT_MODE=active\n")):
            with self.assertRaisesRegex(RuntimeError, "mehrfach"):
                agent.read_pull_config()
        with patch("builtins.open", side_effect=OSError("missing")):
            with self.assertRaisesRegex(RuntimeError, "nicht lesbar"):
                agent.read_pull_config()

    @patch.object(agent, "collect", return_value={"type": "Device", "name": "test"})
    @patch.object(agent, "read_pull_config", return_value={"STATOFACT_NAME": "test"})
    @patch.object(agent.os, "geteuid", return_value=0, create=True)
    def test_pull_outputs_only_json(self, geteuid, config, collect):
        output = io.StringIO()
        with patch.object(agent.sys, "argv", ["agent", "--pull"]), contextlib.redirect_stdout(output):
            self.assertEqual(agent.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"type": "Device", "name": "test"})
        collect.assert_called_once_with("test")

    @patch.object(agent, "collect")
    def test_passive_does_not_push_or_collect(self, collect):
        with patch.dict(agent.os.environ, {"STATOFACT_MODE": "passive"}, clear=True):
            with patch.object(agent.sys, "argv", ["agent"]), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(agent.main(), 0)
        collect.assert_not_called()

    @patch.object(agent, "collect", return_value={"type": "Device", "name": "test"})
    @patch.object(agent.urllib.request, "urlopen")
    def test_active_mode_posts_report(self, urlopen, collect):
        response = io.BytesIO(b'{"type":"Device","name":"test","result":"updated"}')
        urlopen.return_value.__enter__.return_value = response
        environment = {"STATOFACT_URL": "http://localhost:3000", "STATOFACT_TOKEN": "test-token"}
        with patch.dict(agent.os.environ, environment, clear=True):
            with patch.object(agent.sys, "argv", ["agent"]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(agent.main(), 0)
        collect.assert_called_once_with(None)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:3000/api/agent/report")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(json.loads(request.data), {"type": "Device", "name": "test"})

    @patch.object(agent.os, "geteuid", return_value=1000, create=True)
    def test_pull_requires_root(self, geteuid):
        with patch.object(agent.sys, "argv", ["agent", "--pull"]), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(agent.main(), 1)

    @patch.object(agent.os, "geteuid", None, create=True)
    def test_pull_without_geteuid_reports_missing_root_privileges(self):
        error = io.StringIO()
        with patch.object(agent.sys, "argv", ["agent", "--pull"]), contextlib.redirect_stderr(error):
            self.assertEqual(agent.main(), 1)
        self.assertIn("Root-Rechte", error.getvalue())


if __name__ == "__main__":
    unittest.main()
