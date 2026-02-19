const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function pgClientFromEnv() {
  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("Falta SUPABASE_DB_URL");
  const client = new Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function applySupabaseSchema() {
  const sqlPath = path.join(__dirname, "..", "..", "supabase", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const pg = await pgClientFromEnv();
  try {
    await pg.query(sql);
  } finally {
    await pg.end();
  }
}

module.exports = {
  applySupabaseSchema,
};
