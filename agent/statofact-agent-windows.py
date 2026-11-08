#!/usr/bin/env python3
"""Erfasst Windows-Hardware, Netzwerk und installierte Programme für StatoFact.

Konfiguration über Umgebungsvariablen oder eine UTF-8-Datei mit KEY=VALUE:
  STATOFACT_URL    Basis-URL, z. B. https://statofact.example
  STATOFACT_TOKEN  Token (= AGENT_TOKEN des Servers)
  STATOFACT_NAME   optional: CI-Name (Standard: Computername)
"""
import argparse
from hypervisor_inventory import collect_inventory
import base64
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import unicodedata


POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$computer = Get-CimInstance -ClassName Win32_ComputerSystem
$bios = Get-CimInstance -ClassName Win32_BIOS
$disks = @(
  Get-CimInstance -ClassName Win32_DiskDrive |
    Where-Object { $_.Size -gt 0 } |
    ForEach-Object { [long]$_.Size }
)
$adapters = @(
  Get-NetAdapter -IncludeHidden |
    Where-Object {
      $_.Name -and
      $_.InterfaceDescription -notmatch '(?i)loopback|teredo|isatap|tunnel|pseudo'
    } |
    ForEach-Object {
      $adapter = $_
      $addresses = @(
        Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -and $_.PrefixLength -ge 0 } |
          ForEach-Object {
            [pscustomobject]@{
              ip = ([string]$_.IPAddress -replace '%.*$', '')
              prefix = [int]$_.PrefixLength
            }
          }
      )
      [pscustomobject]@{
        name = [string]$adapter.Name
        mac = [string]$adapter.MacAddress
        state = [string]$adapter.Status
        speed = [long]$adapter.Speed
        addresses = $addresses
        ifIndex = [int]$adapter.ifIndex
      }
    }
)
$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric, InterfaceMetric |
  Select-Object -First 1
