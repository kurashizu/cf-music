#!/bin/bash
# Brings up the official WARP client in SOCKS5 proxy mode (no TUN device,
# no NAT — proxy mode routes only this process's traffic, which is all the
# import job needs) and then runs the import script. GitHub Actions
# container jobs run as root, so no sudo/user-switching dance is needed
# here, unlike community reference images built for arbitrary hosts.
#
# -e is intentionally not set: a non-zero import.py exit must still reach
# the warp-svc cleanup at the bottom, not abort the script mid-way and
# leave the daemon running past the job. Setup steps before that are
# checked explicitly instead.
set -uo pipefail

mkdir -p /run/dbus
rm -f /run/dbus/pid
dbus-daemon --config-file=/usr/share/dbus-1/system.conf || {
	echo "Failed to start dbus-daemon" >&2
	exit 1
}

warp-svc --accept-tos &
WARP_SVC_PID=$!

# warp-svc needs a moment to open its D-Bus service before warp-cli can
# reach it; there's no readiness probe to poll, so this is a fixed delay.
sleep 3

mkdir -p ~/.local/share/warp
echo -n 'yes' > ~/.local/share/warp/accepted-tos.txt

if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
	warp-cli --accept-tos registration new || {
		echo "WARP registration failed" >&2
		kill "$WARP_SVC_PID" 2>/dev/null || true
		exit 1
	}
fi

warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos connect

# Wait for the proxy port to actually accept connections before starting
# the script that depends on it (yt-dlp/urllib both go through SOCKS5
# 127.0.0.1:40000 — see import.py's SOCKS5_PROXY constant).
PROXY_READY=0
for _ in $(seq 1 30); do
	if (exec 3<>/dev/tcp/127.0.0.1/40000) 2>/dev/null; then
		exec 3<&-
		exec 3>&-
		PROXY_READY=1
		break
	fi
	sleep 1
done

if [ "$PROXY_READY" -ne 1 ]; then
	echo "WARP proxy did not become ready on 127.0.0.1:40000" >&2
	kill "$WARP_SVC_PID" 2>/dev/null || true
	exit 1
fi

python3 /import/import.py
EXIT_CODE=$?

kill "$WARP_SVC_PID" 2>/dev/null || true
exit $EXIT_CODE
