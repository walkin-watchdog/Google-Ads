---
title: Google Ads Cloud Dashboard
emoji: 📊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# Google Ads Server + Dashboard + Local MCP Server

This repository contains the complete Google Ads Dashboard backend and browser dashboard. It fetches Google Ads data, stores normalized dashboard payloads in PostgreSQL, exposes read-only MCP tools for AI agents, and can serve the dashboard either through backend-hosted magic links or a local `file://` client.

## Features
- **Remote Heavy Lifting:** Google Ads API fetching is handled in the cloud (no local API timeouts).
- **Bun + TypeScript:** Backend scripts, server, telemetry, and dashboard payload builders run on Bun.
- **Postgres Storage:** Processed payloads, proposals, impact tracking, lead attribution, and semantic memory are stored in PostgreSQL.
- **Scoped MCP Server:** AI Agents can read dashboard data, create proposal/diagnosis cards, refresh the warehouse, and use preview-confirm mutation tools through scoped MCP API keys without Google Ads credentials.
- **Lead Quality + Offline Conversion Support:** First-party lead webhooks dedupe sessions, track quality, and export upload-ready offline conversion CSVs.
- **Previewed Google Ads Controls:** Supported account mutations use a preview-confirm-execute pipeline with audit rows and fail-closed execution flags.
- **Keyword Planner and Auction Insights:** Keyword Planner enrichment comes from Google Ads endpoints; Auction Insights are read from configured Google Sheets exports.

Backend is the **fact engine**. The external AI is the **analyst**.

Backend remains deterministic and evidence-producing, while the AI does judgment externally via MCP

---

## Zenseeo Dashboard Login, PWA, Push, and Offline Mode

The hosted dashboard is an installable PWA named **Zenseeo**. The app shell, local fonts, icons, vendor JavaScript, and service worker are public static files; private dashboard data remains behind the existing `HttpOnly` dashboard session cookie and authenticated JSON APIs.

Named dashboard admins are managed through MCP admin tools:

```text
create_dashboard_user
list_dashboard_users
resend_dashboard_user_invitation
disable_dashboard_user
enable_dashboard_user
revoke_dashboard_user_sessions
```

`create_dashboard_magic_link` remains available for emergency/admin access. Magic sessions can use the online dashboard but cannot own push subscriptions or private offline data.

Named logins are multi-session: the same active admin can stay signed in on multiple browsers/devices. Password reset, disabling the user, or `revoke_dashboard_user_sessions` revokes all of that user's sessions; an ordinary login does not revoke another device.

