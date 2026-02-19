const { Client } = require("pg");
const { db, initDb } = require("../db");

const TABLES_ORDER = [
  "users",
  "affiliates",
  "plans",
  "businesses",
  "categories",
  "products",
  "delivery_zones",
  "business_hours",
  "subscriptions",
  "affiliate_payouts",
  "affiliate_sales",
];

const TABLES_REVERSE = [...TABLES_ORDER].reverse();

function sqliteColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function sqliteReadAll(table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function normalizeForSqlite(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  return String(value);
}

async function pgClientFromEnv() {
  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) {
    throw new Error("Falta SUPABASE_DB_URL");
  }
  const client = new Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function ensureSchemaExists(pg) {
  const check = await pg.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name='users'"
  );
  if (!check.rows.length) {
    throw new Error("Schema no existe en Supabase. Ejecuta primero: npm run supabase:schema");
  }
}

async function pushSqliteToSupabase() {
  initDb();
  const pg = await pgClientFromEnv();
  try {
    await ensureSchemaExists(pg);

    for (const table of TABLES_REVERSE) {
      await pg.query(`DELETE FROM public.${table}`);
    }

    for (const table of TABLES_ORDER) {
      const rows = sqliteReadAll(table);
      if (!rows.length) continue;

      const cols = sqliteColumns(table);
      const colsSql = cols.map((c) => `"${c}"`).join(", ");
      const insertSql = `INSERT INTO public.${table} (${colsSql}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(", ")})`;

      for (const row of rows) {
        const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
        await pg.query(insertSql, values);
      }
    }

    for (const table of TABLES_ORDER) {
      await pg.query(
        `SELECT setval(pg_get_serial_sequence('public.${table}', 'id'),
         COALESCE((SELECT MAX(id) FROM public.${table}), 1), true)`
      );
    }
  } finally {
    await pg.end();
  }
}

async function pullSupabaseToSqlite() {
  initDb();
  const pg = await pgClientFromEnv();
  try {
    await ensureSchemaExists(pg);

    db.exec("PRAGMA foreign_keys = OFF;");
    for (const table of TABLES_REVERSE) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    for (const table of TABLES_ORDER) {
      const result = await pg.query(`SELECT * FROM public.${table} ORDER BY id ASC`);
      if (!result.rows.length) continue;

      const cols = sqliteColumns(table);
      const validCols = cols.filter((c) => Object.prototype.hasOwnProperty.call(result.rows[0], c));
      const insert = db.prepare(
        `INSERT INTO ${table} (${validCols.join(", ")}) VALUES (${validCols.map(() => "?").join(", ")})`
      );

      const tx = db.transaction((rows) => {
        for (const row of rows) {
          insert.run(...validCols.map((c) => normalizeForSqlite(row[c])));
        }
      });
      tx(result.rows);
    }
    db.exec("PRAGMA foreign_keys = ON;");
  } finally {
    await pg.end();
  }
}

module.exports = {
  pushSqliteToSupabase,
  pullSupabaseToSqlite,
};
