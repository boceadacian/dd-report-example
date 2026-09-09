#!/usr/bin/env bash
# Puts the intake on the netcup box back on the TEST Stripe key, webhook secret and tax rate, for
# `stripe trigger` runs against production. Reads the test values from the local .env
# (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_TAX_RATE_ID, the sk_test block).
# Return to live with deploy/switch-stripe-live.sh.
#
#   bash deploy/switch-stripe-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

key=$(grep '^STRIPE_SECRET_KEY=' .env | cut -d= -f2-)
secret=$(grep '^STRIPE_WEBHOOK_SECRET=' .env | cut -d= -f2-)
rate=$(grep '^STRIPE_TAX_RATE_ID=' .env | cut -d= -f2-)
if [[ -z "$key" || -z "$secret" || -z "$rate" ]]; then
    echo "STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_TAX_RATE_ID (test block) missing from .env" >&2
    exit 1
fi
if [[ "$key" != sk_test_* ]]; then
    echo "STRIPE_SECRET_KEY in .env is not a test key" >&2
    exit 1
fi

printf '%s\n%s\n%s\n' "$key" "$secret" "$rate" | ssh netcup 'read -r key; read -r secret; read -r rate
cd /opt/dd-intake
sed -i -e "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=$key|" \
       -e "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$secret|" \
       -e "s|^STRIPE_TAX_RATE_ID=.*|STRIPE_TAX_RATE_ID=$rate|" .env
docker compose -f docker-compose.prod.yml up -d --force-recreate intake >/dev/null 2>&1
sleep 8
echo "box is on TEST mode: $(grep -c "sk_test_" .env) test key line(s)"
docker compose -f docker-compose.prod.yml ps --format "{{.Name}} {{.Status}}" | grep intake'
