# Google Ads Cloud Dashboard

This repository contains the complete Google Ads Dashboard, backed by a server architected for the Cloud. It uses a **Cloud Architecture** to fetch Google Ads data, stores it in PostgreSQL, and serves it to a lightweight local UI.

## Features
- **Remote Heavy Lifting:** Google Ads API fetching is handled in the cloud (no local API timeouts).
- **Bun:** Entirely powered by Bun (JavaScript).
- **Postgres Storage:** Processed payload is safely stored in a cloud database.
- **Light-Weight MCP Server:** AI Agents can read the data instantly without needing Google Ads credentials.

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
     - `GOOGLE_LOGIN_CUSTOMER_ID`
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
1. Go into the backend directory: `cd backend` and create a local docker db with `sudo docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres`
2. Copy `.env.example` to `.env` and fill in your `DATABASE_URL` and Google Ads credentials.
3. Run `bun install`.
4. Run `bun run server.ts`.
5. Open `http://localhost:8080` in your browser.

### Option B: UI-Only Mode (The "Client" Mode)
You don't need to run a local server to view the dashboard! 
1. Copy `client/dashboard/config.example.js` to `client/dashboard/config.js`.
2. Edit `config.js` and set your `API_BASE` (e.g., `https://your-render-app.onrender.com`) and `API_KEY`.
3. Double-click `client/dashboard/index.html` to open it in Chrome. The dashboard will instantly load the latest cloud data!
*(Note: If you don't create `config.js`, the UI will prompt you to type them in manually).*

---

## 🤖 The Team-Friendly MCP

We have created a custom MCP specifically for your team's AI Agents. It pulls data directly from server, meaning your team **does not need Google Ads API access**.

**To install it in Claude Desktop / Antigravity:**
1. Your team just needs the `client/mcp-server.js` file.
2. Tell them to configure their MCP settings to run:
   ```json
   {
     "mcpServers": {
       "google-ads-dashboard": {
         "command": "bun",
         "args": ["/absolute/path/to/client/mcp-server.js"],
         "env": {
           "API_BASE": "https://your-render-app.com",
           "SECRET_API_KEY": "your_secure_password"
         }
       }
     }
   }
   ```
Now any AI agent can instantly read the Google Ads performance data!
