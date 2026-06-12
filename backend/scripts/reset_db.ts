import { Pool } from "pg";
import * as dotenv from "dotenv";
import { createPoolConfig } from "../lib/dbConfig";

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set in .env");
  process.exit(1);
}

const pool = new Pool(createPoolConfig());

(async () => {
  console.log("⚠️  Dropping all tables...");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log("✅ All tables dropped and schema recreated.");
  await pool.end();
})();
