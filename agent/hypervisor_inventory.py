"""Read explicitly configured desktop hypervisor inventories without starting VMs."""
import hashlib
import os
import re
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_FILE = 4 * 1024 * 1024
MAX_FILES = 10000
MAX_VMS = 1000


def _read(path):
    try:
        with open(path, "rb") as file:
            data = file.read(MAX_FILE + 1)
    except OSError as error:
        raise RuntimeError(f"VM-Konfiguration nicht lesbar: {path}: {error}") from error
    if len(data) > MAX_FILE:
        raise RuntimeError(f"VM-Konfiguration zu groß: {path}")
    return data


def _xml(path):
    try:
        return ET.fromstring(_read(path))
    except ET.ParseError as error:
        raise RuntimeError(f"Ungültiges VirtualBox-XML: {path}: {error}") from error


def _tag(element):
    return element.tag.rsplit("}", 1)[-1]


def _uuid(value):
    try:
        return str(uuid.UUID(value.strip().strip("{}")))
    except (ValueError, AttributeError) as error:
        raise RuntimeError(f"Ungültige VM-UUID: {value}") from error


def _positive_number(value, name, maximum):
    if not value:
        return None
    try:
        number = int(value)
    except ValueError as error:
        raise RuntimeError(f"Ungültiger VM-Wert {name}: {value}") from error
    if not 1 <= number <= maximum:
        raise RuntimeError(f"VM-Wert {name} außerhalb des zulässigen Bereichs: {number}")
    return number


def _virtualbox(registry):
    registry = Path(registry)
    root = _xml(registry)
    registries = [item for item in root.iter() if _tag(item) == "MachineRegistry"]
    if _tag(root) != "VirtualBox" or len(registries) != 1:
        raise RuntimeError(f"VirtualBox-Maschinenregistrierung fehlt oder ist nicht eindeutig: {registry}")
    entries = [item for item in registries[0] if _tag(item) == "MachineEntry"]
    if len(entries) > MAX_VMS:
        raise RuntimeError("VirtualBox-Registrierung enthält zu viele VMs.")
    result = []
    for entry in entries:
        identifier = _uuid(entry.get("uuid"))
        location = entry.get("src")
        if not location:
            raise RuntimeError("VirtualBox-MachineEntry ohne Konfigurationspfad.")
        path = Path(location)
        if not path.is_absolute():
            path = registry.parent / path
        root = _xml(path)
        machines = [item for item in root.iter() if _tag(item) == "Machine"]
        if len(machines) != 1:
            raise RuntimeError(f"VirtualBox-Konfiguration enthält keine eindeutige VM: {path}")
        machine = machines[0]
        if _uuid(machine.get("uuid")) != identifier:
            raise RuntimeError(f"VirtualBox-UUID widerspricht Registrierung: {path}")
        name = (machine.get("name") or "").strip()
        if not name or len(name) > 200:
            raise RuntimeError(f"Ungültiger VM-Name: {path}")
        report = {"provider": "virtualbox", "id": identifier, "name": name}
        if machine.get("OSType"):
            report["os"] = machine.get("OSType")[:200]
        hardware = next((child for child in machine if _tag(child) == "Hardware"), None)
        if hardware is None:
            raise RuntimeError(f"VirtualBox-Hardwarekonfiguration fehlt: {path}")
        for item in hardware.iter():
            if _tag(item) == "CPU":
                cpus = _positive_number(item.get("count"), "vCPU", 1024)
                if cpus:
                    report["vcpu"] = cpus
            elif _tag(item) == "Memory":
                memory = _positive_number(item.get("RAMSize"), "RAM", 102400000)
                if memory:
                    report["ramGb"] = max(1, round(memory / 1024))
        result.append(report)
    return result


def _vmx(path):
    try:
        text = _read(path).decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"VMX-Datei ist kein UTF-8: {path}") from error
    values = {}
    for line in text.splitlines():
        match = re.match(r'^\s*([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"\s*$', line)
        if match:
            key = match.group(1).lower()
            if key in values:
                raise RuntimeError(f"VMX-Datei enthält {key} mehrfach: {path}")
            values[key] = match.group(2)
    if not any(key in values for key in ("config.version", "virtualhw.version", "displayname")):
        raise RuntimeError(f"Keine gültige VMware-VMX-Konfiguration: {path}")
    name = values.get("displayname", path.stem).strip()
    if not name or len(name) > 200:
        raise RuntimeError(f"Ungültiger VM-Name: {path}")
    raw_uuid = values.get("uuid.bios", "").replace(" ", "").replace("-", "")
    if raw_uuid:
        identifier = _uuid(raw_uuid)
    else:
        canonical = os.path.normcase(os.path.realpath(path))
        identifier = "path-" + hashlib.sha256(os.fsencode(canonical)).hexdigest()
    result = {"provider": "vmware-workstation", "id": identifier, "name": name}
    for key, target, maximum in (("numvcpus", "vcpu", 1024), ("memsize", "ramGb", 102400000)):
        value = _positive_number(values.get(key), key, maximum)
        if value:
            result[target] = max(1, round(value / 1024)) if target == "ramGb" else value
    if values.get("guestos"):
        result["os"] = values["guestos"][:200]
    return result


def collect_inventory(settings):
    registry = settings.get("STATOFACT_VIRTUALBOX_REGISTRY", "").strip()
    directory = settings.get("STATOFACT_VMWARE_DIRECTORY", "").strip()
    if not registry and not directory:
        return None
    result = _virtualbox(registry) if registry else []
    if directory:
        root = Path(directory)
        if not root.is_dir():
            raise RuntimeError(f"VMware-Verzeichnis nicht gefunden: {root}")
        count = 0

        def walk_error(error):
            raise RuntimeError(f"VMware-Verzeichnis nicht lesbar: {error}") from error

        for base, directories, files in os.walk(root, onerror=walk_error, followlinks=False):
            count += len(directories) + len(files)
            if count > MAX_FILES:
                raise RuntimeError("VMware-Verzeichnis enthält mehr als 10000 Einträge.")
            for name in sorted(files):
                if name.lower().endswith(".vmx"):
                    path = Path(base) / name
                    if path.is_symlink():
                        raise RuntimeError(f"Symbolischer Link auf VMX-Datei nicht erlaubt: {path}")
                    result.append(_vmx(path))
                    if len(result) > MAX_VMS:
                        raise RuntimeError("VM-Inventar enthält mehr als 1000 VMs.")
    identities = set()
    for vm in result:
        identity = (vm["provider"], vm["id"])
        if identity in identities:
            raise RuntimeError(f"Doppelte VM-Identität: {vm['provider']} {vm['id']}")
        identities.add(identity)
    return result