Email invitations and password resets require SMTP settings:

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_REPLY_TO=
PUBLIC_DASHBOARD_BASE_URL=https://dashboard.yourdomain.com
```

Web Push is intentionally off by default. Generate VAPID keys with:

```bash
cd backend
bunx web-push generate-vapid-keys
```

Then set:

```env
WEB_PUSH_ENABLED=true
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
PUSH_DELIVERY_TIMEOUT_MS=20000
```

`PUSH_DELIVERY_TIMEOUT_MS` bounds each provider socket attempt so a stalled push endpoint cannot hold the delivery worker indefinitely; transient timeouts follow the normal retry schedule.

Treat each VAPID key pair as one atomic secret. To rotate it, first deploy with `WEB_PUSH_ENABLED=false`, generate a new pair, replace both VAPID keys together, deploy, and then re-enable push. Existing browser subscriptions are bound to the old public key; each device must open Zenseeo and tap **Enable notifications** again. The client detects a mismatched application-server key and replaces that device subscription after the explicit tap.

Production PWA and push require HTTPS; `localhost` is the browser development exception. On iPhone/iPad, push works only from an iOS/iPadOS 16.4+ Home Screen web app, and permission must be requested from the in-app Enable notifications button. No Apple Developer membership is required.

Recommended rollout:

1. Deploy with `WEB_PUSH_ENABLED=false`.
2. Verify migrations, login, magic links, invite/reset email, logout, disabled-user rejection, and the installable PWA shell.
3. Create the first named admin through MCP.
4. Confirm the dashboard makes no third-party CDN requests.
5. Set VAPID keys and enable `WEB_PUSH_ENABLED=true`.
6. Enable notifications from two devices and send one new first-party lead webhook.

Push notifications are sent only for genuinely new first-party lead sessions created by `/api/webhooks/leads`. Duplicate webhook deliveries, qualification progress, manual lead labels, and retries do not create extra notifications. Notification lock-screen text avoids contact names, email addresses, phone numbers, messages, and raw webhook bodies.

Offline mode is deliberately bounded. After a named admin has used the app online, the app can reopen the warmed dashboard views for Overview, Campaigns, Keywords, Leads, Rank, and Proposals for up to seven days. It stores private JSON in per-user IndexedDB records, never in Cache Storage, and never stores auth cookies, CSRF values, reset tokens, SMTP data, Google credentials, or browser auth tokens. The only offline mutation is a Lead Review status change; stale changes stop at a conflict prompt and never overwrite the server silently. Mobile operating systems can still evict browser storage under pressure, so first login and password reset always require a network connection.

---

## Google Ads Mutation Controls

The browser dashboard and MCP mutation tools support only:

- positive keyword add/remove,
- campaign/ad-group negative keyword add/remove,
- campaign ad schedule add/remove/replace,
- campaign/ad-group pause/resume.

Browser controls are intentionally placed where operators already review the affected entity: campaign status on `Campaigns`, ad group status on `Ad Groups`, keyword and negative keyword controls on the `Keywords` page subtabs, ad schedule controls on `Ad Schedule`, and successfully executed mutation audit rows on `Activity History`. Ad schedule day presets expand into individual days and any overlapping proposed intervals must be resolved by replacing existing conflicting schedules or keeping them and skipping the overlapping proposed days before preview. Offline conversion uploads remain pull-CSV/API-only; the `Conversions` page `Auth` tab only manages DB-backed Basic Auth credentials for Google Ads Data Manager.

Execution is disabled unless this flag is set:

```env
GOOGLE_ADS_MUTATIONS_ENABLED=true
GOOGLE_ADS_MUTATION_CONFIRM_TTL_MINUTES=10
```

All mutations must be previewed first. Preview returns a diff, operation summary, confirmation token, and expiry; preview state is transient and is not shown in Activity History. Confirm requires the token and stores only successfully executed results in `google_ads_mutation_requests`. Confirmation tokens are stored only as SHA-256 hashes for executed rows. Account-level/shared-list negative creation, deletes of campaigns/ad groups, budget changes, bid changes, ad edits, and direct offline upload calls are intentionally out of scope.

For Google Ads Data Manager offline conversion pulls, use `GET /api/analytics/offline-conversions.csv` with Basic Auth. Configure, reveal, or rotate those Basic Auth credentials from the logged-in dashboard under `Conversions` → `Auth`; PostgreSQL stores the username, a salted password hash for verification, and an encrypted password copy for dashboard reveal. The logged-in dashboard CSV remains `GET /api/leads/offline-conversions.csv`.

---

## ☁️ Deployment Guide

This repository supports two deployment modes from the same backend code:

- **Hugging Face + Neon (`DEPLOYMENT_MODE=hf`)**: the existing hosted setup. Hugging Face runs the Docker backend and Neon provides PostgreSQL.
- **VPS + local PostgreSQL (`DEPLOYMENT_MODE=vps`)**: a normal VPS such as OCI `VM.Standard.E2.1.Micro` runs both the Bun backend and a local `pgvector` PostgreSQL container through Docker Compose.

Use **Neon.tech** for a permanently free PostgreSQL database when deploying on Hugging Face. For the web service hosting, Hugging Face Spaces is still supported because it supports Docker deployments with **100% free, unlimited outbound bandwidth** and runs on 16 GB RAM. Use the VPS path when you want to move both backend and database to your own server.

The important runtime switches added for these modes are:

- `DEPLOYMENT_MODE`: `hf`, `vps`, or `local`.
- `DATABASE_SSL`: `require` for Neon/remote SSL PostgreSQL, `disable` for the local Docker PostgreSQL service on VPS.
- `STARTUP_REFRESH`: enables a refresh after the migrated HTTP server is healthy. It no longer delays server availability; the normal refresh-queue worker starts after this isolated startup refresh exits so the two executors cannot compete. Keep it `false` on small VPS machines to avoid refresh load competing with dashboard traffic.
- `DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS`: named sessions are still revalidated against the current user on every request, but their rolling idle lease is written at most once per interval (default `300`) to avoid PostgreSQL write amplification.
- `MCP_API_KEYS_JSON`: required when `NODE_ENV=production`; MCP no longer accepts `SECRET_API_KEY` as a fallback.

Generate a scoped MCP key pair before production deploys:

```bash
cd backend
bun run mcp:generate-key ads-prod
```

Set the printed `MCP_API_KEYS_JSON` on the backend. Set the printed `MCP_API_KEY` only in the MCP client/proxy environment. `MCP_API_KEYS_JSON` is the full JSON array with `name`, `sha256`, and `scopes`, not just the hash.

### Step 1: Choose the Deploy Target

Only one GitHub deployment workflow should be active for normal pushes.

- VPS deploy workflow: `backend/.github/workflows/deploy-vps.yml`
- Hugging Face fallback workflow: `backend/.github/workflows/sync-hf-space.yaml`

For VPS deploys, create a GitHub **Environment** named `VPS`. The VPS workflow attaches to that environment, so environment-level secrets and variables are available to the job.

The VPS workflow runs on pushes to `main` and manual dispatch. The Hugging Face workflow is manual-only, so it will not deploy or show skipped jobs on normal VPS pushes.

If you later want to manually run the Hugging Face fallback workflow, set this repository variable in the **backend repository** before running it:

```text
DEPLOY_TARGET=hf
```

Then run `backend/.github/workflows/sync-hf-space.yaml` manually. For VPS-only operation, no `DEPLOY_TARGET` variable is required.

If you want to make Hugging Face impossible to trigger accidentally, remove or comment out `workflow_dispatch:` in `backend/.github/workflows/sync-hf-space.yaml`.

---

### Step 2A: Create the Neon Database for Hugging Face Mode

Use this section only when deploying the backend to Hugging Face.

1. Go to [Neon.tech](https://neon.tech) and sign up/log in.
2. Create a new project and database.
3. On your dashboard, find the **Connection Details**.
4. Copy the **Postgres Connection String** with Connection Pooling enabled (e.g., `postgresql://neondb_owner:password@ep-cool-db-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require`).

---

### Step 2B: Prepare the VPS Database for VPS Mode

Use this section when moving both backend and database to a VPS. The provided Compose stack runs:

- `db`: `pgvector/pgvector:pg18`
- `app`: this Bun backend
- persistent Docker volume `postgres_data`

Prepare the VPS once. On OCI, open inbound `22/tcp`, `80/tcp`, and `443/tcp` in the instance NSG or security list first. Then configure the instance firewall before enabling it:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates git curl unzip gnupg ufw

