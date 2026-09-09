# dd-report-experiment

Demand test for the property due diligence report ("verificare proprietate").
A static landing page on Bunny collects leads; a tiny Fastify service on the
netcup box saves each lead to Postgres, its CF documents to S3 and pings Slack;
the report itself is produced by hand, uploaded from the admin page and sent
to the customer by email as a link. Free of charge during the test.

```
landing/   static page for Bunny: index.html, cerere.html, multumim.html, raport.html (customer's report), legal pages, styles.css, app.js
intake/    Fastify + TypeScript service: POST /leads, POST /leads/:id/files, GET /raport/:id/:token,
           GET /admin/leads[/:id], POST /admin/leads/:id/report[/send], GET /health
deploy/    Caddyfile (prod), Caddyfile.local, s3-iam-policy.json (S3 + SES), s3-lifecycle.json
docker-compose.prod.yml   Caddy + Postgres + intake on the netcup box, reads ./.env (see .env.example)
docker-compose.local.yml  the same plus MinIO and a Slack echo, for testing on your machine
```

Data flow: browser on `raportcf.ro` (Bunny) posts to `https://api.raportcf.ro` (netcup), the service
inserts the lead into Postgres (`leads`), writes each document to
`s3://imobile-private-files/dd-experiment/{leadId}/files/{kind}/NN-name.ext` (recorded in
`lead_files`), then posts a short message (no personal data) to Slack with a link to the
basic-auth admin page. When the report is done, you upload the PDF on the lead's admin page
(stored at `.../{leadId}/report/raport.pdf`) and press "Trimite emailul": the customer gets
`https://raportcf.ro/raport.html#{leadId}.{token}`, a static page on Bunny whose JS asks
`GET api.raportcf.ro/raport/{leadId}/{token}/links` for 15 minute presigned S3 links (inline
view + download) and embeds the PDF. The id and token travel in the URL fragment, so neither the
CDN nor the API log them. The old `api.raportcf.ro/raport/{id}/{token}` URL 302s to the new
page. The first open is pinged to Slack.

## 0. Postgres

The `postgres` service in the compose (`postgres:17-alpine`, volume `pg_data`, not published).
Schema is applied by the intake at boot (`intake/src/db.ts`, idempotent). Tables: `leads`
(one row per lead, `attribution` and `client` as jsonb, report columns: S3 key, link token,
sent and viewed counters) and `lead_files` (one row per uploaded document, `s3_key` unique).
Indexes on `created_at`, `lower(email)` and `phone`, so "has this person asked before" is one
query when the free-then-paid gate is built.

`PGPASSWORD` in `.env` is both the initial password of the container and the intake's
credential. Changing it in `.env` after the volume exists does not change the database
password; run `ALTER USER ddintake PASSWORD '...'` in psql first.

```bash
# psql on the box
docker compose -f docker-compose.prod.yml exec postgres psql -U ddintake ddintake
```

**Importing the leads recorded before Postgres** (the `lead.json` objects of the S3-only
version, left in place): idempotent, safe to re-run.
```bash
docker compose -f docker-compose.prod.yml run --rm intake node dist/tools/import-from-s3.js
```

**Backups.** The box is no longer disposable: the leads live in `pg_data`. Until a scheduled dump
exists, run one by hand after each batch of leads and keep it outside the box:
```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U ddintake -Fc ddintake > ddintake-$(date +%F).dump
aws s3 cp ddintake-$(date +%F).dump s3://imobile-private-files/dd-experiment/backups/
```
Restore with `pg_restore -U ddintake -d ddintake --clean` inside the container.

## 1. S3 (existing bucket, new prefix)

Bucket `imobile-private-files`, region `eu-central-1`, prefix `dd-experiment/`.
Nothing in fileservice touches that prefix (it uses `temporary/`, `invoices/`
and per-user folders, and deletes only keys it recorded in Scylla).

1. **IAM user** `dd-intake` (created 2026-09-09), programmatic access only, with the inline
   policy in `deploy/s3-iam-policy.json`: put and get under the prefix, listing of the prefix,
   and `ses:SendEmail` from `*@raportcf.ro` (see section 2b), nothing else, no delete.
   Re-apply after editing: `aws iam put-user-policy --user-name dd-intake --policy-name dd-intake-s3 --policy-document file://deploy/s3-iam-policy.json`. Do not reuse fileservice's keys: the `.env` on a single VPS is the
   weakest point of this setup. To rotate the key:
   ```bash
   aws iam create-access-key --user-name dd-intake      # -> new AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
   aws iam delete-access-key --user-name dd-intake --access-key-id <old id>
   ```
   (To recreate from scratch: `create-user`, then `put-user-policy --policy-name dd-intake-s3
   --policy-document file://deploy/s3-iam-policy.json`.)
