#!/usr/bin/env python3
"""Baut agent/dist/statofact-agent_<version>_all.deb ohne dpkg-deb (läuft auch unter Windows)."""
import gzip
import hashlib
import io
import sys
import tarfile
from pathlib import Path

VERSION = "0.6.0"
HERE = Path(__file__).resolve().parent
SRC = HERE / "debian"
MTIME = 1_700_000_000  # fester Zeitstempel für reproduzierbare Pakete

# (Zielpfad im Paket, Quelle, Modus)
FILES = [
    ("usr/bin/statofact-agent", HERE / "statofact-agent.py", 0o755),
    ("usr/bin/hypervisor_inventory.py", HERE / "hypervisor_inventory.py", 0o644),
    ("lib/systemd/system/statofact-agent.service", SRC / "statofact-agent.service", 0o644),
    ("lib/systemd/system/statofact-agent.timer", SRC / "statofact-agent.timer", 0o644),
    ("etc/statofact-agent.conf", SRC / "statofact-agent.conf", 0o600),
]
SCRIPTS = ["postinst", "prerm", "postrm"]


def lf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def add(tar: tarfile.TarFile, name: str, data: bytes, mode: int, directory: bool = False) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = MTIME
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mode = mode
    if directory:
        info.type = tarfile.DIRTYPE
        tar.addfile(info)
    else:
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))


def make_tar(entries) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
        entries(tar)
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=MTIME, compresslevel=9) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def ar_member(name: str, data: bytes) -> bytes:
    header = f"{name + '/':<16}{MTIME:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n"
    assert len(header) == 60
    return header.encode("ascii") + data + (b"\n" if len(data) % 2 else b"")


def main() -> None:
    payload = {target: lf(src) for target, src, _ in FILES}

    def data_entries(tar):
        seen = set()
        for target in payload:
            parts = Path(target).parts[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i])
                if d not in seen:
                    seen.add(d)
                    add(tar, f"./{d}/", b"", 0o755, directory=True)
        for target, _, mode in FILES:
            add(tar, f"./{target}", payload[target], mode)

    data_tar = make_tar(data_entries)

    size_kb = max(1, sum(len(v) for v in payload.values()) // 1024)
    control = lf(SRC / "control").decode().replace("@VERSION@", VERSION).replace("@SIZE@", str(size_kb)).encode()
    md5sums = "".join(f"{hashlib.md5(payload[t]).hexdigest()}  {t}\n" for t, _, _ in FILES).encode()
    conffiles = b"/etc/statofact-agent.conf\n"

    def control_entries(tar):
        add(tar, "./", b"", 0o755, directory=True)
        add(tar, "./control", control, 0o644)
        add(tar, "./conffiles", conffiles, 0o644)
        add(tar, "./md5sums", md5sums, 0o644)
        for script in SCRIPTS:
            add(tar, f"./{script}", lf(SRC / script), 0o755)

    control_tar = make_tar(control_entries)

    out_dir = HERE / "dist"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"statofact-agent_{VERSION}_all.deb"
    out.write_bytes(
        b"!<arch>\n"
        + ar_member("debian-binary", b"2.0\n")
        + ar_member("control.tar.gz", control_tar)
        + ar_member("data.tar.gz", data_tar)
    )
    print(out)


if __name__ == "__main__":
    sys.exit(main())
