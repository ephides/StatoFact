#!/usr/bin/env python3
"""statofact-agent: liest Systemdaten dieses Linux-Rechners aus und meldet sie
per HTTP an die Statofact-API (POST /api/agent/report).

Konfiguration (Umgebungsvariablen oder --Optionen):
  STATOFACT_URL    Basis-URL, z. B. http://10.0.0.5:3000
  STATOFACT_TOKEN  Token (= AGENT_TOKEN des Servers)
  STATOFACT_NAME   optional: CI-Name (Standard: Hostname)
"""
import argparse
from hypervisor_inventory import collect_inventory
import fnmatch
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return ""


def run(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def os_name():
    for line in read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return platform.system()


def mem_gb():
    m = re.search(r"^MemTotal:\s+(\d+)\s+kB", read("/proc/meminfo"), re.M)
    return max(1, round(int(m.group(1)) / 1024 / 1024)) if m else None


def disk_gb():
    total = 0
    for line in run("lsblk", "-dbn", "-o", "SIZE,TYPE").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == "disk" and parts[0].isdigit():
            total += int(parts[0])
    if not total:
        total = shutil.disk_usage("/").total
    return max(1, round(total / 1024**3))


SKIP_IFACE = ("lo", "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "tun", "tap", "kube")


def ip_json(*args):
    try:
        return json.loads(run("ip", "-j", *args) or "[]")
    except ValueError:
        return []


def interfaces():
    result = []
    for link in ip_json("addr", "show"):
        name = link.get("ifname", "")
        if not name or name.startswith(SKIP_IFACE):
            continue
        mac = link.get("address", "")
        entry = {
            "name": name,
            "state": (link.get("operstate") or "").lower(),
            "addresses": [
                {"ip": a["local"], "prefix": a["prefixlen"]}
                for a in link.get("addr_info", [])
                if a.get("family") in ("inet", "inet6") and a.get("local") and "prefixlen" in a
            ],
        }
        if re.fullmatch(r"([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", mac) and mac != "00:00:00:00:00:00":
            entry["mac"] = mac
        speed = read(f"/sys/class/net/{name}/speed")
        if speed.isdigit() and int(speed) > 0:
            entry["speedMbps"] = int(speed)
        result.append(entry)
    return result


def default_route():
    routes = ip_json("route", "show", "default")
    return (routes[0].get("gateway"), routes[0].get("dev")) if routes else (None, None)


def dns_servers():
    for path in ("/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"):
        servers = []
        for line in read(path).splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "nameserver" and not parts[1].startswith("127."):
                servers.append(parts[1].split("%")[0])
        if servers:
            return servers[:8]
    return []


def architecture_matches(pattern, architecture):
    if pattern == "linux-any":
        return architecture in {
            "amd64", "arm64", "armel", "armhf", "i386", "mips64el",
            "mipsel", "ppc64el", "riscv64", "s390x",
        }
    if pattern.startswith("any-"):
        return architecture.endswith(pattern[4:])
    if pattern.endswith("-any"):
        return architecture.startswith(pattern[:-4])
    return fnmatch.fnmatchcase(architecture, pattern)


def dependency_groups(expression, architecture=None):
    groups = []
    for group in expression.split(","):
        alternatives = []
        for alternative in group.split("|"):
            restrictions = re.findall(r"\[([^]]*)\]", alternative)
            if architecture and restrictions:
                applies = True
                for restriction in restrictions:
                    tokens = restriction.split()
                    positive = [token for token in tokens if not token.startswith("!")]
                    negative = [token[1:] for token in tokens if token.startswith("!")]
                    if positive and not any(architecture_matches(token, architecture) for token in positive):
                        applies = False
                    if any(architecture_matches(token, architecture) for token in negative):
                        applies = False
                if not applies:
                    continue
            cleaned = re.sub(r"\[[^]]*\]", "", alternative)
            cleaned = re.sub(r"<[^>]*>", "", cleaned).strip()
            match = re.match(r"([a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?)", cleaned, re.I)
            if match:
                token = match.group(1).lower()
                name, separator, qualifier = token.partition(":")
                alternatives.append((name, qualifier if separator else None))
        if alternatives:
            groups.append(alternatives)
    return groups


def collect_deb_packages():
    if not shutil.which("dpkg-query"):
        print("Debian-Paketinventur nicht verfügbar; bestehende Softwaredaten bleiben unverändert.", file=sys.stderr)
        return None

    fmt = (
        "${db:Status-Status}\\t${binary:Package}\\t${Version}\\t${Architecture}"
        "\\t${Depends}\\t${Pre-Depends}\\t${Provides}\\n"
    )
    try:
        result = subprocess.run(
            ["dpkg-query", "-W", f"--showformat={fmt}"],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("dpkg-query hat das Zeitlimit überschritten.") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()[:300]
        raise RuntimeError(f"dpkg-query ist fehlgeschlagen: {detail}") from error

    records = []
    for line in result.stdout.splitlines():
        fields = line.split("\t", 6)
        if len(fields) != 7 or fields[0] != "installed":
            continue
        raw_name, version, architecture, depends, predepends, provides = fields[1:]
        name = raw_name.split(":", 1)[0].lower()
        if name and version and architecture:
            records.append({
                "name": name,
                "version": version,
                "architecture": architecture.lower(),
                "relations": f"{predepends},{depends}",
                "provides": provides,
            })

    if len(records) > 5000:
        raise RuntimeError(f"{len(records)} Debian-Pakete erkannt; das Maximum beträgt 5000.")
    native_architecture = run("dpkg", "--print-architecture")
    if not native_architecture:
        native_architecture = next(
            (record["architecture"] for record in records if record["architecture"] != "all"),
            "",
        )

    by_name = {}
    by_provide = {}
    for record in records:
        identity = (record["name"], record["architecture"])
        by_name.setdefault(record["name"], []).append(identity)
        for group in dependency_groups(record["provides"], native_architecture):
            for provided, _ in group:
                by_provide.setdefault(provided, []).append(identity)

    def select(candidates, qualifier, source_arch):
        if qualifier == "native":
            candidates = [
                candidate
                for candidate in candidates
                if candidate[1] in (native_architecture, "all")
            ]
        elif qualifier and qualifier != "any":
            candidates = [candidate for candidate in candidates if candidate[1] in (qualifier, "all")]
        if not candidates:
            return None
        preferred_arch = native_architecture if source_arch == "all" else source_arch
        return min(candidates, key=lambda candidate: (
            candidate[1] != preferred_arch,
            candidate[1] != "all",
            candidate,
        ))

    packages = []
    for record in records:
        dependencies = set()
        for group in dependency_groups(record["relations"], native_architecture):
            for name, qualifier in group:
                target = select(by_name.get(name, []), qualifier, record["architecture"])
                if target is None:
                    target = select(by_provide.get(name, []), qualifier, record["architecture"])
                if target and target != (record["name"], record["architecture"]):
                    dependencies.add(target)
                    break
        packages.append({
            "name": record["name"],
            "version": record["version"],
            "architecture": record["architecture"],
            "depends": [
                {"name": name, "architecture": architecture}
                for name, architecture in sorted(dependencies)
            ],
        })
    return packages


def collect_rpm_packages():
    fmt = "%{NAME}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\t%{ARCH}\\n"
    try:
        result = subprocess.run(
            ["rpm", "-qa", "--qf", fmt], capture_output=True, text=True,
            timeout=60, check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"RPM-Paketinventur fehlgeschlagen: {error}") from error
    records = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) != 3:
            raise RuntimeError(f"Ungültige RPM-Paketdaten: {line[:200]}")
        name, version, architecture = fields
        if name == "gpg-pubkey" and architecture == "(none)":
            continue
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9+._-]*", name) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", architecture) or not version:
            raise RuntimeError(f"Ungültige RPM-Paketdaten: {line[:200]}")
        key = (name.lower(), architecture.lower())
        records.setdefault(key, set()).add(version)
    if not records or len(records) > 5000:
        raise RuntimeError(f"Ungültige Anzahl RPM-Pakete: {len(records)} (erlaubt: 1–5000).")
    packages = []
    for (name, architecture), versions in sorted(records.items()):
        version = ", ".join(sorted(versions))
        if len(version) > 200:
            raise RuntimeError(f"Zu viele installierte Versionen für {name}:{architecture}.")
        packages.append({"name": name, "version": version, "architecture": architecture})
    return packages