2. **Lifecycle** (applied 2026-09-09): `deploy/s3-lifecycle.json` is the bucket's COMPLETE
   lifecycle configuration, the pre-existing "Expire temporary objects" rule (10 days on
   `temporary/`) plus `dd-experiment/` at 90 days. `put-bucket-lifecycle-configuration` replaces
   everything, so edit this file, never a single rule, and re-read the bucket first if someone
   may have changed it elsewhere:
   ```bash
   aws s3api get-bucket-lifecycle-configuration --bucket imobile-private-files
   aws s3api put-bucket-lifecycle-configuration --bucket imobile-private-files --lifecycle-configuration file://deploy/s3-lifecycle.json
   ```
3. The bucket already encrypts by default (AES256, bucket key) and blocks all public access;
   objects are additionally written with `ServerSideEncryption: AES256`. No bucket CORS is
   needed, the browser never talks to S3 directly.

## 2b. Email (SES)

The report email is sent with the SES v2 API from `SES_FROM` (default `Raport CF <raport@raportcf.ro>`)
using the `dd-intake` keys. One-time setup, all in `eu-central-1` (the platform's SES account, already
out of the sandbox if production Keycloak mails users; check with `aws sesv2 get-account`):

1. `aws sesv2 create-email-identity --email-identity raportcf.ro` and add the three DKIM CNAMEs it
   returns to the Bunny DNS zone (864529). Wait for `aws sesv2 get-email-identity --email-identity raportcf.ro`
   to show `DkimStatus: SUCCESS`.
2. Bunny DNS: TXT `raportcf.ro` = `v=spf1 include:amazonses.com ~all` and TXT `_dmarc.raportcf.ro` =
   `v=DMARC1; p=quarantine; rua=mailto:office@knoha.eu`. A new domain with no reputation lands in spam
   without these.
3. `SES_REPLY_TO` to a mailbox someone reads (the address in the email says "răspunde la acest email").
   Nothing receives mail at `raport@raportcf.ro` unless you set up a mailbox or a forward.
4. Re-apply the IAM policy (section 1).

With `SES_FROM` empty (local compose) the intake logs the email instead of sending it and the admin
page says so. Send failures are logged with the SES error name and shown on the admin page; the
counters only move when SES accepted the message.

## 2. Slack

Reuses the platform's existing Slack bot: `SLACK_BOT_TOKEN` is `slack.oauth.token` from the
`streamprocessing-secret` in Secrets Manager and `SLACK_CHANNEL` the channel the bot already
posts DD alerts to (`due-diligence`). The service calls `chat.postMessage` and checks Slack's
`ok` flag, since Slack returns HTTP 200 for `not_in_channel` or `invalid_auth`. An incoming
webhook in `SLACK_WEBHOOK_URL` works as a fallback when no token is set. Both are credentials:
only in the box's `.env`, never in git or logs. Messages carry the lead id, property type,
whether the CF is to be obtained, source and the admin link. Email and phone stay out of Slack.

## 3. The box (netcup, Docker + Caddy + Fastify)

DNS: `api.raportcf.ro` A record -> box IP. Firewall: 443 open (TCP, and UDP for HTTP/3), 22 restricted to your IP, everything else closed. Port 80 stays closed: Caddy uses the TLS-ALPN-01 challenge on 443 for issuing and renewing, so there is no plain-HTTP redirect either.

```bash
# on the box
apt-get install -y docker.io docker-compose-plugin      # or the docker.com repo
mkdir -p /opt/dd-intake && cd /opt/dd-intake

# from your machine
rsync -a --exclude node_modules --exclude dist --exclude landing --exclude .env dd-report-experiment/ root@<box>:/opt/dd-intake/

# on the box
cd /opt/dd-intake
cp .env.example .env && chmod 600 .env
docker run --rm caddy:2 caddy hash-password --plaintext 'a-long-admin-password'   # -> ADMIN_PASSWORD_HASH
vi .env                                                  # AWS keys, Slack URL, admin user + hash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f
```

Environment variables (`.env.example` is the reference):

