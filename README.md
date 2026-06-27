---
title: Google Ads Cloud Dashboard
emoji: 📊
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# Google Ads Cloud Dashboard

This repository contains the complete Google Ads Dashboard, backed by a server architected for the Cloud. It uses a **Cloud Architecture** to fetch Google Ads data, stores it in PostgreSQL, and serves it to a lightweight local UI.

## Features
- **Remote Heavy Lifting:** Google Ads API fetching is handled in the cloud (no local API timeouts).
- **Bun:** Entirely powered by Bun (JavaScript).
- **Postgres Storage:** Processed payload is safely stored in a cloud database.
- **Light-Weight MCP Server:** AI Agents can read the data instantly without needing Google Ads credentials.

Backend is the **fact engine**. The external AI is the **analyst**.

Backend remains deterministic and evidence-producing, while the AI does judgment externally via MCP

---

## ☁️ Deployment Guide

We will use **Neon.tech** for a permanently free PostgreSQL database (Render's free DB deletes itself after 30 days, Neon is permanently free). For the web service hosting, we recommend **Hugging Face Spaces** because it supports Docker deployments with **100% free, unlimited outbound bandwidth** and runs on 16 GB RAM. Alternatively, you can deploy on **Render.com** (which has a 5 GB/month bandwidth limit).

### Step 1: Create the Database
1. Go to [Neon.tech](https://neon.tech) and sign up/log in.
2. Create a new project and database.
3. On your dashboard, find the **Connection Details**.
4. Copy the **Postgres Connection String** with Connection Pooling enabled (e.g., `postgresql://neondb_owner:password@ep-cool-db-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require`).

---

### Step 2: Deploy on Hugging Face Spaces (Recommended - Unlimited Bandwidth)

Hugging Face Spaces will automatically build your app using the root-level `Dockerfile` and host it for free.

1. Go to [Hugging Face Spaces](https://huggingface.co/spaces) and sign up/log in.
2. Click **Create new Space**.
3. Configure the Space settings:
   - **Space Name:** Choose a name (e.g., `google-ads-dashboard`).
   - **License:** Choose any license (e.g., `mit`).
   - **SDK:** Select **Docker**.
   - **Docker Template:** Select **Blank** (do not select any template).
   - **Space Hardware:** Select **CPU Basic** (which is 100% free, 2 vCPUs, 16 GB RAM).
   - **Space Visibility:** Select **Public** or **Private** (recommended Private to secure your dashboard, though the API is protected by `SECRET_API_KEY` regardless).
4. Click **Create Space**.
5. Go to your Space's **Settings** tab.
6. Scroll down to **Variables and Secrets** and click **New secret** to add all the required environment variables:
   - `DATABASE_URL`: Paste the connection string from Neon in Step 1.
   - `SECRET_API_KEY`: Create a strong random password (e.g., `MySuperSecretKey123!`).
   - `PORT`: Set this to `7860` (Hugging Face requires containers to listen on port `7860`).
   - *Add your Google Ads MCP credentials:*
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
   - `PUBLIC_DASHBOARD_BASE_URL`: Public URL of your Space once deployed (e.g., `https://username-space-name.hf.space`).
   - `SERVE_DASHBOARD_CLIENT`: Set to `true` to access the dashboard through magic links.
   - `DASHBOARD_CORS_ORIGINS`: Optional comma-separated extra browser origins.
7. Push your repository's code to the Hugging Face Space repository:
   
   Unlike Render, Hugging Face Spaces doesn't have a direct "one-click GitHub connect" button. Choose one of the two methods below to deploy your code:

   *   **Method A: Push directly from your local machine (Easiest)**
       1. In your local terminal, add the Hugging Face Space as a new git remote:
          ```bash
          git remote add hf https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
          ```
       2. Generate a Hugging Face **Access Token** with `write` permission in your [Hugging Face Token Settings](https://huggingface.co/settings/tokens).
       3. Push your code directly:
          ```bash
          git push hf main
          ```
          *(When prompted for password, paste the Hugging Face Access Token you generated).*

   *   **Method B: Setup Tokenless Sync via Trusted Publishers (Recommended)**
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

8. Hugging Face will build the container from the `Dockerfile` and start the server.

---

### Step 3: Setup the Cron Job (Keep-Alive)
Render's free tier sleeps after 15 minutes. To prevent 50-second cold starts, we'll keep it awake 24/7.
1. Go to [cron-job.org](https://cron-job.org) and create a free account.
2. Click **Create Cronjob**.
3. **URL:** `https://your-render-app-name.onrender.com/api/trigger-refresh`
4. **Execution Schedule:** Every 14 minutes. *(This resets Render's 15-minute sleep timer)*
5. **Advanced Options > HTTP Headers:** Add `Authorization` with value `Bearer YOUR_HF_TOKEN`.
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
            "API_BASE": "https://your-username-space-name.hf.space",
            "SECRET_API_KEY": "your_secure_password",
            "HF_TOKEN": "your_hugging_face_read_token_if_private_space"
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
- related keyword ideas from seed keywords and the website URL.

The refresh pipeline writes these files into `backend/data/latest/`:

- `keyword-planner-ideas.json`
- `keyword-planner-historical-metrics.json`
- `keyword-planner-status.json`

The UI shows this data in keyword/search-term tables and in the **Planner** tab. MCP agents can read the `keywordPlanner` dashboard section or call `keyword_planner_generate_ideas` and `keyword_planner_historical_metrics`.

Scheduled refreshes reuse fresh Keyword Planner files for 24 hours by default to avoid unnecessary Google Ads API quota pressure. Set `KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS=0` only when you need Planner data fetched on every refresh.

No extra refresh token is needed if `GOOGLE_REFRESH_TOKEN` already has the Google Ads scope: `https://www.googleapis.com/auth/adwords`.

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