def collect_packages():
    if shutil.which("dpkg-query"):
        return collect_deb_packages(), "deb"
    if shutil.which("rpm"):
        return collect_rpm_packages(), "rpm"
    print("Paketinventur nicht verfügbar; bestehende Softwaredaten bleiben unverändert.", file=sys.stderr)
    return None, None


def socket_address(value):
    address, separator, port = value.rpartition(":")
    if not separator or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise RuntimeError(f"Unbekanntes ss-Adressformat: {value}")
    if address.startswith("[") and "]" in address:
        close = address.index("]")
        address = address[1:close] + address[close + 1:]
    if not address:
        raise RuntimeError(f"Leere ss-Bindungsadresse: {value}")
    return address, int(port)


def owning_packages(executable, installed, package_manager="deb"):
    candidates = [executable]
    if executable.startswith("/usr/bin/") or executable.startswith("/usr/sbin/"):
        candidates.append(executable[4:])
    elif executable.startswith("/bin/") or executable.startswith("/sbin/"):
        candidates.append("/usr" + executable)
    found = set()
    for path in candidates:
        try:
            cmd = (["rpm", "-qf", "--qf", "%{NAME}\\t%{ARCH}\\n", "--", path]
                   if package_manager == "rpm" else ["dpkg-query", "-S", "--", path])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=False,
                                    env={**os.environ, "LC_ALL": "C"})
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"Paketzuordnung für {path} fehlgeschlagen: {error}") from error
        if result.returncode == 1 and package_manager == "rpm":
            message = (result.stdout + result.stderr).strip()
            if "is not owned by any package" in message or "No such file or directory" in message:
                continue
            raise RuntimeError(f"Paketzuordnung für {path} fehlgeschlagen: {message[:300]}")
        if result.returncode not in (0, 1):
            raise RuntimeError(f"Paketzuordnung für {path} fehlgeschlagen: {result.stderr.strip()[:300]}")
        for line in result.stdout.splitlines():
            if package_manager == "rpm":
                fields = line.split("\t")
                if len(fields) != 2:
                    raise RuntimeError(f"Ungültige RPM-Paketzuordnung für {path}: {line[:200]}")
                name, architecture = fields
                for pkg in installed.get(name.lower(), []):
                    if pkg["architecture"] == architecture.lower():
                        found.add((pkg["name"], pkg["architecture"]))
                continue
            owners, separator, _ = line.partition(": ")
            if not separator:
                continue
            for owner in owners.split(", "):
                name, _, architecture = owner.partition(":")
                matches = installed.get(name, [])
                for pkg in matches:
                    if not architecture or pkg["architecture"] == architecture:
                        found.add((pkg["name"], pkg["architecture"]))
    return found


