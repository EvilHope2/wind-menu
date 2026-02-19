require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const conn = process.env.SUPABASE_DB_URL;
  if (conn) {
    const client = new Client({
      connectionString: conn,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    const res = await client.query("select now() as now, current_database() as db");
    await client.end();
    console.log("Conexion Postgres OK:", res.rows[0]);
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Falta SUPABASE_DB_URL o SUPABASE_URL + SUPABASE_ANON_KEY/SERVICE_ROLE_KEY");
  }

  const ping = await fetch(`${url}/rest/v1/`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!ping.ok) {
    throw new Error(`REST API respondio ${ping.status}`);
  }
  console.log("Conexion REST Supabase OK:", ping.status);
}

main().catch((err) => {
  console.error("Error conexion Supabase:", err.message);
  process.exit(1);
});
