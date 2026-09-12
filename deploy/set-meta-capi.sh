#!/usr/bin/env bash
# Writes the Meta Conversions API settings into /opt/dd-intake/.env on the netcup box and recreates
# the intake. Reads META_CAPI_TOKEN from the local .env (never committed); the pixel id and the test
# code are not secrets and live here. Pass --live to clear the test event code once the integration
# is verified (events sent with a test code do not count in Meta's reports).
#
#   bash deploy/set-meta-capi.sh          # test mode: events land in Events Manager -> Test events
#   bash deploy/set-meta-capi.sh --live   # production: no test code
set -euo pipefail
cd "$(dirname "$0")/.."

PIXEL_ID="2952083868458495"
TEST_EVENT_CODE="TEST57848"
GRAPH_VERSION="v23.0"

if [[ "${1:-}" == "--live" ]]; then
    TEST_EVENT_CODE=""
fi

token=$(grep '^META_CAPI_TOKEN=' .env | cut -d= -f2-)
if [[ -z "$token" ]]; then
    echo "META_CAPI_TOKEN missing from .env" >&2
    exit 1
fi

# The token travels on stdin, not on the command line, so it never appears in a shell history or a ps listing.
printf '%s\n' "$token" | ssh netcup 'read -r token
cd /opt/dd-intake
set_var() {
    if grep -q "^$1=" .env; then
        sed -i -e "s|^$1=.*|$1=$2|" .env
    else
        printf "%s=%s\n" "$1" "$2" >> .env
    fi
}
set_var META_PIXEL_ID "'"$PIXEL_ID"'"
set_var META_CAPI_TOKEN "$token"
set_var META_TEST_EVENT_CODE "'"$TEST_EVENT_CODE"'"
set_var META_GRAPH_VERSION "'"$GRAPH_VERSION"'"
docker compose -f docker-compose.prod.yml up -d --force-recreate intake >/dev/null 2>&1
sleep 8
echo "meta lines on the box: $(grep -c "^META_" .env), test code: $(grep "^META_TEST_EVENT_CODE=" .env | cut -d= -f2-)"
docker compose -f docker-compose.prod.yml ps --format "{{.Name}} {{.Status}}" | grep intake'