def is_root():
    get_effective_uid = getattr(os, "geteuid", None)
    return get_effective_uid is not None and get_effective_uid() == 0


def collect_services(packages, package_manager="deb"):
    if not is_root():
        print("Service-Erfassung übersprungen: Root-Rechte erforderlich; bestehende Daten bleiben unverändert.", file=sys.stderr)
        return None
    try:
        result = subprocess.run(
            ["ss", "-H", "-l", "-n", "-t", "-u", "-p"],
            capture_output=True, text=True, timeout=30, check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Lauschende Ports konnten nicht mit ss erfasst werden: {error}") from error
    if result.stderr.strip():
        raise RuntimeError(f"ss meldet eine unvollständige Erfassung: {result.stderr.strip()[:300]}")

    installed = {}
    for pkg in packages:
        installed.setdefault(pkg["name"], []).append(pkg)
    executable_packages = {}
    services = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 6)
        if len(parts) < 6 or parts[0] not in ("tcp", "udp"):
            raise RuntimeError(f"Unbekannte ss-Ausgabe: {line[:200]}")
        address, port = socket_address(parts[4])
        binding = (parts[0], address, port)
        processes = re.findall(r'"([^"]+)",pid=(\d+),', parts[6] if len(parts) > 6 else "")
        if not processes:
            processes = [(f"unbekannt-{parts[0]}-{address}-{port}", "")]
        for process, pid in processes:
            cgroup = read(f"/proc/{pid}/cgroup") if pid else ""
            units = re.findall(r"(?:^|/)([^/\n]+\.service)(?=/|$)", cgroup)
            key = units[-1] if units else process
            if len(key) > 200 or any(char in key for char in "\r\n\0"):
                raise RuntimeError(f"Ungültiger Service-Name: {key[:200]}")
            service = services.setdefault(key, {"bindings": set(), "executables": set(), "packages": set()})
            service["bindings"].add(binding)
            if not pid:
                continue
            try:
                executable = os.readlink(f"/proc/{pid}/exe")
            except OSError as error:
                print(f"Service {key}: ausführbare Datei von PID {pid} nicht lesbar: {error}", file=sys.stderr)
                continue
            if executable.endswith(" (deleted)"):
                executable = executable[:-10]
            if not executable.startswith("/") or "\n" in executable:
                continue
            service["executables"].add(executable)
            if installed and executable not in executable_packages:
                executable_packages[executable] = owning_packages(executable, installed, package_manager)
            if installed:
                service["packages"].update(executable_packages[executable])
    if len(services) > 1000:
        raise RuntimeError(f"{len(services)} Services erkannt; das Maximum beträgt 1000.")
    return [
        {
            "key": key,
            "bindings": [{"protocol": protocol, "address": address, "port": port}
                         for protocol, address, port in sorted(info["bindings"])],
            "executables": sorted(info["executables"]),
            "packages": [{"name": name, "architecture": architecture}
                         for name, architecture in sorted(info["packages"])],
        }
        for key, info in sorted(services.items())
    ]


