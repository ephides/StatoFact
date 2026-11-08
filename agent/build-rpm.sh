#!/bin/sh
set -eu

command -v rpmbuild >/dev/null || { echo "rpmbuild ist erforderlich." >&2; exit 1; }
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out="$dir/dist"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/SOURCES" "$work/BUILD" "$work/BUILDROOT" "$work/RPMS" "$work/SRPMS" "$out"
for file in statofact-agent.py hypervisor_inventory.py; do
    sed 's/\r$//' "$dir/$file" > "$work/SOURCES/$file"
done
for file in statofact-agent.conf statofact-agent.service statofact-agent.timer; do
    sed 's/\r$//' "$dir/debian/$file" > "$work/SOURCES/$file"
done
sed 's/\r$//' "$dir/rpm/statofact-agent.spec" > "$work/statofact-agent.spec"
rpmbuild --define "_topdir $work" --define "_unitdir /usr/lib/systemd/system" -bb "$work/statofact-agent.spec"
for rpm in "$work"/RPMS/noarch/*.rpm; do
    [ -f "$rpm" ] || { echo "RPM wurde nicht erzeugt." >&2; exit 1; }
    cp "$rpm" "$out/"
    echo "$out/$(basename "$rpm")"
done
