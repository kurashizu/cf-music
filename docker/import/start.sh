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

# Every job starts in a freshly pulled container with no prior state, so
# without this, `registration new` below would run on every single job —
# a fresh anonymous WARP identity per run. Restoring a previously saved one
# from MinIO (see warp_identity.py) means registration only actually
# happens once, not once per job; GitHub-hosted runners share IP ranges
# across unrelated jobs, so minimizing how often we hit the registration
# endpoint at all is worth doing even though it isn't currently rate-limited.
# Must happen before warp-svc starts below: it loads/watches this directory
# on startup, so writing into it afterward isn't guaranteed to be picked up.
python3 /import/warp_identity.py restore

# warp-svc is a Rust binary using the standard RUST_LOG convention; left at
# its default it emits its own internal connection/tunnel-negotiation debug
# log lines straight into the job log with no way to tell them apart from
# our own output. Redirected to a file instead — only dumped out on failure.
RUST_LOG=warn warp-svc --accept-tos >/var/log/warp-svc.log 2>&1 &
WARP_SVC_PID=$!

# warp-svc needs a moment to open its D-Bus service before warp-cli can
# reach it; there's no readiness probe to poll, so this is a fixed delay.
sleep 3

mkdir -p ~/.local/share/warp
echo -n 'yes' > ~/.local/share/warp/accepted-tos.txt

# registration/connect talk to Cloudflare's backend with no built-in
# timeout — left unguarded, a slow/stuck network call hangs the whole job
# until GitHub's multi-hour default timeout, not until anything we control.
WARP_CMD_TIMEOUT=60

fail_warp() {
	echo "$1" >&2
	echo "---- warp-svc log ----" >&2
	cat /var/log/warp-svc.log >&2 2>/dev/null || true
	kill "$WARP_SVC_PID" 2>/dev/null || true
	exit 1
}

if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
	timeout "$WARP_CMD_TIMEOUT" warp-cli --accept-tos registration new \
		|| fail_warp "WARP registration failed or timed out after ${WARP_CMD_TIMEOUT}s"
	python3 /import/warp_identity.py save
fi

timeout "$WARP_CMD_TIMEOUT" warp-cli --accept-tos mode proxy \
	|| fail_warp "warp-cli mode proxy failed or timed out after ${WARP_CMD_TIMEOUT}s"
timeout "$WARP_CMD_TIMEOUT" warp-cli --accept-tos proxy port 40000 \
	|| fail_warp "warp-cli proxy port failed or timed out after ${WARP_CMD_TIMEOUT}s"
timeout "$WARP_CMD_TIMEOUT" warp-cli --accept-tos connect \
	|| fail_warp "warp-cli connect failed or timed out after ${WARP_CMD_TIMEOUT}s"

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
	fail_warp "WARP proxy did not become ready on 127.0.0.1:40000"
fi

python3 /import/import.py
EXIT_CODE=$?

kill "$WARP_SVC_PID" 2>/dev/null || true
exit $EXIT_CODE
