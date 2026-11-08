import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import mock_open, patch


path = pathlib.Path(__file__).with_name("statofact-agent-windows.py")
spec = importlib.util.spec_from_file_location("statofact_agent_windows", path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def sample_system(**overrides):
    system = {
        "os": "Microsoft Windows Server 2025 Datacenter",
        "osVersion": "10.0.26100",
        "osArchitecture": "64-bit",
        "computerName": "WIN-SERVER-01",
        "manufacturer": "Contoso",
        "model": "Rack Server",
        "serialNumber": "123456",
        "vcpu": 8,
        "ramBytes": 16 * 1024**3,
        "disks": [500 * 1024**3],
        "gateway": "192.168.10.1",
        "gatewayInterface": 12,
        "dns": ["192.168.10.10", "2001:db8::53", "invalid"],
        "adapters": [
            {
                "name": "Ethernet 2",
                "mac": "00-11-22-33-44-55",
                "state": "Up",
                "speed": 1_000_000_000,
                "ifIndex": 12,
                "addresses": [
                    {"ip": "192.168.10.25", "prefix": 24},
                    {"ip": "192.168.10.26", "prefix": 24},
                    {"ip": "fe80::1234%12", "prefix": 64},
                ],
            },
            {
                "name": "Ethernet 2",
                "mac": "00-11-22-33-44-66",
                "state": "Down",
                "speed": 0,
                "ifIndex": 8,
                "addresses": [{"ip": "127.0.0.1", "prefix": 8}],
            },
        ],
        "packages": [
            {"name": "Contoso Tool", "version": "1.0", "architecture": "x64"},
            {"name": "Contoso Tool", "version": "2.0", "architecture": "x64"},
            {"name": "Contoso Tool", "version": "1.0", "architecture": "x86"},
        ],
    }
    system.update(overrides)
    return system


class WindowsAgentTests(unittest.TestCase):
    def test_collects_device_hardware_network_and_software(self):
        report = agent.collect(system=sample_system())
        self.assertEqual(report["type"], "Device")
        self.assertEqual(report["name"], "WIN-SERVER-01")
        self.assertEqual(report["managementIp"], "192.168.10.25")
        self.assertEqual(report["network"]["gateway"], "192.168.10.1")
        self.assertEqual(report["network"]["dns"], ["192.168.10.10", "2001:db8::53"])
        self.assertEqual(report["network"]["interfaces"][0]["name"], "Ethernet-2")
        self.assertEqual(report["network"]["interfaces"][1]["name"], "Ethernet-2-2")
        self.assertEqual(report["network"]["interfaces"][0]["speedMbps"], 1000)
        self.assertEqual(report["network"]["interfaces"][0]["mac"], "00:11:22:33:44:55")
        self.assertEqual(
            report["packages"],
            [
                {"name": "contoso-tool", "version": "1.0, 2.0", "architecture": "x64"},
                {"name": "contoso-tool", "version": "1.0", "architecture": "x86"},
            ],
        )
        self.assertEqual(report["vendor"], "Contoso")

    def test_detects_virtual_machines_and_computes_resources(self):
        report = agent.collect(system=sample_system(manufacturer="Microsoft Corporation", model="Virtual Machine"))
        self.assertEqual(report["type"], "VirtualMachine")
        self.assertEqual(report["vcpu"], 8)
        self.assertEqual(report["ramGb"], 16)
        self.assertEqual(report["diskGb"], 500)
        self.assertEqual(report["os"], "Microsoft Windows Server 2025 Datacenter 10.0.26100 64-bit")

    def test_name_override_and_unavailable_optional_hardware(self):
        system = sample_system()
        system["serialNumber"] = "To be filled by O.E.M."
        report = agent.collect("CMDB name", system)
        self.assertEqual(report["name"], "CMDB name")
        self.assertNotIn("serialNumber", report)

    def test_rejects_malformed_interfaces_and_package_architectures(self):
        system = sample_system(adapters="invalid")
        with self.assertRaisesRegex(RuntimeError, "Netzwerkschnittstellen"):
            agent.collect(system=system)
        with self.assertRaisesRegex(RuntimeError, "Programm"):
            agent.collect_packages([{"name": "Bad", "version": "1", "architecture": "bad arch"}])

    def test_config_parser_preserves_equals_and_rejects_duplicate_values(self):
        with patch("builtins.open", mock_open(read_data='STATOFACT_TOKEN="one=two"\n')):
            self.assertEqual(agent.read_config("ignored")["STATOFACT_TOKEN"], "one=two")
        with patch("builtins.open", mock_open(read_data="STATOFACT_URL=a\nSTATOFACT_URL=b\n")):
            with self.assertRaisesRegex(RuntimeError, "mehrfach"):
                agent.read_config("ignored")

    @patch.object(agent, "collect", return_value={"type": "Device", "name": "test"})
    def test_dry_run_prints_report_without_sending(self, collect):
        output = io.StringIO()
        with patch.object(agent.sys, "argv", ["agent", "--dry-run"]), contextlib.redirect_stdout(output):
            self.assertEqual(agent.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"type": "Device", "name": "test"})
        collect.assert_called_once_with(None)

    @patch.object(agent, "collect", return_value={"type": "Device", "name": "test"})
    @patch.object(agent.urllib.request, "urlopen")
    def test_active_mode_posts_authenticated_json(self, urlopen, collect):
        urlopen.return_value.__enter__.return_value = io.BytesIO(
            b'{"type":"Device","name":"test","result":"updated","packages":3}'
        )
        output = io.StringIO()
        with patch.dict(
            agent.os.environ,
            {
                "STATOFACT_URL": "https://statofact.example/",
                "STATOFACT_TOKEN": "1234567890123456",
            },
            clear=True,
        ):
            with patch.object(agent.sys, "argv", ["agent"]), contextlib.redirect_stdout(output):
                self.assertEqual(agent.main(), 0)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://statofact.example/api/agent/report")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer 1234567890123456")
        self.assertEqual(json.loads(request.data), {"type": "Device", "name": "test"})
        self.assertIn("3 Softwarepaket(e)", output.getvalue())

    @patch.object(agent, "collect", return_value={"type": "Device", "name": "test"})
    def test_rejects_short_token_before_request(self, collect):
        with patch.dict(
            agent.os.environ,
            {"STATOFACT_URL": "https://statofact.example", "STATOFACT_TOKEN": "short"},
            clear=True,
        ):
            with patch.object(agent.sys, "argv", ["agent"]), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(agent.main(), 2)


if __name__ == "__main__":
    unittest.main()