def collect(name_override):
    virt = run("systemd-detect-virt") or "none"
    virtual = virt != "none"
    nics = interfaces()
    gateway, gateway_dev = default_route()
    ipv4 = {n["name"]: [a["ip"] for a in n["addresses"] if "." in a["ip"] and not a["ip"].startswith(("127.", "169.254."))] for n in nics}
    primary_ips = ipv4.get(gateway_dev) or next((ips for ips in ipv4.values() if ips), [])
    primary = primary_ips[0] if primary_ips else ""
    hostname = socket.gethostname()
    name = name_override or hostname
    network = {"interfaces": nics, "dns": dns_servers()}
    if gateway:
        network["gateway"] = gateway
    packages, package_manager = collect_packages()
    services = collect_services(packages or [], package_manager)
    info = {
        "name": name,
        "description": f"Automatisch erfasst (Agent). Host: {hostname}; Kernel {platform.release()}; IP: {primary or '-'}",
        "network": network,
    }
    if packages is not None:
        info["packages"] = packages
    if services is not None:
        info["services"] = services
    if virtual:
        info["type"] = "VirtualMachine"
        info.update(vcpu=os.cpu_count(), ramGb=mem_gb(), diskGb=disk_gb(), os=os_name(), managementIp=primary)
    else:
        info["type"] = "Device"
        info.update(
            deviceType="Server",
            vendor=read("/sys/class/dmi/id/sys_vendor"),
            model=read("/sys/class/dmi/id/product_name"),
            serialNumber=read("/sys/class/dmi/id/product_serial"),
            managementIp=primary,
        )
    return {k: v for k, v in info.items() if v not in (None, "")}


def read_pull_config():
    try:
        with open("/etc/statofact-agent.conf", encoding="utf-8") as file:
            lines = file.readlines()
    except OSError as error:
        raise RuntimeError(f"Agent-Konfiguration nicht lesbar: {error}") from error
    settings = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in ("STATOFACT_MODE", "STATOFACT_NAME", "STATOFACT_VIRTUALBOX_REGISTRY", "STATOFACT_VMWARE_DIRECTORY"):
            continue
        if key in settings:
            raise RuntimeError(f"Konfiguration enthält {key} mehrfach.")
        try:
            parts = shlex.split(value, comments=True)
        except ValueError as error:
            raise RuntimeError(f"Ungültige Konfiguration für {key}.") from error
        if len(parts) > 1:
            raise RuntimeError(f"Ungültige Konfiguration für {key}.")
        settings[key] = parts[0] if parts else ""
    if settings.get("STATOFACT_MODE", "active") != "passive":
        raise RuntimeError("SSH-Abruf nur im passiven Modus erlaubt (STATOFACT_MODE=passive).")
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url")
    parser.add_argument("--name")
    parser.add_argument("--dry-run", action="store_true", help="Daten nur ausgeben, nicht senden")
    parser.add_argument("--pull", action="store_true", help="Im passiven Modus einen Report für SSH ausgeben")
    args = parser.parse_args()

    try:
        if args.pull:
            if args.dry_run or args.name or args.url:
                raise RuntimeError("--pull darf nicht mit anderen Optionen kombiniert werden.")
            if not is_root():
                raise RuntimeError("SSH-Abruf benötigt Root-Rechte.")
            settings = read_pull_config()
            name = settings.get("STATOFACT_NAME") or None
        else:
            mode = os.environ.get("STATOFACT_MODE", "active")
            if mode not in ("active", "passive"):
                raise RuntimeError("STATOFACT_MODE muss active oder passive sein.")
            if mode == "passive" and not args.dry_run:
                print("Passiver Modus: kein aktiver Report.", file=sys.stderr)
                return 0
            name = args.name or os.environ.get("STATOFACT_NAME")
            settings = os.environ
        payload = collect(name)
        inventory = collect_inventory(settings)
        if inventory is not None:
            payload["virtualMachines"] = inventory
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.dry_run or args.pull:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    token = os.environ.get("STATOFACT_TOKEN")
    url = args.url or os.environ.get("STATOFACT_URL")
    if not url or not token:
        print("STATOFACT_URL und STATOFACT_TOKEN müssen gesetzt sein.", file=sys.stderr)
        return 2

    request = urllib.request.Request(
        url.rstrip("/") + "/api/agent/report",
        data=json.dumps(payload).encode("utf-8"),
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
    nets = result.get("networks")
    package_count = result.get("packages")
    suffix = f", {nets} Netzwerk(e)" if nets is not None else ""
    if package_count is not None:
        suffix += f", {package_count} Softwarepaket(e)"
    if result.get("services") is not None:
        suffix += f", {result['services']} Service(s)"
    if result.get("virtualMachines") is not None:
        suffix += f", {result['virtualMachines']} VM(s)"
    print(f"{result.get('type')} {result.get('name')}: {result.get('result')}{suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