$dns = @(
  Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
    ForEach-Object { $_.ServerAddresses } |
    Where-Object { $_ } |
    Select-Object -Unique -First 8
)
$architecture = if ($os.OSArchitecture -match '64') { 'x64' } else { 'x86' }
$uninstallPaths = @(
  @{ path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; architecture = $architecture },
  @{ path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; architecture = 'x86' },
  @{ path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; architecture = $architecture }
)
$packages = @(
  foreach ($entry in $uninstallPaths) {
    Get-ItemProperty -Path $entry.path -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName } |
      ForEach-Object {
        [pscustomobject]@{
          name = [string]$_.DisplayName
          version = if ($_.DisplayVersion) { [string]$_.DisplayVersion } else { 'unknown' }
          architecture = $entry.architecture
        }
      }
  }
)
$report = [pscustomobject]@{
  os = [string]$os.Caption
  osVersion = [string]$os.Version
  osArchitecture = [string]$os.OSArchitecture
  computerName = [string]$computer.Name
  manufacturer = [string]$computer.Manufacturer
  model = [string]$computer.Model
  serialNumber = [string]$bios.SerialNumber
  vcpu = [int]$computer.NumberOfLogicalProcessors
  ramBytes = [long]$computer.TotalPhysicalMemory
  disks = $disks
  adapters = $adapters
  gateway = if ($route) { [string]$route.NextHop } else { '' }
  gatewayInterface = if ($route) { [int]$route.ifIndex } else { 0 }
  dns = $dns
  packages = $packages
}
$json = ConvertTo-Json -InputObject $report -Depth 8 -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
"""

def powershell_executable():
    if os.name != "nt":
        raise RuntimeError("Der Windows-Agent kann nur unter Windows ausgeführt werden.")
    for executable in ("powershell.exe", "pwsh.exe"):
        try:
            result = subprocess.run(
                ["where.exe", executable],
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return executable
    raise RuntimeError("PowerShell wurde nicht gefunden.")


def run_powershell():
    executable = powershell_executable()
    try:
        result = subprocess.run(
            [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
            capture_output=True,
            timeout=90,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Die Windows-Inventur hat das Zeitlimit überschritten.") from error
    except OSError as error:
        raise RuntimeError(f"PowerShell konnte nicht gestartet werden: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[:300]
        raise RuntimeError(f"PowerShell-Inventur fehlgeschlagen: {detail or result.returncode}")
    try:
        encoded = result.stdout.decode("ascii").strip()
        return json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("PowerShell lieferte keine gültigen Inventurdaten.") from error


def clean_text(value, limit=200):
    return str(value or "").strip()[:limit]


def interface_name(value, used):
    name = re.sub(r"[^A-Za-z0-9_.:@-]+", "-", str(value)).strip("-") or "Adapter"
    name = name[:32]
    base = name
    suffix = 2
    while name.lower() in used:
        tail = f"-{suffix}"
        name = f"{base[:32 - len(tail)]}{tail}"
        suffix += 1
    used.add(name.lower())
    return name


def normalized_package_name(value):
    ascii_name = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9+._-]+", "-", ascii_name.lower()).strip("-._+")
    if not slug or not slug[0].isalnum():
        return ""
    if len(slug) > 200:
        digest = hashlib.sha256(slug.encode("ascii")).hexdigest()[:12]
        slug = f"{slug[:187].rstrip('-._+')}-{digest}"
    return slug


def collect_packages(entries):
    if not isinstance(entries, list):
        raise RuntimeError("PowerShell lieferte kein gültiges Softwareinventar.")
    if len(entries) > 20_000:
        raise RuntimeError(f"{len(entries)} Programme erkannt; die Registry-Ausgabe ist unerwartet groß.")

    collected = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("PowerShell lieferte einen ungültigen Softwareeintrag.")
        name = normalized_package_name(entry.get("name", ""))
        version = str(entry.get("version") or "").strip()
        if len(version) > 200:
            raise RuntimeError(f"Die Programmversion von {name} überschreitet 200 Zeichen.")
        architecture = clean_text(entry.get("architecture"), 64).lower()
        if not name or not version:
            continue
        if not re.fullmatch(r"[a-z0-9][a-z0-9+._-]*", architecture):
            raise RuntimeError(f"Ungültige Programmarchitektur: {architecture!r}")
        key = (name, architecture)
        record = collected.setdefault(key, {"name": name, "architecture": architecture, "versions": []})
        if version not in record["versions"]:
            record["versions"].append(version)

    if len(collected) > 5000:
        raise RuntimeError(f"{len(collected)} Programme erkannt; das Maximum beträgt 5000.")
    for item in collected.values():
        if len(", ".join(sorted(item["versions"]))) > 200:
            raise RuntimeError(f"Die gesammelten Programmversionen von {item['name']} überschreiten 200 Zeichen.")
    return [
        {
            "name": item["name"],
            "version": ", ".join(sorted(item["versions"])),
            "architecture": item["architecture"],
        }
        for _, item in sorted(collected.items())
    ]


def is_relevant_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not address.is_loopback and not address.is_link_local and not address.is_unspecified and not address.is_multicast


def collect(name_override=None, system=None):
    if system is None:
        system = run_powershell()
    if not isinstance(system, dict):
        raise RuntimeError("PowerShell lieferte keine gültigen Systemdaten.")

    hostname = clean_text(system.get("computerName"))
    if not hostname:
        raise RuntimeError("Der Computername konnte nicht ermittelt werden.")

    adapters = system.get("adapters")
    if not isinstance(adapters, list) or len(adapters) > 64:
        raise RuntimeError("Die Netzwerkschnittstellen sind ungültig oder überschreiten das Maximum von 64.")
    used_names = set()
    interfaces = []
    gateway_primary = ""
    fallback_primary = ""
    gateway_interface = system.get("gatewayInterface")
    for adapter in adapters:
        if not isinstance(adapter, dict):
            raise RuntimeError("PowerShell lieferte eine ungültige Netzwerkschnittstelle.")
        name = interface_name(adapter.get("name", ""), used_names)
        addresses = []
        raw_addresses = adapter.get("addresses") or []
        if not isinstance(raw_addresses, list) or len(raw_addresses) > 32:
            raise RuntimeError(f"Ungültige Adressen auf Schnittstelle {name}.")
        for address in raw_addresses:
            if not isinstance(address, dict):
                raise RuntimeError(f"Ungültige Adresse auf Schnittstelle {name}.")
            ip = str(address.get("ip", "")).split("%", 1)[0]
            try:
                parsed = ipaddress.ip_address(ip)
            except ValueError:
                continue
            prefix = address.get("prefix")
            if not isinstance(prefix, int) or not 0 <= prefix <= parsed.max_prefixlen:
                raise RuntimeError(f"Ungültiges Präfix auf Schnittstelle {name}.")
            addresses.append({"ip": ip, "prefix": prefix})
            if parsed.version == 4 and is_relevant_address(ip):
                fallback_primary = fallback_primary or ip
                if adapter.get("ifIndex") == gateway_interface:
                    gateway_primary = gateway_primary or ip

        entry = {
            "name": name,
            "state": clean_text(adapter.get("state"), 16).lower(),
            "addresses": addresses,
        }
        mac = str(adapter.get("mac", "")).replace("-", ":").lower()
        if re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", mac) and mac != "00:00:00:00:00:00":
            entry["mac"] = mac
        speed = adapter.get("speed")
        if isinstance(speed, (int, float)) and speed > 0:
            entry["speedMbps"] = min(round(speed / 1_000_000), 10_000_000)
        interfaces.append(entry)

    primary = gateway_primary or fallback_primary
    gateway = clean_text(system.get("gateway"), 64)
    if gateway:
        try:
            ipaddress.ip_address(gateway)
        except ValueError as error:
            raise RuntimeError("Das Standard-Gateway ist keine gültige IP-Adresse.") from error

    dns = system.get("dns") or []
    if not isinstance(dns, list):
        raise RuntimeError("Die DNS-Serverliste ist ungültig.")
    valid_dns = []
    for address in dns:
        try:
            parsed = ipaddress.ip_address(str(address))
        except ValueError:
            continue
        if str(parsed) not in valid_dns:
            valid_dns.append(str(parsed))
    valid_dns = valid_dns[:8]

    os_name = clean_text(system.get("os"))
    os_version = clean_text(system.get("osVersion"))
    os_architecture = clean_text(system.get("osArchitecture"))
    os_label = " ".join(part for part in (os_name, os_version, os_architecture) if part)[:200]
    if not os_label:
        raise RuntimeError("Das Betriebssystem konnte nicht ermittelt werden.")

    manufacturer = clean_text(system.get("manufacturer"))
    model = clean_text(system.get("model"))
    hardware_identity = f"{manufacturer} {model}".lower()
    virtual = bool(re.search(
        r"virtual machine|vmware|virtualbox|kvm|qemu|xen|hyper-v|hvm dom|amazon ec2|google compute|parallels",
        hardware_identity,
    ))
    ci_name = clean_text(name_override or hostname)
    if not ci_name:
        raise RuntimeError("Der CI-Name darf nicht leer sein.")
    report = {
        "type": "VirtualMachine" if virtual else "Device",
        "name": ci_name,
        "description": f"Automatisch erfasst (Windows-Agent). Host: {hostname}; {os_label}; IP: {primary or '-'}",
        "managementIp": primary,
        "network": {"interfaces": interfaces, "dns": valid_dns},
        "packages": collect_packages(system.get("packages", [])),
    }
    if gateway:
        report["network"]["gateway"] = gateway

    if virtual:
        vcpu = system.get("vcpu")
        ram_bytes = system.get("ramBytes")
        disk_sizes = system.get("disks") or []
        if isinstance(vcpu, int) and 1 <= vcpu <= 1024:
            report["vcpu"] = vcpu
        if isinstance(ram_bytes, int) and ram_bytes > 0:
            report["ramGb"] = max(1, round(ram_bytes / 1024**3))
        if not isinstance(disk_sizes, list):
            raise RuntimeError("Die Datenträgerliste ist ungültig.")
        disk_bytes = sum(size for size in disk_sizes if isinstance(size, int) and size > 0)
        if disk_bytes:
            report["diskGb"] = max(1, round(disk_bytes / 1024**3))
        report["os"] = os_label
    else:
        report["deviceType"] = "Server"
        report["vendor"] = manufacturer
        report["model"] = model
        serial = clean_text(system.get("serialNumber"))
        if serial.lower() not in ("default string", "system serial number", "to be filled by o.e.m.", "none"):
            report["serialNumber"] = serial

    return {
        key: value
        for key, value in report.items()
        if value not in (None, "")
    }


def read_config(path):
    settings = {}
    try:
        with open(path, encoding="utf-8-sig") as file:
            lines = file.readlines()
    except OSError as error:
        raise RuntimeError(f"Agent-Konfiguration nicht lesbar: {error}") from error
    allowed = {"STATOFACT_URL", "STATOFACT_TOKEN", "STATOFACT_NAME", "STATOFACT_VIRTUALBOX_REGISTRY", "STATOFACT_VMWARE_DIRECTORY"}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in allowed:
            continue
        if key in settings:
            raise RuntimeError(f"Konfiguration enthält {key} mehrfach.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        settings[key] = value
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url")
    parser.add_argument("--name")
    parser.add_argument("--config")
    parser.add_argument("--dry-run", action="store_true", help="Daten nur ausgeben, nicht senden")
    args = parser.parse_args()

    try:
        settings = read_config(args.config) if args.config else {}
        for key in ("STATOFACT_URL", "STATOFACT_TOKEN", "STATOFACT_NAME", "STATOFACT_VIRTUALBOX_REGISTRY", "STATOFACT_VMWARE_DIRECTORY"):
            if os.environ.get(key):
                settings[key] = os.environ[key]
        payload = collect(args.name or settings.get("STATOFACT_NAME"))
        inventory = collect_inventory(settings)
        if inventory is not None:
            payload["virtualMachines"] = inventory
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    token = settings.get("STATOFACT_TOKEN", "")
    url = args.url or settings.get("STATOFACT_URL", "")
    if len(token) < 16:
        print("STATOFACT_TOKEN muss mindestens 16 Zeichen lang sein.", file=sys.stderr)
        return 2
    parsed_url = urllib.parse.urlsplit(url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc or parsed_url.username or parsed_url.password or parsed_url.query or parsed_url.fragment:
        print("STATOFACT_URL muss eine gültige HTTP(S)-Basis-URL ohne Zugangsdaten sein.", file=sys.stderr)
        return 2

    request = urllib.request.Request(
        url.rstrip("/") + "/api/agent/report",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        print(f"Server antwortete mit HTTP {error.code}: {detail}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError) as error:
        print(f"Verbindung zu {url} fehlgeschlagen: {error}", file=sys.stderr)
        return 1
    package_count = result.get("packages", len(payload.get("packages", [])))
    suffix = f", {result['virtualMachines']} VM(s)" if result.get("virtualMachines") is not None else ""
    print(f"{result.get('type')} {result.get('name')}: {result.get('result')}, {package_count} Softwarepaket(e){suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
