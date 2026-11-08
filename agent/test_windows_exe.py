import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import unittest


EXE = os.environ.get("STATOFACT_WINDOWS_EXE")
SERVICE_EXE = os.environ.get("STATOFACT_WINDOWS_SERVICE_EXE")


class ReportHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers["Content-Length"])
        self.server.received = {
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "report": json.loads(self.rfile.read(length)),
        }
        response = json.dumps({"type": "Device", "name": "test", "result": "updated", "packages": 0}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):
        pass


class UnauthorizedHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        response = b'{"error":"Nicht autorisiert."}'
        self.send_response(401)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):
        pass


@unittest.skipUnless(EXE and os.name == "nt", "STATOFACT_WINDOWS_EXE muss auf die Windows-EXE zeigen")
class WindowsExecutableTests(unittest.TestCase):
    def test_dry_run_returns_inventory(self):
        result = subprocess.run([EXE, "--dry-run"], capture_output=True, timeout=120, check=True)
        report = json.loads(result.stdout)
        self.assertIn(report["type"], ("Device", "VirtualMachine"))
        self.assertTrue(report["name"])
        self.assertIsInstance(report["network"]["interfaces"], list)
        self.assertIsInstance(report["packages"], list)

    def test_posts_inventory_to_local_server(self):
        with http.server.HTTPServer(("127.0.0.1", 0), ReportHandler) as server:
            server.timeout = 120
            worker = threading.Thread(target=server.handle_request, daemon=True)
            worker.start()
            env = {
                **os.environ,
                "STATOFACT_URL": f"http://127.0.0.1:{server.server_port}",
                "STATOFACT_TOKEN": "test-token-123456789",
            }
            try:
                result = subprocess.run([EXE], env=env, capture_output=True, timeout=120, check=True)
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive())
                self.assertEqual(server.received["path"], "/api/agent/report")
                self.assertEqual(server.received["authorization"], "Bearer test-token-123456789")
                self.assertTrue(server.received["report"]["name"])
                self.assertIn(b"updated", result.stdout)
            finally:
                if worker.is_alive():
                    server.timeout = 1
                    worker.join(timeout=2)


@unittest.skipUnless(EXE and SERVICE_EXE and os.name == "nt", "Windows-Dienst- und Agent-EXE erforderlich")
class WindowsServiceExecutableTests(unittest.TestCase):
    def test_service_supervisor_posts_with_config_and_ignores_environment_override(self):
        with http.server.HTTPServer(("127.0.0.1", 0), ReportHandler) as server:
            server.timeout = 120
            worker = threading.Thread(target=server.handle_request, daemon=True)
            worker.start()
            with tempfile.TemporaryDirectory() as directory:
                config = pathlib.Path(directory) / "agent.conf"
                config.write_text(
                    f"STATOFACT_URL=http://127.0.0.1:{server.server_port}\n"
                    "STATOFACT_TOKEN=test-token-123456789\n"
                    "STATOFACT_INTERVAL_MINUTES=15\n",
                    encoding="utf-8-sig",
                )
                env = {**os.environ, "STATOFACT_URL": "http://127.0.0.1:1",
                       "STATOFACT_TOKEN": "wrong-token-123456"}
                result = subprocess.run(
                    [SERVICE_EXE, "--once", EXE, str(config)],
                    env=env, capture_output=True, timeout=120, check=True,
                )
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive())
                self.assertEqual(server.received["path"], "/api/agent/report")
                self.assertEqual(server.received["authorization"], "Bearer test-token-123456789")
                self.assertTrue(server.received["report"]["name"])
                self.assertIn(b"updated", result.stdout)

    def test_service_rejects_bad_interval_before_starting_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "agent.conf"
            for value in ("0", "1441", "invalid", "15\nSTATOFACT_INTERVAL_MINUTES=30", ""):
                with self.subTest(value=value):
                    config.write_text(f"STATOFACT_INTERVAL_MINUTES={value}\n", encoding="utf-8")
                    result = subprocess.run([SERVICE_EXE, "--once", EXE, str(config)],
                                            capture_output=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b"STATOFACT_INTERVAL_MINUTES", result.stderr)

    def test_service_reports_http_failure(self):
        with http.server.HTTPServer(("127.0.0.1", 0), UnauthorizedHandler) as server:
            server.timeout = 120
            worker = threading.Thread(target=server.handle_request, daemon=True)
            worker.start()
            with tempfile.TemporaryDirectory() as directory:
                config = pathlib.Path(directory) / "agent.conf"
                config.write_text(
                    f"STATOFACT_URL=http://127.0.0.1:{server.server_port}\n"
                    "STATOFACT_TOKEN=test-token-123456789\n"
                    "STATOFACT_INTERVAL_MINUTES=15\n",
                    encoding="utf-8",
                )
                result = subprocess.run(
                    [SERVICE_EXE, "--once", EXE, str(config)],
                    capture_output=True, timeout=120,
                )
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive())
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"HTTP 401", result.stdout)
