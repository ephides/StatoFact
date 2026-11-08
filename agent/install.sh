#!/bin/sh
# Installiert den statofact-agent als systemd-Timer (als root ausführen).
# Aufruf: sudo ./install.sh http://STATOFACT-HOST:3000 TOKEN [INTERVALL_MIN]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen." >&2; exit 1; }
[ $# -ge 2 ] || { echo "Aufruf: $0 URL TOKEN [INTERVALL_MIN]" >&2; exit 2; }
URL=$1; TOKEN=$2; MIN=${3:-15}
DIR=$(cd "$(dirname "$0")" && pwd)

install -m 0755 "$DIR/statofact-agent.py" /usr/bin/statofact-agent
install -m 0644 "$DIR/hypervisor_inventory.py" /usr/bin/hypervisor_inventory.py
umask 077
printf 'STATOFACT_MODE=active\nSTATOFACT_URL=%s\nSTATOFACT_TOKEN=%s\n' "$URL" "$TOKEN" > /etc/statofact-agent.conf

cat > /etc/systemd/system/statofact-agent.service <<EOF
[Unit]
Description=statofact agent (meldet Systemdaten an Statofact)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/statofact-agent.conf
ExecStart=/usr/bin/python3 /usr/bin/statofact-agent
EOF

cat > /etc/systemd/system/statofact-agent.timer <<EOF
[Unit]
Description=statofact agent regelmäßig ausführen

[Timer]
OnBootSec=1min
OnUnitActiveSec=${MIN}min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now statofact-agent.timer
systemctl start statofact-agent.service || true
journalctl -u statofact-agent.service -n 5 --no-pager || true
