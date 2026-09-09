#!/usr/bin/env bash
# Switches the intake on the netcup box to the LIVE Stripe key, webhook secret and tax rate.
# Reads STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_WEBHOOK_SECRET from the local .env (never committed),
# rewrites the three STRIPE_* lines in /opt/dd-intake/.env on the box and recreates the intake.
#
#   bash deploy/switch-stripe-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_TAX_RATE_ID="txr_1UDpOOAXlOtQAYLubZ3ALStw"

key=$(grep '^STRIPE_LIVE_SECRET_KEY=' .env | cut -d= -f2-)
secret=$(grep '^STRIPE_LIVE_WEBHOOK_SECRET=' .env | cut -d= -f2-)
if [[ -z "$key" || -z "$secret" ]]; then
    echo "STRIPE_LIVE_SECRET_KEY / STRIPE_LIVE_WEBHOOK_SECRET missing from .env" >&2
    exit 1
fi
if [[ "$key" != *_live_* ]]; then
    echo "STRIPE_LIVE_SECRET_KEY is not a live key" >&2
    exit 1
fi

# The values travel on stdin, not on the command line, so they never appear in a shell history or a ps listing.
printf '%s\n%s\n' "$key" "$secret" | ssh netcup 'read -r key; read -r secret
cd /opt/dd-intake
sed -i -e "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=$key|" \
       -e "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$secret|" \
       -e "s|^STRIPE_TAX_RATE_ID=.*|STRIPE_TAX_RATE_ID='"$LIVE_TAX_RATE_ID"'|" .env
docker compose -f docker-compose.prod.yml up -d --force-recreate intake >/dev/null 2>&1
sleep 8
echo "live key lines on the box: $(grep -c "_live_" .env)"
docker compose -f docker-compose.prod.yml ps --format "{{.Name}} {{.Status}}" | grep intake'