sudo ufw allow OpenSSH
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Install Docker and the Docker Compose plugin:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo reboot
```

After reconnecting over SSH, verify Docker:

```bash
docker --version
docker compose version
```

The VPS host only needs Docker Engine and the Docker Compose plugin. The backend runs inside the `oven/bun` container, Docker Compose handles process restart with `restart: unless-stopped`, and PostgreSQL/pgvector run in the `pgvector/pgvector` container.

Create the VPS env file from `backend/.env.vps.example`. When using `docker-compose.vps.yml`, do **not** manually set `DATABASE_URL` in the VPS env file. Compose builds it for the app container from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`:

```text
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
```

The values you do set in `VPS_ENV_FILE` are:

```env
DEPLOYMENT_MODE=vps
NODE_ENV=production
PORT=7860
HOST_BIND=0.0.0.0
HOST_PORT=7860

POSTGRES_DB=google_ads
POSTGRES_USER=google_ads
POSTGRES_PASSWORD=change-this-to-a-strong-password
DATABASE_SSL=disable

SECRET_API_KEY=
MCP_API_KEYS_JSON=
LEAD_WEBHOOK_SECRET=
PUBLIC_DASHBOARD_BASE_URL=http://YOUR_VPS_PUBLIC_IP:7860
SERVE_DASHBOARD_CLIENT=true
DASHBOARD_CORS_ORIGINS=
DASHBOARD_TRUST_PROXY=false

GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_SHEETS_REFRESH_TOKEN=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
GOOGLE_ADS_CUSTOMER_ID=
GOOGLE_ADS_WAREHOUSE_START_DATE=2026-05-06

STARTUP_REFRESH=false
GOOGLE_ADS_REFRESH_FETCH_CONCURRENCY=1
TRIGGER_REFRESH_MIN_INTERVAL_MINUTES=360
DASHBOARD_DB_POOL_MAX=1
```

Manual VPS deployment:

```bash
cd backend
cp .env.vps.example .env.vps
# edit .env.vps: set POSTGRES_PASSWORD, SECRET_API_KEY, MCP_API_KEYS_JSON, Google Ads credentials, and PUBLIC_DASHBOARD_BASE_URL
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --build
curl http://127.0.0.1:7860/healthz
```

For temporary direct-IP testing before Caddy, open `7860/tcp` in both UFW and the OCI security list/NSG, keep the default `HOST_BIND=0.0.0.0`, and test `http://YOUR_VPS_PUBLIC_IP:7860/healthz`. After HTTPS works through Caddy, prefer `HOST_BIND=127.0.0.1` and close public `7860/tcp`.

For HTTPS with Caddy, point a DNS `A` record for your domain to the VPS public IP, keep `80/tcp` and `443/tcp` open in OCI and UFW, and use these VPS env values:

Use a neutral hostname such as `dashboard.yourdomain.com`. Avoid `ads.*`, `ad.*`, `analytics.*`, and `tracking.*`: Safari content blockers can reject those hostnames before Zenseeo, its service worker, or its error handling runs.

When migrating an existing `ads.*` deployment, create the neutral DNS record and TLS virtual host first, then update `PUBLIC_DASHBOARD_BASE_URL` and `DASHBOARD_CORS_ORIGINS`. A redirect on the old hostname is not a blocker workaround because the blocker may reject the request before the redirect. PWA installation, notification permission, service workers, IndexedDB, and push subscriptions are origin-bound, so users must open/install the neutral origin and enable notifications there once; the server safely upserts the new per-origin subscription.

```env
HOST_BIND=127.0.0.1
HOST_PORT=7860
PORT=7860
PUBLIC_DASHBOARD_BASE_URL=https://dashboard.yourdomain.com
DASHBOARD_CORS_ORIGINS=https://dashboard.yourdomain.com
DASHBOARD_TRUST_PROXY=1
```

Run Caddy on the VPS after DNS resolves:

```bash
sudo mkdir -p /opt/caddy
sudo tee /opt/caddy/Caddyfile >/dev/null <<'EOF'
dashboard.yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7860
}
EOF

docker rm -f caddy 2>/dev/null || true

docker run -d \
  --name caddy \
  --restart unless-stopped \
  --network host \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2
```

Caddy automatically issues and renews the HTTPS certificate when DNS points to the VPS and ports `80` and `443` are reachable. Verify it with:

```bash
docker logs caddy --tail=100
curl -I https://dashboard.yourdomain.com/healthz
```

Micro defaults in `backend/.env.vps.example` intentionally set `STARTUP_REFRESH=false`, `GOOGLE_ADS_REFRESH_FETCH_CONCURRENCY=1`, `DASHBOARD_DB_POOL_MAX=1`, and smaller cache/row limits. Run refreshes manually or with low-frequency cron:

```bash
cd backend
docker compose --env-file .env.vps -f docker-compose.vps.yml exec app bun run refresh
```

For the first backfill:

```bash
cd backend
docker compose --env-file .env.vps -f docker-compose.vps.yml exec app bun run backfill
```

---

### Step 3A: Deploy on Hugging Face Spaces

Hugging Face Spaces Docker builds expect a `Dockerfile` in the Space repository root. In this repo, deploy the `backend/` directory as the Space repository root.

