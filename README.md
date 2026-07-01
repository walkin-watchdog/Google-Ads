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
- **Light-Weight MCP Server:** AI Agents can read dashboard data and create proposal/diagnosis cards without Google Ads credentials.
- **Lead Quality + Offline Conversion Support:** First-party lead webhooks dedupe sessions, track quality, and export upload-ready offline conversion CSVs.
- **Keyword Planner and Auction Insights:** Keyword Planner enrichment comes from Google Ads endpoints; Auction Insights are read from configured Google Sheets exports.

Backend is the **fact engine**. The external AI is the **analyst**.

Backend remains deterministic and evidence-producing, while the AI does judgment externally via MCP

---

## ☁️ Deployment Guide

Use **Neon.tech** for a permanently free PostgreSQL database. For the web service hosting, we recommend **Hugging Face Spaces** because it supports Docker deployments with **100% free, unlimited outbound bandwidth** and runs on 16 GB RAM.

### Step 1: Create the Database
1. Go to [Neon.tech](https://neon.tech) and sign up/log in.
2. Create a new project and database.
3. On your dashboard, find the **Connection Details**.
4. Copy the **Postgres Connection String** with Connection Pooling enabled (e.g., `postgresql://neondb_owner:password@ep-cool-db-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require`).

---

### Step 2: Deploy on Hugging Face Spaces (Recommended - Unlimited Bandwidth)

Hugging Face Spaces Docker builds expect a `Dockerfile` in the Space repository root.

1. Extract backend/ code into a separate repo.
2. Go to [Hugging Face Spaces](https://huggingface.co/spaces) and sign up/log in.
3. Click **Create new Space**.
4. Configure the Space settings:
   - **Space Name:** Choose a name (e.g., `google-ads-dashboard`).
   - **License:** Choose any license (e.g., `mit`).
   - **SDK:** Select **Docker**.
   - **Docker Template:** Select **Blank** (do not select any template).
   - **Space Hardware:** Select **CPU Basic** (which is 100% free, 2 vCPUs, 16 GB RAM).
   - **Space Visibility:** Select **Public** or **Private** (recommended Private to secure your dashboard, though the API is protected by `SECRET_API_KEY` regardless).
5. Click **Create Space**.
6. Go to your Space's **Settings** tab.
7. Scroll down to **Variables and Secrets** and click **New secret** to add all the required environment variables:
   - `DATABASE_URL`: Paste the connection string from Neon in Step 1.
   - `SECRET_API_KEY`: Create a strong random password (e.g., `MySuperSecretKey123!`).
   - `PORT`: Set this to `7860` (Hugging Face requires containers to listen on port `7860`).
   - *Add your Google Ads credentials. The backend accepts the shorter names below and the `GOOGLE_ADS_*` aliases used in `backend/.env.example`:*
     - `GOOGLE_DEVELOPER_TOKEN` or `GOOGLE_ADS_DEVELOPER_TOKEN`
     - `GOOGLE_CLIENT_ID` or `GOOGLE_ADS_CLIENT_ID`
     - `GOOGLE_CLIENT_SECRET` or `GOOGLE_ADS_CLIENT_SECRET`
     - `GOOGLE_REFRESH_TOKEN` or `GOOGLE_ADS_REFRESH_TOKEN`
     - `GOOGLE_LOGIN_CUSTOMER_ID` or `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
     - `GOOGLE_CUSTOMER_ID` or `GOOGLE_ADS_CUSTOMER_ID` *(optional; pins the customer instead of using the first accessible account)*
     - `GOOGLE_SHEETS_REFRESH_TOKEN` *(needed for Auction Insights Google Sheets; use a token with Google Sheets and Drive read access)*
     - `GOOGLE_LOGIN_CUSTOMER_ID`- `GOOGLE_LOGIN_CUSTOMER_ID`
     - `LEAD_WEBHOOK_SECRET` *(optional but recommended; defaults to `SECRET_API_KEY` when missing)*
     - `KEYWORD_PLANNER_URL` *(optional; defaults to `https://zenseeo.com`)*
     - `KEYWORD_PLANNER_GEO_TARGETS` *(optional; defaults to India, `geoTargetConstants/2356`)*
     - `KEYWORD_PLANNER_LANGUAGE` *(optional; defaults to English, `languageConstants/1000`)*
     - `KEYWORD_PLANNER_NETWORK` *(optional; defaults to `GOOGLE_SEARCH`)*
     - `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS` *(optional; defaults to `24`; set `0` to fetch Planner data on every refresh)*
     - `DASHBOARD_REFRESH_START_DATE` *(optional; YYYY-MM-DD. When set, cron/manual refreshes rebuild the cached dashboard window from this date through today unless the request body overrides it.)*
     - `DASHBOARD_REFRESH_LOOKBACK_DAYS` *(optional; defaults to `90`; used when `DASHBOARD_REFRESH_START_DATE` is not set.)*
     - `GOOGLE_ADS_FETCH_TIMEOUT_MS` *(optional; defaults to `25000`)*
     - `GOOGLE_ADS_WAREHOUSE_START_DATE` *(required for the first warehouse backfill)*
     - `GOOGLE_ADS_MUTABLE_LOOKBACK_DAYS` *(optional; defaults to `90` for manual/cron refreshes)*
     - `GOOGLE_ADS_STARTUP_LOOKBACK_DAYS` *(optional; defaults to `14` for the refresh run inside `bun run start` after the warehouse exists)*
     - `TRIGGER_REFRESH_MIN_INTERVAL_MINUTES` *(optional; defaults to `360`; no-body `/api/trigger-refresh` calls inside this cooldown return a skipped 202 instead of starting a warehouse refresh)*
     - `DASHBOARD_DB_CACHE_MAX_BYTES` *(optional; defaults to `2000000`; larger dashboard ads payloads are kept out of Neon JSONB cache rows)*
     - Dashboard warehouse watermarks are maintained in `google_ads_warehouse_slice_fingerprints` during warehouse writes and schema migration backfill, so cached dashboard slices validate freshness with one fingerprint-table read instead of scanning every warehouse source table.
     - `DASHBOARD_MEMORY_CACHE_SECONDS`, `DASHBOARD_MEMORY_CACHE_MAX_ENTRIES`, `DASHBOARD_MEMORY_CACHE_MAX_BYTES` *(optional; defaults to `600`, `10`, and `25000000` for process-local ads payload caching)*
     - `DASHBOARD_VIEW_CACHE_SECONDS`, `DASHBOARD_BASE_BUNDLE_CACHE_SECONDS`, `DASHBOARD_FILTER_OPTIONS_CACHE_SECONDS` *(optional; default to `60`; short process caches for browser partial views and shared warehouse reads)*
     - `DASHBOARD_KEYWORD_ROW_LIMIT`, `DASHBOARD_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_PLANNER_ROW_LIMIT` *(optional; defaults to `1500`, `2000`, and `1000`; bounds cold Keyword Discovery view rows after SQL aggregation)*
     - `DASHBOARD_RANK_KEYWORD_ROW_LIMIT`, `DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT`, `DASHBOARD_LANDING_PAGE_ROW_LIMIT`, `DASHBOARD_AUCTION_INSIGHTS_ROW_LIMIT`, `DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT` *(optional; defaults to `1000`, `1000`, `500`, `1000`, and `250`; bounds cold Rank/Proposals support rows)*
     - `DASHBOARD_DB_POOL_MAX`, `DASHBOARD_DB_IDLE_TIMEOUT_MS` *(optional; default to `4` clients and `10000` ms for Neon-friendly dashboard pooling)*
     - `HTTP_COMPRESSION_THRESHOLD_BYTES` *(optional; defaults to `1024`; JSON responses above this size are compressed when the client supports it)*
   - `PUBLIC_DASHBOARD_BASE_URL`: Public URL of your Space once deployed (e.g., `https://username-space-name.hf.space`).
   - `SERVE_DASHBOARD_CLIENT`: Set to `true` to access the dashboard through magic links.
   - `DASHBOARD_CORS_ORIGINS`: Optional comma-separated extra browser origins.
8. Push the new repository created at first step containing backend/ code to the Hugging Face Space repository:
   
   Hugging Face Spaces doesn't have a direct "one-click GitHub connect" button. Setup Tokenless Sync via Trusted Publishers as given below:

   *   **Setup Tokenless Sync via Trusted Publishers (Recommended)**
       1. Go to your repository settings on the Hugging Face Hub (e.g., `https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME/settings`).
       2. Find the **Trusted Publishers** section and click **Add a new publisher**.
       3. Configure the publisher details:
          - **Provider:** Select `GitHub Actions`.
          - **GitHub Repository Org/Name:** `YOUR_GITHUB_ORG/YOUR_GITHUB_REPO`.
          - **Branch:** `main` (or your default branch).
          - **Workflow:** `publish.yml` (the filename of the GitHub Action workflow we will create).
       4. In your local repository, create a file at `.github/workflows/publish.yml` with the following content:
          ```yaml
          name: Sync to Hugging Face Hub
          on:
            push:
              branches: [main]
          jobs:
            sync:
              runs-on: ubuntu-latest
              permissions:
                id-token: write # Required to fetch short-lived OIDC token
                contents: read
              steps:
                - uses: actions/checkout@v4
                
                - name: Set up Python
                  uses: actions/setup-python@v5
                  with:
                    python-version: '3.x'

                - name: Install huggingface_hub
                  run: pip install huggingface_hub

                - name: Upload to Hugging Face Hub
                  env:
                    HF_OIDC_RESOURCE: spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME
                  run: |
                    hf upload YOUR_HF_USERNAME/YOUR_SPACE_NAME . . --repo-type=space
          ```
       5. Commit and push this file to GitHub. On every push to `main`, GitHub Actions will authenticate securely using short-lived tokens and deploy to Hugging Face!

9. Hugging Face will build the container from the `Dockerfile` and start the server.

---

### Step 3: Setup the Cron Job (Keep-Alive)
Use a cron job only when you intentionally want scheduled refreshes or need to keep a sleeping host awake. `/api/trigger-refresh` without `force: true` now honors `TRIGGER_REFRESH_MIN_INTERVAL_MINUTES` before starting warehouse work; keep-alive cron calls should omit `force` so they do not rewrite the 90-day mutable window every few minutes.
1. Go to [cron-job.org](https://cron-job.org) and create a free account.
2. Click **Create Cronjob**.
3. **URL:** `https://your-app-url/api/trigger-refresh`
4. **Execution Schedule:** Use a low-frequency schedule for real refreshes, or keep a 14-minute keep-alive only if the request omits `force` and you accept that most calls will return a skipped cooldown response.
5. **Advanced Options > HTTP Headers:**
   - Public/non-gateway backend: add `Authorization: Bearer YOUR_SECRET_API_KEY` or `X-API-Key: YOUR_SECRET_API_KEY`.
   - Private Hugging Face Space: add both `Authorization: Bearer YOUR_HF_TOKEN` for the Hugging Face gateway and `X-API-Key: YOUR_SECRET_API_KEY` for the backend.
6. **HTTP Method:** `POST`.
7. Optional JSON body for a historical refresh window:
   ```json
   { "startDate": "2026-06-01", "endDate": "2026-06-30" }
   ```
8. Save. Your app will stay awake permanently and data will refresh every 14 mins!

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
The deployed backend can serve the dashboard from `backend/client`, but direct public access is blocked. Remote users should open the dashboard through a one-time magic link created by the MCP tool `create_dashboard_magic_link`. The link is exchanged for an HttpOnly dashboard session cookie and does not expose `SECRET_API_KEY` to the browser.

Magic-link dashboard sessions can use only dashboard-safe browser APIs. MCP/admin operations such as raw GAQL, memory mutation, clear/reset tools, and refresh triggers still require `SECRET_API_KEY`. Direct bearer-key dashboard API access is limited to local `file://` (The "Client" Mode) and loopback browser origins for `config.js` use.

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

1. In Google Ads, schedule Auction Insights reports to create Google Sheets every day.
2. Give the backend OAuth user access to those Sheets.
3. In the same Google Cloud project used by the OAuth client, enable both **Google Drive API** and **Google Sheets API**.
4. Add `GOOGLE_SHEETS_REFRESH_TOKEN` to the backend environment.
5. Open the dashboard, go to **Rank → Auction Sheet Settings**, and paste the exact Google Sheet name for:
   - account-level Auction Insights,
   - each campaign that has its own report,
   - each ad group that has its own report.
6. Click **Save Sheet Names**.
7. Run a dashboard refresh.

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

## 🤖 The MCP

A custom MCP specifically for AI Agents. It pulls data directly without the need for any Google credentials.

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
        "SECRET_API_KEY": "api_secret",
        "HF_TOKEN": "your_hugging_face_read_token_if_private_space"
      }
    }
  }
}
```

Now the AI agent can instantly read the Google Ads performance data and propose changes or perform growth diagnosis which will also be visible in the dashboard!

---
