import tempfile
import unittest
from pathlib import Path

from hypervisor_inventory import collect_inventory


class HypervisorInventoryTests(unittest.TestCase):
    def test_virtualbox_registered_including_offline_and_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "VirtualBox.xml").write_text(
                '<VirtualBox xmlns="urn:box"><Global><MachineRegistry>'
                '<MachineEntry uuid="{12345678-1234-1234-1234-123456789abc}" src="vm.vbox"/>'
                '</MachineRegistry></Global></VirtualBox>', encoding="utf-8")
            (root / "vm.vbox").write_text(
                '<VirtualBox xmlns="urn:box"><Machine uuid="{12345678-1234-1234-1234-123456789abc}" '
                'name="Offline VM" OSType="Linux_64"><Hardware><CPU count="2"/><Memory RAMSize="2048"/>'
                '</Hardware><Snapshot><Hardware><CPU count="9"/></Hardware></Snapshot></Machine></VirtualBox>',
                encoding="utf-8")
            vms = collect_inventory({"STATOFACT_VIRTUALBOX_REGISTRY": str(root / "VirtualBox.xml")})
            self.assertEqual(vms, [{"provider": "virtualbox", "id": "12345678-1234-1234-1234-123456789abc",
                                    "name": "Offline VM", "os": "Linux_64", "vcpu": 2, "ramGb": 2}])

    def test_vmware_recursive_uuid_and_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sub").mkdir()
            (root / "sub" / "first.vmx").write_text(
                'displayName = "Server"\nnumvcpus = "4"\nmemsize = "4096"\n'
                'uuid.bios = "12 34 56 78 12 34 12 34-12 34 12 34 56 78 9a bc"\n',
                encoding="utf-8")
            (root / "second.vmx").write_text('config.version = "8"\n', encoding="utf-8")
            vms = collect_inventory({"STATOFACT_VMWARE_DIRECTORY": str(root)})
            by_name = {vm["name"]: vm for vm in vms}
            self.assertEqual(by_name["Server"]["id"], "12345678-1234-1234-1234-123456789abc")
            self.assertEqual(by_name["Server"]["ramGb"], 4)
            self.assertTrue(by_name["second"]["id"].startswith("path-"))
            self.assertEqual(vms, collect_inventory({"STATOFACT_VMWARE_DIRECTORY": str(root)}))

    def test_disabled_missing_invalid_and_duplicate(self):
        self.assertIsNone(collect_inventory({}))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "nicht gefunden"):
                collect_inventory({"STATOFACT_VMWARE_DIRECTORY": str(root / "missing")})
            registry = root / "VirtualBox.xml"
            registry.write_text("<VirtualBox/>", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "registrierung"):
                collect_inventory({"STATOFACT_VIRTUALBOX_REGISTRY": str(registry)})
            vm = 'displayName = "VM"\nuuid.bios = "12345678123412341234123456789abc"\n'
            (root / "one.vmx").write_text(vm, encoding="utf-8")
            (root / "two.vmx").write_text(vm, encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Doppelte"):
                collect_inventory({"STATOFACT_VMWARE_DIRECTORY": str(root)})


if __name__ == "__main__":
    unittest.main()
