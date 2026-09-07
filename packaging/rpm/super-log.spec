# RPM spec for super-log. Mirrors packaging/deb: the hub binary, the SDK
# headers, the zero-dependency tailers as commands, and a systemd unit.
#
# Built by packaging/rpm/build-rpm.sh, which runs it inside a Fedora/Rocky
# container (rpmbuild is a Red Hat tool). Ship the .rpm on the GitHub
# release, in a self-hosted dnf repo, or via COPR.
#
# The version is passed in by the build script (-D 'version ...').

Name:           super-log
Version:        %{version}
Release:        1%{?dist}
Summary:        One hub for every log stream on a development bench

License:        MIT
URL:            https://github.com/saxonnicholls/super-log
BuildRequires:  cmake gcc-c++ make git libatomic
# libatomic: the hub uses atomics gcc lowers to out-of-line calls, so the
# linker pulls in -latomic. nodejs runs the zero-dependency tailers.
Requires:       nodejs >= 18
Requires:       libatomic

%description
super-log converges every log stream on one machine and one screen:
device, service, container, browser, chain and app logs, interleaved by
arrival. This package installs the hub daemon (superlogd), the SDK
headers, and the zero-dependency tailers as commands on PATH.

%global debug_package %{nil}

%prep
# The source tree is bind-mounted at /src by the build script; nothing to
# unpack. %build works from there.

%build
cd /src
cmake -S . -B build-rpm -DCMAKE_BUILD_TYPE=Release \
    -DSUPER_LOG_INSTALL=ON -DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_INSTALL_LIBDIR=lib
# LIBDIR=lib on purpose: Fedora defaults to lib64, but the only thing the
# SDK installs under it is the header-only find_package config (the hub is a
# binary in bindir, the headers are in includedir), so pin it to /usr/lib so
# the cmake configs land where %files below names them, on every arch.
cmake --build build-rpm --target superlogd -j

%install
cd /src
DESTDIR=%{buildroot} cmake --install build-rpm

# Tailers under /usr/lib/super-log, each a wrapper on PATH.
mkdir -p %{buildroot}/usr/lib/super-log %{buildroot}/usr/bin \
         %{buildroot}/usr/lib/systemd/system
cp tailers/bin/* %{buildroot}/usr/lib/super-log/
for f in %{buildroot}/usr/lib/super-log/superlog-*.mjs; do
    name=$(basename "$f" .mjs)
    printf '#!/bin/sh\nexec node /usr/lib/super-log/%s "$@"\n' "$(basename "$f")" \
        > %{buildroot}/usr/bin/$name
    chmod 0755 %{buildroot}/usr/bin/$name
done
printf '#!/bin/sh\nexec node /usr/lib/super-log/superlog-tee.mjs "$@"\n' \
    > %{buildroot}/usr/bin/superlog
chmod 0755 %{buildroot}/usr/bin/superlog
install -m 0644 packaging/rpm/superlogd.service \
    %{buildroot}/usr/lib/systemd/system/superlogd.service

%post
%systemd_post superlogd.service

%preun
%systemd_preun superlogd.service

%postun
%systemd_postun_with_restart superlogd.service

%files
/usr/bin/superlogd
/usr/bin/superlog
/usr/bin/superlog-*
/usr/lib/super-log/
/usr/lib/systemd/system/superlogd.service
/usr/include/superlog.h
/usr/include/super_log/
/usr/include/ts_moveables/
/usr/lib/cmake/superlog/
/usr/lib/cmake/ts_moveables/

%changelog
* Mon Sep 07 2026 Saxon Nicholls <me@saxonnicholls.com> - 0.3.0-1
- super-log 0.3.0: FIX session logs and MAVLink drone telemetry, plus the
  verified .rpm lane (libatomic dependency, lib install dir).
* Mon Sep 07 2026 Saxon Nicholls <me@saxonnicholls.com> - 0.2.0-1
- super-log 0.2.0: alarms, agents, OpenTelemetry, RPC health, and more.
