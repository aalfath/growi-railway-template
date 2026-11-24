#!/bin/sh
# Start script for GROWI on Railway (PID 1, BusyBox sh).
#
# 1. Checks the generated secrets are set and fills in safe defaults.
# 2. Runs railway-boot.mjs once: waits for MongoDB and, on the first boot only, creates
#    the admin on a private port and closes self-registration (see that file).
# 3. Runs the upstream entrypoint (migrations, privilege drop, heap sized from the
#    cgroup) on $PORT. If GROWI stops for any reason other than Railway stopping the
#    container, this script exits non-zero so Railway's ON_FAILURE policy restarts it.
set -u

fail() {
	echo "[railway] $*" >&2
	exit 1
}

for k in MONGO_URI PASSWORD_SEED SECRET_TOKEN AUTO_INSTALL_ADMIN_PASSWORD; do
	eval "v=\${$k:-}"
	[ -n "$v" ] || fail "$k is empty: refusing to start (set it on the GROWI service)"
done
[ "${#AUTO_INSTALL_ADMIN_PASSWORD}" -ge 8 ] || fail "AUTO_INSTALL_ADMIN_PASSWORD must be at least 8 characters"

export PORT="${PORT:-3000}"
export AUTO_INSTALL_ADMIN_USERNAME="${AUTO_INSTALL_ADMIN_USERNAME:-admin}"
export AUTO_INSTALL_ADMIN_NAME="${AUTO_INSTALL_ADMIN_NAME:-$AUTO_INSTALL_ADMIN_USERNAME}"
export AUTO_INSTALL_GLOBAL_LANG="${AUTO_INSTALL_GLOBAL_LANG:-en_US}"
# Attachments live in MongoDB (GridFS): the GROWI service keeps no state of its own,
# so the stack needs only MongoDB's volume.
export FILE_UPLOAD="${FILE_UPLOAD:-mongodb}"
export DEPLOYMENT_TYPE="${DEPLOYMENT_TYPE:-others}"
# Upstream sends anonymised telemetry to telemetry.growi.org by default: off here.
export OPENTELEMETRY_ENABLED="${OPENTELEMETRY_ENABLED:-false}"
# Railway's proxy reaches the service from these ranges; trust them for X-Forwarded-*.
if [ -z "${TRUST_PROXY_BOOL:-}" ] && [ -z "${TRUST_PROXY_HOPS:-}" ]; then
	export TRUST_PROXY_CSV="${TRUST_PROXY_CSV:-loopback,100.64.0.0/10,152.233.0.0/16}"
fi
# Site URL: APP_SITE_URL if valid, else Railway's public domain, else none.
case "${APP_SITE_URL:-}" in
http://?* | https://?*) ;;
*)
	[ -n "${APP_SITE_URL:-}" ] && echo "[railway] ignoring invalid APP_SITE_URL \"$APP_SITE_URL\""
	unset APP_SITE_URL
	case "${RAILWAY_PUBLIC_DOMAIN:-}" in
	?*.?*) export APP_SITE_URL="https://$RAILWAY_PUBLIC_DOMAIN" ;;
	esac
	;;
esac
# libuv threads from the service's CPUs, not the host's (Railway shows 32+ CPUs).
if [ -z "${UV_THREADPOOL_SIZE:-}" ]; then
	n=4
	if read -r q p </sys/fs/cgroup/cpu.max 2>/dev/null && [ "$q" != max ]; then
		n=$(((q + p - 1) / p))
	fi
	[ "$n" -lt 2 ] && n=2
	[ "$n" -gt 4 ] && n=4
	export UV_THREADPOOL_SIZE=$n
fi

node /railway-boot.mjs || fail "first-boot setup failed: not starting GROWI (see the lines above)"

stopping=0
child=
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
echo "[railway] starting GROWI on port $PORT"
# The upstream entrypoint only spawns and watches GROWI, so it gets a small heap.
node --max-old-space-size=48 --max-semi-space-size=1 /docker-entrypoint.ts &
child=$!
code=0
while :; do
	wait "$child"
	code=$?
	kill -0 "$child" 2>/dev/null || break
done
[ "$stopping" = 1 ] && exit 0
echo "[railway] GROWI exited with code $code; exiting non-zero so Railway restarts it" >&2
[ "$code" -eq 0 ] && code=1
exit "$code"