| Variable | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the `dd-intake` IAM user |
| `AWS_REGION` | `eu-central-1` |
| `S3_BUCKET`, `S3_PREFIX` | `imobile-private-files`, `dd-experiment` |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | empty on AWS; MinIO endpoints for the local compose |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Postgres; only the password is a secret, it also seeds the container |
| `SES_FROM`, `SES_REPLY_TO`, `SES_REGION` | report email; empty `SES_FROM` disables sending (logged instead) |
| `REPORT_LINK_TTL_SECONDS`, `MAX_REPORT_BYTES` | lifetime of the S3 links inside the customer's report page (15 min); report PDF cap (40 MB) |
| `SLACK_WEBHOOK_URL` | incoming webhook; if empty the service logs a warning and still saves the lead |
| `PUBLIC_BASE_URL` | used in the Slack message for the admin link |
| `ALLOWED_ORIGINS` | CORS allowlist, the landing page origins only |
| `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `ADMIN_ALLOWED_IP` | Caddy basic auth and client IP allowlist for `/admin/*` (read by Caddy, not by the service) |
| `PRESIGNED_URL_TTL_SECONDS` | download links on the admin page, max 7 days |
| `MAX_FILE_BYTES`, `MAX_FILES_PER_LEAD`, `MAX_FILES_PER_REQUEST` | upload caps; defaults 10 MB and 28 files, the original flow's limits plus 10 other documents |

Caddy notes (`deploy/Caddyfile`):
- TLS is automatic over 443 only (TLS-ALPN-01, `disable_http_challenge`); the `caddy_data`
  volume holds the certificates. Do not `docker compose down -v`, re-issuing hits the Let's
  Encrypt rate limit.
- `request_body max_size` in the Caddyfile is above the service's own caps so
  the service, not Caddy, returns the readable error.
- Caddy overwrites `X-Forwarded-For` with the real client IP and Fastify runs
  with `trustProxy`, so rate limits and logged IPs are per visitor.
- `/admin/*` answers only to `ADMIN_ALLOWED_IP` (403 for any other client, checked
  before the password prompt) and then requires basic auth. Use a long password. If your IP
  changes, update `.env` and restart Caddy; the API routes stay public because the form on
  raportcf.ro calls them.

Checks after deploy:
```bash
curl https://api.raportcf.ro/health
curl -u vladian https://api.raportcf.ro/admin/leads
```

## 4. Landing page on Bunny

The landing is the Angular page itself, not a rewrite. `landing/tools/extract-from-build.py`
reads the frontend's prerendered `dist/frontend/browser/ro/verificare-proprietate/index.html`
(every component style is inlined there) and produces `landing/index.html` with the Angular
runtime stripped, the site header replaced by a minimal bar with a round brand mark, the CTAs
wired, the second guide list added, and the cookie banner appended. It also generates `cerere.html` (the lead
form), `multumim.html` and `confidentialitate.html` from `landing/src/*.body.html` using the
same header, the same inline component styles and the real `app-button` markup.

Regenerate whenever the Angular page changes:
```bash
cd frontend && npx ng build            # or whatever produced dist/frontend/browser/ro
cd ../dd-report-experiment/landing && python3 tools/extract-from-build.py
```

Then build and upload (`landing/.bunny.env` holds the storage zone name and key, see
`.bunny.env.example`; the script PUTs every file in `dist/` through the Storage API and purges
the pull zone when the account key and pull zone id are set):
```bash
cd landing && npm install && npm run deploy     # build (terser + lightningcss -> dist/) + upload + purge
```
Upload the contents of `dist/` to the root of the storage zone behind `raportcf.ro`, so the
landing is `https://raportcf.ro/` and the form `https://raportcf.ro/cerere.html` (`index.html`
as the directory index, custom hostname `raportcf.ro` plus `www` with TLS on the pull zone). All links inside are relative, the images and the example
PDF load from `static.knoha.eu`. Purge the pull zone after each upload.

Flow: landing -> "Obține raportul" or "Cumpără serviciul CF" -> `cerere.html` -> `multumim.html`.
The form is one screen and stores no property details: property type (apartment or land),
email and a Romanian mobile number (both required, validated with the app's own rules on the
page and again in the service, phone stored as +407XXXXXXXX), and exactly one of: the CF as a PDF, the CF as up to 12 photos, or the
"Nu ai CF-ul? Îl obținem noi" checkbox with the cadastral number (`XXXXXX-CX-UX`). Apartments
can add the parking CF (PDF or up to 4 photos). An optional "Alte documente" block takes up to
10 PDFs or photos of anything else the buyer has (contract, plan, energy certificate), to learn
what people actually hold. The submit button stays disabled while
anything is missing or invalid, and hovering or tapping it shows the app's tooltip bubble with
the first problem, in the app's wording. Submit opens a progress modal modelled on the
app's request-progress modal: "Salvăm cererea" (`POST /leads`, which returns the id) then
"Încărcăm documentele" (`POST /leads/:id/files`), each row with spinner, success, or error
with a retry link; the second row is skipped when only a cadastral number was given. Files are
stored under `files/<kind>/` with kind `cf`, `cfPhoto`, `parkingCf`, `parkingCfPhoto` or
`other`; the multipart field names are `cf`, `cfPhotos`, `parkingCf`, `parkingCfPhotos`,
`otherDocuments`.

Before going live edit the top of `landing/app.js`:
- `API_BASE` if the intake host differs from `api.raportcf.ro`.
- `GOOGLE_ADS_ID` and `GOOGLE_ADS_CONVERSION` (Ads -> Goals -> Conversions,
  a "Lead" conversion of type website; the label comes from the tag snippet).
- `META_PIXEL_ID`.
- `CLARITY_ID` for Microsoft Clarity session recordings and heatmaps, loaded behind the same
  consent as the ad tags. Custom events fired: `cta_request`, `example_report`,
  `lead_validation_failed`, `lead_submitted`, `files_uploaded`, `upload_skipped`,
  `lead_converted`; the hero variant is set as a Clarity custom tag, so recordings can be
  filtered per variant.
- `GA4_ID`, optional; it receives the same events.

Tags load only after the visitor accepts the cookie banner (Consent Mode v2
defaults are denied, which is mandatory for Google Ads in the EEA). The
conversion fires once on `multumim.html`, keyed by the lead id, so a refresh
does not double count. `gclid`, `fbclid`, `_fbp`, `_fbc`, the utm parameters,
the referrer and the hero variant are stored with each lead, so cost per lead
per channel can be computed from the `leads.attribution` column alone even when the pixel is
blocked.

Hero copy is the page's A/B/C test (`dd-landing-2026-08`), sticky per browser
in `localStorage`; force a variant with `?v=b` when reviewing. Variant `a` is
the control and is what the prerendered HTML contains.

## 5. Manual fulfilment

Slack ping -> open the admin link -> download the files via the presigned
links, or obtain the CF from the cadastral number when the lead asked for that -> produce the
report -> on the lead's admin page upload the PDF ("Încarcă raportul") -> "Trimite emailul cu
linkul". The page shows the customer link, how many times the email was sent and when the link
was last opened; the list page shows the same per lead (încărcat / trimis / văzut). A re-upload
replaces the PDF and keeps the same link. The admin POSTs refuse cross-site requests
(`Sec-Fetch-Site`), since the browser would otherwise attach the basic-auth credentials to a
form posted from any other site.

Export everything at the end of the test:
```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U ddintake ddintake -c "\copy (select * from leads order by created_at) to stdout csv header" > leads.csv
```

## 6. Legal

`landing/confidentialitate.html` is a draft with a placeholder for the
operator identity. It states the 90 day retention, the AI processing and the
EU storage. Have it reviewed before spending on ads.

## Local development (full stack in Docker)

`docker-compose.local.yml` runs the whole thing on your machine: the built landing behind
Caddy on `http://localhost:18080/`, the intake API behind Caddy on
`http://localhost:18081` (a different origin, so CORS is exercised like Bunny + api.raportcf.ro),
Postgres for the leads (psql on `localhost:15432`, user and password `ddintake`), MinIO instead
of S3, and an HTTP echo container instead of Slack. Emails are logged, not sent.

```bash
cd landing && npm install && npm run build && cd ..
docker compose -f docker-compose.local.yml up --build
```

Then:
- open `http://localhost:18080/`, submit a lead, upload a file;
- `docker compose -f docker-compose.local.yml logs slack-mock` shows the Slack messages that
  would have been posted;
- `http://localhost:18081/admin/leads` (admin / admin) lists the leads with working presigned
  links, served by MinIO on `localhost:19190`;
- MinIO console on `http://localhost:19191` (minioadmin / minioadmin), bucket
  `imobile-private-files`, prefix `dd-experiment/`.

On `localhost` `app.js` calls the API on `http://localhost:18081`, whatever serves the page:
Caddy from the compose, IntelliJ's built-in server on 63342 (`landing/cerere.html` opened from
the IDE works against the running stack, that origin is in the CORS allowlist), or `npx serve`.
If you run the API on another port, open the page once with `?api=http://localhost:<port>`; it
is remembered in `localStorage`. All four host ports are compose variables (`LANDING_PORT`,
`API_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`) for when one is taken. After editing the landing, rerun `npm run build`; Caddy serves `landing/dist`
directly, so a refresh is enough. After editing the service, rerun compose with `--build`.

The two differences from production: MinIO gets no server-side-encryption header (it has no
KMS), and TLS is off.

Without Docker, `cd intake && npm run dev` runs the service alone against real AWS keys in
`intake/.env`, and `npx serve landing/dist` serves the page on another port; add that origin
to `ALLOWED_ORIGINS` and point `API_BASE` at the service.
