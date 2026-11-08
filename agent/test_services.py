import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch


path = pathlib.Path(__file__).with_name("statofact-agent.py")
spec = importlib.util.spec_from_file_location("statofact_agent", path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class ServiceCollectionTests(unittest.TestCase):
    @patch.object(agent.shutil, "which", return_value=None)
    def test_missing_dpkg_does_not_report_empty_inventory(self, which):
        self.assertIsNone(agent.collect_deb_packages())

    @patch.object(agent, "collect_services", return_value=[])
    @patch.object(agent, "collect_packages", return_value=(None, None))
    @patch.object(agent, "interfaces", return_value=[])
    @patch.object(agent, "default_route", return_value=("", ""))
    @patch.object(agent, "dns_servers", return_value=[])
    def test_collect_omits_unavailable_package_inventory(self, dns, route, interfaces, packages, services):
        report = agent.collect("test-host")
        self.assertNotIn("packages", report)
        self.assertEqual(report["services"], [])
        services.assert_called_once_with([], None)

    @patch.object(agent.subprocess, "run")
    def test_rpm_inventory_multiple_versions_and_key(self, run):
        run.return_value = subprocess.CompletedProcess(
            [], 0, "kernel\t0:1-1.fc45\tx86_64\n"
                   "kernel\t0:2-1.fc45\tx86_64\n"
                   "gpg-pubkey\t0:abc-def\t(none)\n"
                   "libcom_err\t0:9-1\tnoarch\n", "",
        )
        packages = agent.collect_rpm_packages()
        kernel = next(pkg for pkg in packages if pkg["name"] == "kernel")
        self.assertEqual(kernel["version"], "0:1-1.fc45, 0:2-1.fc45")
        self.assertNotIn("depends", kernel)
        self.assertEqual(len(packages), 2)

    @patch.object(agent.subprocess, "run")
    def test_rpm_inventory_failure_does_not_send_empty_report(self, run):
        run.side_effect = subprocess.CalledProcessError(1, ["rpm"])
        with self.assertRaisesRegex(RuntimeError, "RPM-Paketinventur"):
            agent.collect_rpm_packages()

    @patch.object(agent.subprocess, "run")
    def test_rpm_owner_matches_architecture(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "openssh-server\tx86_64\n", "")
        installed = {"openssh-server": [{"name": "openssh-server", "architecture": "x86_64"}]}
        self.assertEqual(agent.owning_packages("/usr/sbin/sshd", installed, "rpm"),
                         {("openssh-server", "x86_64")})

    @patch.object(agent.subprocess, "run")
    def test_rpm_owner_errors_are_not_silenced(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, "", "error: rpm database unavailable")
        with self.assertRaisesRegex(RuntimeError, "Paketzuordnung"):
            agent.owning_packages("/usr/sbin/sshd", {}, "rpm")

    def test_address_formats(self):
        self.assertEqual(agent.socket_address("127.0.0.1:22"), ("127.0.0.1", 22))
        self.assertEqual(agent.socket_address("[fe80::1]%eth0:5353"), ("fe80::1%eth0", 5353))
        self.assertEqual(agent.socket_address("*:80"), ("*", 80))
        with self.assertRaises(RuntimeError):
            agent.socket_address("127.0.0.1:*")

    @patch.object(agent.os, "geteuid", return_value=0, create=True)
    @patch.object(agent.os, "readlink", return_value="/usr/sbin/sshd")
    @patch.object(agent, "read", return_value="0::/system.slice/ssh.service")
    @patch.object(agent, "owning_packages", return_value={("openssh-server", "amd64")})
    @patch.object(agent.subprocess, "run")
    def test_service_bindings_and_package(self, run, owning, read, readlink, geteuid):
        run.return_value = subprocess.CompletedProcess(
            [], 0,
            'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=10,fd=6))\n'
            'tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=10,fd=7))\n'
            'udp UNCONN 0 0 127.0.0.1:53 0.0.0.0:*\n',
            "",
        )
        report = agent.collect_services([{"name": "openssh-server", "architecture": "amd64"}])
        service = next(item for item in report if item["key"] == "ssh.service")
        self.assertEqual(len(service["bindings"]), 2)
        self.assertEqual(service["packages"], [{"name": "openssh-server", "architecture": "amd64"}])
        self.assertEqual(service["executables"], ["/usr/sbin/sshd"])
        self.assertTrue(any(item["key"].startswith("unbekannt-udp-") for item in report))
        owning.assert_called_once()

    @patch.object(agent.os, "geteuid", return_value=0, create=True)
    @patch.object(agent.subprocess, "run")
    def test_incomplete_ss_fails(self, run, geteuid):
        run.return_value = subprocess.CompletedProcess([], 0, "", "permission denied")
        with self.assertRaisesRegex(RuntimeError, "unvollständige"):
            agent.collect_services([])

    @patch.object(agent.os, "geteuid", return_value=1000, create=True)
    def test_non_root_omits_inventory(self, geteuid):
        self.assertIsNone(agent.collect_services([]))

    @patch.object(agent.os, "geteuid", None, create=True)
    def test_platform_without_geteuid_omits_service_inventory(self):
        self.assertFalse(agent.is_root())
        self.assertIsNone(agent.collect_services([]))

    @patch.object(agent.subprocess, "run")
    def test_debian_owner_includes_qualified_architecture(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "test:amd64: /usr/bin/test\n", "")
        installed = {"test": [{"name": "test", "architecture": "amd64"}, {"name": "test", "architecture": "arm64"}]}
        self.assertEqual(agent.owning_packages("/usr/bin/test", installed), {("test", "amd64")})


if __name__ == "__main__":
    unittest.main()
