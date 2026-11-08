Name:           statofact-agent
Version:        0.6.0
Release:        1%{?dist}
Summary:        Statofact CMDB Linux agent
License:        LicenseRef-Proprietary
BuildArch:      noarch
Requires:       python3, systemd, iproute
Source0:        statofact-agent.py
Source1:        statofact-agent.conf
Source2:        statofact-agent.service
Source3:        statofact-agent.timer
Source4:        hypervisor_inventory.py

%description
Collects host, network and listening service information and reports it to
Statofact, either by active reporting or passive SSH collection.
Package inventories are supported on Debian and RPM-based systems.

%install
install -D -m 0755 %{SOURCE0} %{buildroot}%{_bindir}/statofact-agent
install -D -m 0644 %{SOURCE4} %{buildroot}%{_bindir}/hypervisor_inventory.py
install -D -m 0600 %{SOURCE1} %{buildroot}%{_sysconfdir}/statofact-agent.conf
install -D -m 0644 %{SOURCE2} %{buildroot}%{_unitdir}/statofact-agent.service
install -D -m 0644 %{SOURCE3} %{buildroot}%{_unitdir}/statofact-agent.timer

%post
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    if [ "$1" -eq 1 ]; then
        systemctl enable --now statofact-agent.timer
    fi
fi

%preun
if [ "$1" -eq 0 ] && [ -d /run/systemd/system ]; then
    systemctl disable --now statofact-agent.timer
fi

%postun
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
fi

%files
%{_bindir}/statofact-agent
%{_bindir}/hypervisor_inventory.py
%config(noreplace) %attr(0600,root,root) %{_sysconfdir}/statofact-agent.conf
%{_unitdir}/statofact-agent.service
%{_unitdir}/statofact-agent.timer