1. Extract or sync `backend/` into the Space repository.
2. Go to [Hugging Face Spaces](https://huggingface.co/spaces) and sign up/log in.
3. Click **Create new Space**.
4. Configure the Space settings:
   - **Space Name:** Choose a name (e.g., `google-ads-dashboard`).
   - **License:** Choose any license (e.g., `mit`).
   - **SDK:** Select **Docker**.
   - **Docker Template:** Select **Blank** (do not select any template).
   - **Space Hardware:** Select **CPU Basic** (100% free, 2 vCPUs, 16 GB RAM at the time this guide was written).
   - **Space Visibility:** Select **Public** or **Private**. Private is recommended to secure your dashboard. Non-MCP dashboard/admin API routes are protected by `SECRET_API_KEY`; MCP routes are protected by scoped `MCP_API_KEYS_JSON`/`MCP_API_KEY`.
5. Click **Create Space**.
6. Go to your Space's **Settings** tab.
7. Scroll down to **Variables and Secrets** and click **New secret** to add all required environment variables. You can use `backend/.env.hf.example` as the checklist:
   - `DEPLOYMENT_MODE`: Set to `hf`.
   - `DATABASE_URL`: Paste the Neon connection string from Step 2A.
   - `DATABASE_SSL`: Set to `require`.
   - `SECRET_API_KEY`: Create a strong random password for non-MCP backend/dashboard API access (e.g., `MySuperSecretKey123!`).
   - `MCP_API_KEYS_JSON`: Required in production for MCP. Generate it with `cd backend && bun run mcp:generate-key ads-prod` and paste the printed full JSON array.
   - `PORT`: Set this to `7860` (Hugging Face requires containers to listen on port `7860`).
   - `STARTUP_REFRESH`: Set to `true` to run the isolated startup refresh after the server becomes healthy; the normal queue worker starts afterward.
   - *Add your Google Ads credentials. The backend accepts the shorter names below and the `GOOGLE_ADS_*` aliases used in `backend/.env.example`:*
     - `GOOGLE_DEVELOPER_TOKEN` or `GOOGLE_ADS_DEVELOPER_TOKEN`
     - `GOOGLE_CLIENT_ID` or `GOOGLE_ADS_CLIENT_ID`
     - `GOOGLE_CLIENT_SECRET` or `GOOGLE_ADS_CLIENT_SECRET`
     - `GOOGLE_REFRESH_TOKEN` or `GOOGLE_ADS_REFRESH_TOKEN`
     - `GOOGLE_LOGIN_CUSTOMER_ID` or `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
     - `GOOGLE_CUSTOMER_ID` or `GOOGLE_ADS_CUSTOMER_ID` *(optional; pins the customer instead of using the first accessible account)*
     - `GOOGLE_SHEETS_REFRESH_TOKEN` *(needed for Auction Insights Google Sheets; use a token with Google Sheets and Drive read access)*
     - `LEAD_WEBHOOK_SECRET` *(optional but recommended; defaults to `SECRET_API_KEY` when missing)*
     - `KEYWORD_PLANNER_URL` *(optional; defaults to `https://zenseeo.com`)*
     - `KEYWORD_PLANNER_GEO_TARGETS` *(optional; defaults to India, `geoTargetConstants/2356`)*
     - `KEYWORD_PLANNER_LANGUAGE` *(optional; defaults to English, `languageConstants/1000`)*
     - `KEYWORD_PLANNER_NETWORK` *(optional; defaults to `GOOGLE_SEARCH`)*
     - `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS` *(optional; defaults to `24`; set `0` to fetch Planner data on every refresh)*
     - `GOOGLE_ADS_FETCH_TIMEOUT_MS` *(optional; defaults to `25000`)*
     - `GOOGLE_ADS_API_VERSION` *(optional; defaults to `v24`; must match `v<major>`)*
     - `GOOGLE_ADS_STREAM_BATCH_SIZE` *(optional; defaults to `5000`; refresh persistence batch size for SearchStream rows)*
     - `GOOGLE_ADS_STREAM_TOTAL_DEADLINE_MS`, `GOOGLE_ADS_MAX_RETRIES`, `GOOGLE_ADS_RETRY_BASE_MS`, `GOOGLE_ADS_RETRY_MAX_MS` *(optional; control Google Ads read/searchStream retry and deadline behavior; live mutate execution is not retried)*
     - `GOOGLE_ADS_QUOTA_GOVERNOR_ENABLED`, `GOOGLE_ADS_QUOTA_DEVELOPER_REQUESTS_PER_MINUTE`, `GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE`, `GOOGLE_ADS_QUOTA_MUTATE_REQUESTS_PER_MINUTE`, `GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS`, `GOOGLE_ADS_QUOTA_MAX_WAIT_MS`, `GOOGLE_ADS_QUOTA_RESOURCE_EXHAUSTED_PAUSE_MS`, `GOOGLE_ADS_QUOTA_SHORT_TERM_RESOURCE_EXHAUSTED_PAUSE_MS`, `GOOGLE_ADS_QUOTA_LONG_TERM_RESOURCE_EXHAUSTED_PAUSE_MS` *(optional; control the shared Postgres-backed Google Ads quota governor; set rolling operations to `15000` for Basic, `2880` for Explorer, or `0` for Standard/unlimited access)*
     - `GOOGLE_ADS_WAREHOUSE_START_DATE` *(required for the first warehouse backfill)*
     - `GOOGLE_ADS_MUTABLE_LOOKBACK_DAYS` *(optional; defaults to `90` for the Data button, eligible no-window HTTP cron, and direct/manual rolling refreshes; App/native browser reloads and cron calls inside the full-refresh cooldown use today only)*
     - `GOOGLE_ADS_STARTUP_LOOKBACK_DAYS` *(optional; defaults to `14` for the refresh run inside `bun run start` after the warehouse exists)*
     - `TRIGGER_REFRESH_MIN_INTERVAL_MINUTES` *(optional; defaults to `360`; controls the full no-body cron refresh interval, while cron calls inside that interval fall back to a today-only light refresh)*
     - `REFRESH_QUEUE_POLL_INTERVAL_MS`, `REFRESH_QUEUE_HEARTBEAT_MS`, `REFRESH_QUEUE_STALE_AFTER_MS`, `REFRESH_JOB_TIMEOUT_MS` *(optional; defaults to `30000`, `15000`, `1200000`, and `900000`; control the Postgres-backed refresh queue worker, stale job recovery, and child refresh timeout)*
     - `DASHBOARD_DB_CACHE_MAX_BYTES` *(optional; defaults to `2000000`; larger dashboard ads payloads are kept out of Neon JSONB cache rows)*
     - Dashboard warehouse watermarks are maintained in `google_ads_warehouse_slice_fingerprints` during warehouse writes and schema migration backfill, so cached dashboard slices validate freshness with one fingerprint-table read instead of scanning every warehouse source table.
     - `DASHBOARD_MEMORY_CACHE_SECONDS`, `DASHBOARD_MEMORY_CACHE_MAX_ENTRIES`, `DASHBOARD_MEMORY_CACHE_MAX_BYTES` *(optional; defaults to `600`, `10`, and `25000000` for process-local ads payload caching)*
     - `DASHBOARD_VIEW_CACHE_SECONDS`, `DASHBOARD_BASE_BUNDLE_CACHE_SECONDS`, `DASHBOARD_FILTER_OPTIONS_CACHE_SECONDS` *(optional; default to `60`; short process caches for browser partial views and shared warehouse reads)*
     - `DASHBOARD_KEYWORD_ROW_LIMIT`, `DASHBOARD_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_PLANNER_ROW_LIMIT` *(optional; defaults to `1500`, `2000`, and `1000`; bounds cold Keywords view rows after SQL aggregation)*
     - `DASHBOARD_RANK_KEYWORD_ROW_LIMIT`, `DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_LANDING_PAGE_ROW_LIMIT`, `DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT` *(optional; defaults to `1000`, `1000`, `500`, and `250`; bounds cold Rank/Proposals support rows; Auction Insights has no raw-row cap because it is summarized server-side)*
     - `DASHBOARD_DB_POOL_MAX`, `DASHBOARD_DB_IDLE_TIMEOUT_MS` *(optional; default to `4` clients and `10000` ms for Neon-friendly dashboard pooling)*
     - `HTTP_COMPRESSION_THRESHOLD_BYTES` *(optional; defaults to `1024`; JSON responses above this size are compressed when the client supports it)*
   - `PUBLIC_DASHBOARD_BASE_URL`: Public URL of your Space once deployed (e.g., `https://username-space-name.hf.space`).
   - `SERVE_DASHBOARD_CLIENT`: Set to `true` to access the dashboard through magic links.
   - `DASHBOARD_CORS_ORIGINS`: Optional comma-separated extra browser origins.
   - `DASHBOARD_TRUST_PROXY`: Express trusted-proxy policy for client-IP throttling and HTTPS detection. The Hugging Face example uses `1` because the container is reached through one trusted proxy; keep `false` for a directly exposed VPS port. Do not enable it merely to accept arbitrary `X-Forwarded-*` headers.
8. Push/sync the `backend/` repo root to the Hugging Face Space repository.

Hugging Face Spaces does not have a direct one-click GitHub connect button. Setup Tokenless Sync via Trusted Publishers:

1. Go to your Space repository settings (e.g., `https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME/settings`).
2. Find **Trusted Publishers** and click **Add a new publisher**.
3. Configure the publisher details:
   - **Provider:** `GitHub Actions`
   - **GitHub Repository Org/Name:** `YOUR_GITHUB_ORG/YOUR_BACKEND_REPO`
   - **Branch:** `main`
   - **Workflow:** `sync-hf-space.yaml`
4. In the backend GitHub repository, set:
   - Variable `DEPLOY_TARGET=hf`
   - Variable `HF_SPACE=YOUR_HF_USERNAME/YOUR_SPACE_NAME`
5. `backend/.github/workflows/sync-hf-space.yaml` will upload the backend repo root to the Space.

Hugging Face will build the container from `backend/Dockerfile` and start the server.

---

### Step 3B: Deploy on VPS with GitHub Actions

Use this section for VPS deployment.

Prepare the VPS once with Docker and SSH access. Then configure the `VPS` GitHub Environment in the backend repository:

- Secret `VPS_HOST`: VPS public IP or hostname.
- Secret `VPS_SSH_KEY`: private SSH key for the deploy user.
- Secret `VPS_ENV_FILE`: full contents of the production `.env.vps`; use `backend/.env.vps.example` as the template.
- Optional variables: `VPS_USER` (default `ubuntu`), `VPS_PORT` (default `22`), `VPS_PATH` (default `/home/ubuntu/google-ads-backend`).

`backend/.github/workflows/deploy-vps.yml` copies the backend repo root to the VPS and runs:

```bash
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --build
```

The app health endpoint on the VPS is:

```bash
curl http://127.0.0.1:7860/healthz
```

After Caddy is configured, the public health endpoint is:

```bash
curl -I https://dashboard.yourdomain.com/healthz
```

---

### Step 4: Move Existing Neon Data to VPS

Install PostgreSQL client tools locally or on the VPS, then dump Neon and restore into the Compose database:

```bash
pg_dump "$NEON_DATABASE_URL" --format=custom --no-owner --no-acl --file=neon.dump
cd backend
docker compose --env-file .env.vps -f docker-compose.vps.yml cp ../neon.dump db:/tmp/neon.dump
docker compose --env-file .env.vps -f docker-compose.vps.yml exec db sh -lc 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/neon.dump'
```

After restore, restart the app:

```bash
docker compose --env-file .env.vps -f docker-compose.vps.yml restart app
```

Do not delete Neon until the VPS dashboard and MCP both read restored data correctly.

---

### Step 5: Setup the Cron Job

Use cron only for scheduled refreshes. An eligible no-window `/api/trigger-refresh` request retains the original full refresh behavior: it refreshes the configured rolling mutable lookback (`GOOGLE_ADS_MUTABLE_LOOKBACK_DAYS`, default `90`), or performs the initial warehouse backfill when the warehouse is empty, and updates Auction Insights and candidate signals. Additional no-window cron calls inside `TRIGGER_REFRESH_MIN_INTERVAL_MINUTES` (default `360`) no longer do nothing: they run a today-only light refresh that preserves Auction Insights and candidate signals. Light App/browser/cron runs do not extend the full-refresh cooldown, so the next full run remains eligible on schedule. Accepted refreshes are stored in the PostgreSQL-backed refresh queue; the in-process worker starts immediately after enqueue and polling is only a recovery backup.

1. Go to [cron-job.org](https://cron-job.org) and create a free account.
2. Click **Create Cronjob**.
3. **URL:** `https://your-app-url/api/trigger-refresh` for Hugging Face, or `http://YOUR_VPS_PUBLIC_IP:7860/api/trigger-refresh` for VPS.
4. **Execution Schedule:** Use a low-frequency schedule for full refreshes, or keep a 14-minute keep-alive with `force` omitted: one eligible call performs the full refresh and calls inside its cooldown perform today-only light refreshes.
5. **Advanced Options > HTTP Headers:**
   - Public/non-gateway backend or VPS: add `Authorization: Bearer YOUR_SECRET_API_KEY` or `X-API-Key: YOUR_SECRET_API_KEY`.
   - Private Hugging Face Space: add both `Authorization: Bearer YOUR_HF_TOKEN` for the Hugging Face gateway and `X-API-Key: YOUR_SECRET_API_KEY` for the backend.
6. **HTTP Method:** `POST`.
7. Optional JSON body for a historical refresh window:
   ```json
   { "startDate": "2026-06-01", "endDate": "2026-06-30" }
   ```
8. Save.

The dashboard's **Data** button keeps the same full rolling/backfill behavior as before and updates Auction Insights and candidate signals. The separate **App** button and a native browser reload reload the UI and trigger a light, today-only incremental refresh using the browser's local calendar date; they preserve the existing Auction Insights rows and candidate signals. This split is uniform for named-user and magic-link sessions on desktop/mobile, installed PWAs, and a directly opened `backend/client/index.html` configured with an API base and key. Scheduled cron has no browser timezone, so its cooldown light refresh uses the server UTC date. While an online dashboard remains open, it checks cron refresh status every 30 seconds; after a new successful or partial cron run, it replaces the in-memory dashboard payload, clears lazy tab caches, and re-renders without reloading the page.

---

### Step 6: Switch Clients from Hugging Face to VPS

When cutting over from HF/Neon to VPS/local PostgreSQL:

- Use the `VPS` GitHub Environment for the VPS workflow secrets and variables.
- Do not manually run `backend/.github/workflows/sync-hf-space.yaml` during VPS operation.
- Update MCP `API_BASE` from the HF URL to `http://YOUR_VPS_PUBLIC_IP:7860` or your VPS domain.
- Remove old `HF_TOKEN` entries from MCP config when using the bundled proxy; `MCP/mcp-server.js` sends only `MCP_API_KEY` to `/api/mcp`.
- Update MCP clients to use `MCP_API_KEY`. `SECRET_API_KEY` can remain the same for dashboard/admin/cron endpoints, but MCP will not use it.
- Update `PUBLIC_DASHBOARD_BASE_URL` in `VPS_ENV_FILE` to the VPS URL or domain.
- Update external cron URLs to the VPS URL.

Public/non-gateway backend and VPS header:

```text
Authorization: Bearer YOUR_SECRET_API_KEY
```

Private HuggingFace Space headers:

```text
Authorization: Bearer YOUR_HF_TOKEN
X-API-Key: YOUR_SECRET_API_KEY
```

---

## 💻 Local Setup

### Prerequisites
- Install [Bun](https://bun.sh/) (Mac/Linux: `curl -fsSL https://bun.sh/install | bash`).

### Option A: Run the Full System Locally
If you want to test the data fetching yourself:
1. Go into the backend directory: `cd backend` and create a local docker db with `sudo docker run -d -p 5433:5432 --name google-ads-db -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg18`
2. Copy `.env.example` to `.env` and fill in your `DATABASE_URL` and Google Ads credentials.
3. Run `bun install`.
4. Run `bun run start`.
5. To serve the bundled dashboard from the backend for local development (The "Client" Mode), set `SERVE_DASHBOARD_CLIENT=true` or open the dashboard through a magic link generated by MCP.

---

## Backend-Hosted Dashboard Access
The deployed backend serves the public PWA shell and an explicit allowlist of static assets from `backend/client`; private dashboard JSON and mutations remain protected. An unauthenticated online shell redirects to `/login`. Remote users can sign in with a named account or open a one-time link created by the MCP tool `create_dashboard_magic_link`. A magic link is exchanged for an HttpOnly dashboard session cookie and does not expose `SECRET_API_KEY` to the browser.

Magic-link dashboard sessions can use only dashboard-safe browser APIs. MCP operations such as raw GAQL, memory mutation, clear/reset tools, and MCP refresh triggers require a scoped `MCP_API_KEY` whose hash is listed in backend `MCP_API_KEYS_JSON`. Direct non-MCP backend/admin endpoints still use `SECRET_API_KEY`; bearer-key dashboard API access is limited to local `file://` (The "Client" Mode) and loopback browser origins for `config.js` use.

---

## Local UI-Only Mode (The "Client" Mode)
You don't need to run a local server to view the dashboard! 
1. Copy `backend/client/config.example.js` to `backend/client/config.js`.
2. Edit `config.js` and set your `API_BASE` (e.g., `https://hfuser-repo.hf.space`), `HF_TOKEN` and `API_KEY`. Keep this file local only.
3. Double-click `backend/client/index.html` to open it in browser. The dashboard will instantly load the latest cloud data!
*(Note: If you don't create `config.js`, the UI will prompt you to type them in manually).*

---

## Auction Insights Google Sheets Setup

Google Ads does not expose Auction Insights through the normal Google Ads API reports used by this dashboard. The workaround is:

1. In Google Ads, schedule Auction Insights reports to create Google Sheets every day. Add the **Day** segment and ensure the report covers the dashboard's full warehouse date range; the dashboard cannot date-filter an unsegmented export.
2. Give the backend OAuth user access to those Sheets.
3. In the same Google Cloud project used by the OAuth client, enable both **Google Drive API** and **Google Sheets API**.
4. Add `GOOGLE_SHEETS_REFRESH_TOKEN` to the backend environment.
5. Open the dashboard, go to **Rank → Auction Sheet Settings**, and paste the exact Google Sheet name for:
   - account-level Auction Insights,
   - each campaign that has its own report,
   - each ad group that has its own report.
6. Click **Save Sheet Names**.
7. Run a dashboard refresh.

The Rank view queries only the selected date range and exactly one matching hierarchy export (account, selected campaign, or selected ad group). It then returns one server-side summary per advertiser, a trend, and Google-style absolute-top/overlap/entrant cards. It does not ship or render the former daily-row grid, and it does not truncate Auction Insights alphabetically.

Daily percentages are combined with metric-specific auction-volume weights. This is materially closer to Google than a simple arithmetic average. A daily bound such as `<10%` uses its midpoint only for internal weighting; output remains `<10%` when the estimate stays below the bound and is marked `≈` when mixed exact/censored days cross it. Google does not include every competitor-specific denominator required to reconstruct an arbitrary unsegmented range exactly, so small residual differences can remain. Compare the same hierarchy level and completed dates; the browser's **Last 7 Completed Days** preset deliberately excludes the current partial day to match Google's "last seen days" window.

Google Ads creates a new Google Sheet file every day with the same name. The backend uses the Google Drive API to find the newest file with the saved name, then reads its rows with the Google Sheets API. If Drive API is disabled, OAuth can still work but latest-sheet lookup will fail.

If Auction Insights is empty:

- Missing `GOOGLE_SHEETS_REFRESH_TOKEN`: add the env var and redeploy/restart.
- Drive API disabled: enable Google Drive API in the OAuth project's Google Cloud console.
- Missing sheet name: save the sheet name in **Auction Sheet Settings**.
- Fetch failed: verify the sheet name, OAuth credentials, Drive/Sheets scopes, and sharing access.
- Empty sheet: confirm the scheduled Google Ads report actually contains Auction Insights rows.

---

## Semantic Memory / RAG

The dashboard includes a deterministic semantic memory layer for human context that does not fit structured metrics:

- client preferences,
- business constraints,
- campaign exceptions,
- proposal postmortems,
- operational notes that should inform future recommendations.

The backend uses PostgreSQL with `pgvector` for storage and retrieval, but it does **not** call LLMs or embedding providers. External agents extract memories, generate embeddings, compare semantic duplicates, and decide whether a note is a duplicate, refinement, exception, or new memory.

Memory tools are exposed through the authenticated backend and MCP:

- `create_memory`
- `store_memory_embedding`
- `search_memories`
- `deactivate_memory`
- `link_memory_exception`

Proposal cards also support raw user feedback/comments. Feedback is stored in SQL and exposed to MCP through:

- `create_proposal_feedback`
- `list_proposal_feedback`
- `update_proposal_feedback_status`

Feedback does not automatically become semantic memory. The external agent must review it, create/store a memory only when the comment is durable, and then mark the feedback `converted_to_memory`.

Every memory operation is tenant-scoped by `customer_id`. Embeddings are stored in model-dimension-specific tables; the initial production table is `semantic_memory_embeddings_1536`.

Database setup requires PostgreSQL extensions:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Run `cd backend && bun run scripts/migrate.ts` after configuring `DATABASE_URL` to create or update proposal, lead, and semantic-memory tables.

---

## Keyword Planner Enrichment

The dashboard can enrich current keywords and search terms with official Google Ads Keyword Planner data:

- average monthly searches,
- competition,
- low/high top-of-page bid ranges,
- related keyword ideas from keyword-only, keyword + page URL, page-only URL, or entire-site domain seeds.

The refresh pipeline stores Keyword Planner ideas and historical metrics in the PostgreSQL warehouse tables. The UI shows this data in keyword/search-term tables and in the **Planner** tab. MCP agents can read the `keywordPlanner` dashboard section or call `keyword_planner_generate_ideas` and `keyword_planner_historical_metrics`.

Scheduled refreshes reuse fresh Keyword Planner warehouse rows for 24 hours by default to avoid unnecessary Google Ads API quota pressure. Set `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS=0` only when you need Planner data fetched on every refresh.

No extra refresh token is needed if `GOOGLE_REFRESH_TOKEN` or `GOOGLE_ADS_REFRESH_TOKEN` already has the Google Ads scope: `https://www.googleapis.com/auth/adwords`.

---

## Google Ads API Client and Warehouse Refresh

Google Ads API calls are centralized through `backend/lib/googleAdsClient.ts`. The API version is configured by `GOOGLE_ADS_API_VERSION` and defaults to `v24`; hardcoded versioned URLs should not be added elsewhere. When `DATABASE_URL` is configured, the server and refresh script share a Postgres-backed quota governor. `google_ads_quota_buckets` holds rolling developer/customer/mutate request safety limits and `Retry-After`/resource-exhausted backoff. `google_ads_api_operation_usage` enforces the developer token's exact rolling 24-hour API-operation allowance: Search, SearchStream, and other requests count once, while mutate and validate-only requests count their operations. There are no artificial customer or mutate daily caps. Search/SearchStream `query_resource_consumption` is observational data stored separately in `google_ads_query_resource_usage_hourly` and never debits API-operation allowance. `GOOGLE_ADS_QUOTA_DEVELOPER_UNITS_PER_DAY` remains a temporary compatibility fallback for older deployments, but new configuration should use `GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS`.

Warehouse report refreshes are scheduled through a PostgreSQL-backed queue (`google_ads_refresh_jobs`) and processed by one in-process worker inside the app container. The worker wakes immediately after enqueue and also polls as a backup, so accepted refresh intent survives app restarts without Redis or a separate worker container. The refresh script uses `googleAds:searchStream`, persists mapped rows in batches, and holds a PostgreSQL advisory lock per customer so two refreshes for the same account do not run concurrently across processes. Read/searchStream and validate-only requests use retry/backoff; live mutate execution does not retry after a failed Google Ads mutate call.

Raw MCP GAQL (`search_search`) is intentionally bounded. Metric queries must include an explicit `segments.date` filter and every raw query must include `LIMIT`; broad segment-heavy queries without campaign/ad-group/criterion scope are rejected. Results are returned as structured content with `rows`, `rowCount`, `truncated`, `requestId`, `apiVersion`, and `warnings`.

---

## 🤖 The MCP

A custom MCP specifically for AI Agents. It pulls data directly without the need for any Google credentials. The local `MCP/mcp-server.js` accepts MCP protocol dates `2025-11-25` and newer, negotiates to the backend's current protocol contract, and hard-blocks older clients; it has no local fake dashboard tools and forwards tool calls to the backend registry.

Production MCP auth is scoped and fail-closed:

- Backend: set `MCP_API_KEYS_JSON` to the full generated JSON array.
- MCP client/proxy: set `MCP_API_KEY` to the generated plaintext key.
- Do not set or rely on `SECRET_API_KEY` for MCP.

Generate both values:

```bash
cd backend
bun run mcp:generate-key ads-prod
```

Each backend MCP tool is registered with an input schema, output schema, required scopes, risk level, rate limit, skill-confirmation requirement, and audit redaction policy. Tool results use `structuredContent`; `content` is only a short human summary when useful. A new MCP session must initialize, send `notifications/initialized`, then call `confirm_google_ads_skill` before workflow tools.

**To install it in Claude Desktop / Codex / Cursor / Antigravity:**
1. Use the `mcp-server.js` file.
2. Configure the MCP settings in the AI app of choice:

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "bun",
      "args": ["/path/to/mcp-server.js"],
      "env": {
        "API_BASE": "https://your-server.com",
        "MCP_API_KEY": "generated_plaintext_mcp_key"
      }
    }
  }
}
```

The AI agent can instantly read the Google Ads performance data and propose changes or perform growth diagnosis which will also be visible in the dashboard!

### AI Agent Skill

The `google-ads-skill/` directory contains a `SKILL.md` and reference documents for the `saas-google-ads-dashboard-analyst` skill. This skill teaches compatible AI agents how to use the MCP tools, interpret dashboard data, create proposals and diagnoses, and follow the safety rules for mutation workflows. Agents that support skills (such as Hermes Agent) load this on demand.

### Hermes Agent (VPS)

When Hermes Agent runs on the same VPS as the backend, clone the lightweight `Ads-LLM` repo for the MCP proxy and skill:

```bash
git clone https://github.com/walkin-watchdog/Ads-LLM.git ~/Ads-LLM
```

Symlink the skill into Hermes:

```bash
ln -s ~/Ads-LLM/google-ads-skill ~/.hermes/skills/saas-google-ads-dashboard-analyst
```

Add the MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  google-ads:
    command: bun
    args:
      - "run"
      - "/home/ubuntu/Ads-LLM/MCP/mcp-server.js"
    env:
      API_BASE: "http://localhost:7860"
      MCP_API_KEY: "generated_plaintext_mcp_key"
```

Adjust the absolute path for your VPS user. Use `node` instead of `bun` if Bun is not installed on the host.

To auto-update the skill and MCP proxy with upstream changes:

```bash
crontab -e
# Add:
0 * * * * cd ~/Ads-LLM && git pull --ff-only origin main >> /tmp/ads-llm-pull.log 2>&1
```

Hermes reads the skill fresh on each load and spawns a new MCP process per session, so `git pull` updates take effect without a restart. Verify with `hermes doctor` and `hermes skills list`.

---
