# Google Ads Cloud Dashboard

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

## ☁️ Deployment Guide (Render.com)

We will use **Render.com** for a free Web Service container and **Neon.tech** for a permanently free PostgreSQL database (Render's free DB deletes itself after 30 days).

### Step 1: Create the Database
1. Go to [Neon.tech](https://neon.tech) and sign up/log in.
2. Create a new project and database.
3. On your dashboard, find the **Connection Details**.
4. Copy the **Postgres Connection String** with Connection Pooling enabled (e.g., `postgresql://neondb_owner:password@ep-cool-db-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require`).

### Step 2: Deploy the Web Service
1. Go to [Render.com](https://render.com) and log in. In your Dashboard, click **New +** and select **Web Service**.
2. Connect your GitHub repository containing this code.
3. Configure the service:
   - **Root Directory:** *(leave blank)*
   - **Environment:** `Node`
   - **Build Command:** `cd backend && bun install`
   - **Start Command:** `cd backend && bun run server.ts`
   - **Instance Type:** Free
4. Scroll down to **Environment Variables** and add:
   - `DATABASE_URL`: Paste the connection string from Neon in Step 1.
   - `SECRET_API_KEY`: Create a strong random password (e.g., `MySuperSecretKey123!`). This secures your data.
   - *Add all your Google Ads MCP credentials here too:*
     - `GOOGLE_DEVELOPER_TOKEN`
     - `GOOGLE_CLIENT_ID`
     - `GOOGLE_CLIENT_SECRET`
     - `GOOGLE_REFRESH_TOKEN`
     - `GOOGLE_SHEETS_REFRESH_TOKEN` *(needed for Auction Insights Google Sheets; use a token with Google Sheets and Drive read access)*
     - `GOOGLE_LOGIN_CUSTOMER_ID`
     - `KEYWORD_PLANNER_URL` *(optional; defaults to `https://zenseeo.com`)*
     - `KEYWORD_PLANNER_GEO_TARGETS` *(optional; defaults to India, `geoTargetConstants/2356`)*
     - `KEYWORD_PLANNER_LANGUAGE` *(optional; defaults to English, `languageConstants/1000`)*
     - `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS` *(optional; defaults to `24`; set `0` to fetch Planner data on every refresh)*
   - `PUBLIC_DASHBOARD_BASE_URL`: Public backend URL used when MCP creates dashboard magic links.
   - `SERVE_DASHBOARD_CLIENT`: Set to `true` only when using backend-hosted dashboard access through magic links.
   - `DASHBOARD_CORS_ORIGINS`: Optional comma-separated extra browser origins. `file://`, `localhost`, `127.0.0.1`, and the public dashboard origin are allowed automatically.
   - `DASHBOARD_COOKIE_SECURE`: Optional override. Leave unset; the server sets secure cookies for production, HTTPS public URLs, or HTTPS forwarded requests.
5. Click **Create Web Service**. Wait 2-3 minutes for it to build and deploy. 

### Step 3: Setup the Cron Job (Keep-Alive)
Render's free tier sleeps after 15 minutes. To prevent 50-second cold starts, we'll keep it awake 24/7.
1. Go to [cron-job.org](https://cron-job.org) and create a free account.
2. Click **Create Cronjob**.
3. **URL:** `https://your-render-app-name.onrender.com/api/trigger-refresh`
4. **Execution Schedule:** Every 14 minutes. *(This resets Render's 15-minute sleep timer)*
5. **Advanced Options > HTTP Headers:** Add `Authorization` with value `Bearer YOUR_SECRET_API_KEY`.
6. **HTTP Method:** `POST`.
7. Save. Your app will stay awake permanently and data will refresh every 14 mins!

---

## 💻 Local Setup (For You & Your Team)

### Prerequisites
- Install [Bun](https://bun.sh/) (Mac/Linux: `curl -fsSL https://bun.sh/install | bash`).

### Option A: Run the Full System Locally
If you want to test the data fetching yourself:
1. Go into the backend directory: `cd backend` and create a local docker db with `sudo docker run -d -p 5433:5432 --name google-ads-db -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg18`
2. Copy `.env.example` to `.env` and fill in your `DATABASE_URL` and Google Ads credentials.
3. Run `bun install`.
4. Run `bun run server.ts`.
5. To serve the bundled dashboard from the backend for local development, set `SERVE_DASHBOARD_CLIENT=true` and open the dashboard through a magic link generated by MCP.

### Option B: UI-Only Mode (The "Client" Mode)
You don't need to run a local server to view the dashboard! 
1. Copy `backend/client/config.example.js` to `backend/client/config.js`.
2. Edit `config.js` and set your `API_BASE` (e.g., `https://your-render-app.onrender.com`) and `API_KEY`. Keep this file local only.
3. Double-click `backend/client/index.html` to open it in Chrome. The dashboard will instantly load the latest cloud data!
*(Note: If you don't create `config.js`, the UI will prompt you to type them in manually).*

### Backend-Hosted Dashboard Access
The deployed backend can serve the dashboard from `backend/client`, but direct public access is blocked. Remote users should open the dashboard through a one-time magic link created by the MCP tool `create_dashboard_magic_link`. The link is exchanged for an HttpOnly dashboard session cookie and does not expose `SECRET_API_KEY` to the browser.

Magic-link dashboard sessions can use only dashboard-safe browser APIs. MCP/admin operations such as raw GAQL, memory mutation, clear/reset tools, and refresh triggers still require `SECRET_API_KEY`. Direct bearer-key dashboard API access is limited to local `file://` and loopback browser origins for `config.js` use.

---

## 🤖 The Team-Friendly MCP

We have created a custom MCP specifically for your team's AI Agents. It pulls data directly from server, meaning your team **does not need Google Ads API access**.

**To install it in Claude Desktop / Antigravity:**
1. Your team just needs the `MCP/mcp-server.js` file.
2. Tell them to configure their MCP settings to run:
   ```json
   {
     "mcpServers": {
       "google-ads": {
         "command": "bun",
          "args": ["/absolute/path/to/MCP/mcp-server.js"],
          "env": {
            "API_BASE": "https://your-render-app.com",
            "SECRET_API_KEY": "your_secure_password"
         }
       }
     }
   }
   ```
Now any AI agent can instantly read the Google Ads performance data!

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

The refresh pipeline writes these files into `backend/data/latest/`:

- `keyword-planner-ideas.json`
- `keyword-planner-historical-metrics.json`
- `keyword-planner-status.json`

The UI shows this data in keyword/search-term tables and in the **Planner** tab. MCP agents can read the `keywordPlanner` dashboard section or call `keyword_planner_generate_ideas` and `keyword_planner_historical_metrics`.

Scheduled refreshes reuse fresh Keyword Planner files for 24 hours by default to avoid unnecessary Google Ads API quota pressure. Set `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS=0` only when you need Planner data fetched on every refresh.

No extra refresh token is needed if `GOOGLE_REFRESH_TOKEN` or `GOOGLE_ADS_REFRESH_TOKEN` already has the Google Ads scope: `https://www.googleapis.com/auth/adwords`.

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
